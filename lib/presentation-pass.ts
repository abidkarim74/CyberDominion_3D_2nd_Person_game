import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { GraphicsQuality } from './graphics-quality';

/** Resolve edges, recover local detail and apply speed blur in the existing output draw. */
class DrivingPresentationPass extends OutputPass {
  constructor() {
    super();
    this.material.name = 'City / edge and detail resolve, speed blur, filmic output';
    this.uniforms.sourceTexel = { value: new THREE.Vector2(1, 1) };
    this.uniforms.strength = { value: 0 };
    this.uniforms.sharpness = { value: .12 };
    this.uniforms.resolveStrength = { value: 1 };
    this.uniforms.resolveQuality = { value: 1 };
    this.uniforms.detailContrast = { value: 0 };
    this.uniforms.lensFalloff = { value: 0 };
    this.uniforms.tBloom = { value: null };
    this.uniforms.bloomEnabled = { value: 0 };
    const resolve = /* glsl */ `
      uniform vec2 sourceTexel;
      uniform float strength;
      uniform float sharpness;
      uniform float resolveStrength;
      uniform float resolveQuality;
      uniform float detailContrast;
      uniform float lensFalloff;
      uniform sampler2D tBloom;
      uniform float bloomEnabled;

      // Compressed luminance gives the HDR scene a bounded edge threshold.
      float imageLuma(vec3 c) {
        float l = max(0., dot(c, vec3(.2126, .7152, .0722)) * toneMappingExposure);
        return l / (1. + l);
      }

      // Find the ends of an edge before moving a fraction of a pixel across it.
      // Only high-contrast pixels pay for the diagonal taps and edge search.
      vec3 resolveEdge(vec2 uv, vec3 center, float c, float n, float s,
        float e, float w, float contrast) {
        float ne = imageLuma(texture2D(tDiffuse, uv + sourceTexel).rgb);
        float nw = imageLuma(texture2D(tDiffuse, uv + sourceTexel * vec2(-1., 1.)).rgb);
        float se = imageLuma(texture2D(tDiffuse, uv + sourceTexel * vec2(1., -1.)).rgb);
        float sw = imageLuma(texture2D(tDiffuse, uv - sourceTexel).rgb);
        float horizontal = abs(n + s - 2. * c) * 2.
          + abs(ne + se - 2. * e) + abs(nw + sw - 2. * w);
        float vertical = abs(e + w - 2. * c) * 2.
          + abs(ne + nw - 2. * n) + abs(se + sw - 2. * s);
        bool edgeHorizontal = horizontal >= vertical;
        float first = edgeHorizontal ? n : e;
        float second = edgeHorizontal ? s : w;
        float firstGradient = abs(first - c);
        float secondGradient = abs(second - c);
        bool towardsFirst = firstGradient >= secondGradient;
        float gradient = max(firstGradient, secondGradient);
        float edgeMean = .5 * (c + (towardsFirst ? first : second));
        vec2 across = edgeHorizontal ? vec2(0., sourceTexel.y) : vec2(sourceTexel.x, 0.);
        if (!towardsFirst) across = -across;
        vec2 along = edgeHorizontal ? vec2(sourceTexel.x, 0.) : vec2(0., sourceTexel.y);
        vec2 edgeUv = uv + across * .5;
        vec2 start = edgeUv - along;
        vec2 end = edgeUv + along;
        float startLuma = imageLuma(texture2D(tDiffuse, start).rgb) - edgeMean;
        float endLuma = imageLuma(texture2D(tDiffuse, end).rgb) - edgeMean;
        float stopThreshold = max(.001, gradient * .25);
        bool startDone = abs(startLuma) >= stopThreshold;
        bool endDone = abs(endLuma) >= stopThreshold;
        // Ultra follows longer silhouettes; High uses two short search steps.
        for (int i = 0; i < 5; i++) {
          if (resolveQuality < 2.5 && i >= 2) break;
          if (startDone && endDone) break;
          float stepSize = i < 1 ? 1. : (i < 2 ? 1.5 : (i < 3 ? 2. : (i < 4 ? 4. : 8.)));
          if (!startDone) {
            start -= along * stepSize;
            startLuma = imageLuma(texture2D(tDiffuse, start).rgb) - edgeMean;
            startDone = abs(startLuma) >= stopThreshold;
          }
          if (!endDone) {
            end += along * stepSize;
            endLuma = imageLuma(texture2D(tDiffuse, end).rgb) - edgeMean;
            endDone = abs(endLuma) >= stopThreshold;
          }
        }
        // An unbounded straight edge needs no endpoint correction.
        if (!startDone) start -= along * 8.;
        if (!endDone) end += along * 8.;
        float startDistance = edgeHorizontal ? abs(uv.x - start.x) : abs(uv.y - start.y);
        float endDistance = edgeHorizontal ? abs(end.x - uv.x) : abs(end.y - uv.y);
        bool startNearest = startDistance <= endDistance;
        float endpoint = startNearest ? startLuma : endLuma;
        float edgeOffset = .5 - min(startDistance, endDistance) / max(startDistance + endDistance, .00001);
        if ((endpoint < 0.) == (c - edgeMean < 0.)) edgeOffset = 0.;
        float neighborhood = ((n + s + e + w) * 2. + ne + nw + se + sw) / 12.;
        float subpixel = clamp(abs(neighborhood - c) / max(contrast, .001), 0., 1.);
        subpixel = subpixel * subpixel * (3. - 2. * subpixel);
        subpixel = subpixel * subpixel * .65;
        float offset = min(.45, max(edgeOffset, subpixel));
        return mix(center, texture2D(tDiffuse, uv + across * offset).rgb, resolveStrength);
      }
      vec3 presentImage(vec2 uv) {
        vec3 center = texture2D(tDiffuse, uv).rgb;
        vec3 color = center;
        if (resolveStrength > .0) {
          vec3 north = texture2D(tDiffuse, uv + vec2(0., sourceTexel.y)).rgb;
          vec3 south = texture2D(tDiffuse, uv - vec2(0., sourceTexel.y)).rgb;
          vec3 east = texture2D(tDiffuse, uv + vec2(sourceTexel.x, 0.)).rgb;
          vec3 west = texture2D(tDiffuse, uv - vec2(sourceTexel.x, 0.)).rgb;
          float n = imageLuma(north), s = imageLuma(south);
          float e = imageLuma(east), w = imageLuma(west), c = imageLuma(center);
          float high = max(c, max(max(n, s), max(e, w)));
          float low = min(c, min(min(n, s), min(e, w)));
          float contrast = high - low;
          float threshold = max(.035, high * (resolveQuality > 1.5 ? .12 : .18));
          vec3 minimum = min(center, min(min(north, south), min(east, west)));
          vec3 maximum = max(center, max(max(north, south), max(east, west)));
          if (contrast > threshold) {
            if (resolveQuality > 1.5) {
              color = resolveEdge(uv, center, c, n, s, e, w, contrast);
            } else {
              // The inexpensive resolve used by Low and Medium follows the tangent.
              vec2 tangent = vec2(-(n - s), e - w);
              float magnitude = max(abs(tangent.x), abs(tangent.y));
              if (magnitude > .001) {
                vec2 offset = tangent / magnitude * sourceTexel * .5;
                vec3 along = (texture2D(tDiffuse, uv + offset).rgb
                  + texture2D(tDiffuse, uv - offset).rgb) * .5;
                color = mix(center, along, .55 * resolveStrength);
              }
            }
          } else {
            // Clamping to local extrema prevents bright or dark sharpening halos.
            vec3 average = (north + south + east + west) * .25;
            float midtoneDetail = detailContrast * (1. - abs(c * 2. - 1.));
            color = clamp(center + (center - average) * (sharpness + midtoneDetail) * resolveStrength, minimum, maximum);
          }
        }
        if (strength > .0006) {
          vec2 p = uv - vec2(.5, .48);
          vec2 offset = p * strength * smoothstep(.23, .7, length(p));
          color = color * .5 + texture2D(tDiffuse, uv - offset).rgb * .3
            + texture2D(tDiffuse, uv - offset * 2.).rgb * .2;
        }
        if (bloomEnabled > .5) color += texture2D(tBloom, uv).rgb;
        // A restrained lens falloff leaves signs and the central driving view crisp.
        vec2 lens = uv - .5;
        color *= 1. - lensFalloff * smoothstep(.08, .48, dot(lens, lens));
        return color;
      }
    `;
    // OutputPass still owns exposure, tone mapping and display color conversion.
    this.material.fragmentShader = this.material.fragmentShader
      .replace('void main() {', `${resolve}\nvoid main() {`)
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );', 'gl_FragColor = vec4(presentImage(vUv), 1.);');
  }

  override setSize(width: number, height: number) {
    this.uniforms.sourceTexel.value.set(1 / Math.max(1, Math.floor(width)), 1 / Math.max(1, Math.floor(height)));
  }

  setQuality(level: number) {
    const index = Number.isFinite(level) ? Math.round(THREE.MathUtils.clamp(level, 0, 4)) : 0;
    this.uniforms.sharpness.value = [.12, .14, .16, .18, .20][index];
  }

  setPreset(preset: GraphicsQuality, pressure = 0) {
    const load = Number.isFinite(pressure) ? THREE.MathUtils.clamp(pressure, 0, 4) : 0;
    const profiles = {
      low: { resolve: .6, quality: 0, sharpness: .08, contrast: 0, falloff: 0 },
      medium: { resolve: .82, quality: 1, sharpness: .12, contrast: .02, falloff: 0 },
      high: { resolve: .92, quality: 2, sharpness: .14, contrast: .035, falloff: 0 },
      ultra: { resolve: 1, quality: 3, sharpness: .16, contrast: .055, falloff: .035 },
    } satisfies Record<GraphicsQuality, { resolve: number; quality: number; sharpness: number; contrast: number; falloff: number }>;
    const profile = profiles[preset];
    this.uniforms.resolveStrength.value = profile.resolve;
    this.uniforms.resolveQuality.value = profile.quality === 3 && load >= 2 ? 2 : profile.quality;
    this.uniforms.sharpness.value = profile.sharpness * (1 - load * .06);
    this.uniforms.detailContrast.value = profile.contrast * (1 - load * .08);
    this.uniforms.lensFalloff.value = profile.falloff;
  }
}

export function makePresentationPass() {
  return new DrivingPresentationPass();
}
