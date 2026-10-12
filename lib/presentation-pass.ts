import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Resolve edges, recover local detail and apply speed blur in the existing output draw. */
class DrivingPresentationPass extends OutputPass {
  constructor() {
    super();
    this.material.name = 'City / edge and detail resolve, speed blur, filmic output';
    this.uniforms.sourceTexel = { value: new THREE.Vector2(1, 1) };
    this.uniforms.strength = { value: 0 };
    this.uniforms.sharpness = { value: .12 };
    this.uniforms.resolveStrength = { value: 1 };
    this.uniforms.tBloom = { value: null };
    this.uniforms.bloomEnabled = { value: 0 };
    const resolve = /* glsl */ `
      uniform vec2 sourceTexel;
      uniform float strength;
      uniform float sharpness;
      uniform float resolveStrength;
      uniform sampler2D tBloom;
      uniform float bloomEnabled;

      // Compressed luminance gives the HDR scene a bounded edge threshold.
      float imageLuma(vec3 c) {
        float l = max(0., dot(c, vec3(.2126, .7152, .0722)) * toneMappingExposure);
        return l / (1. + l);
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
          float threshold = max(.035, high * .18);
          vec3 minimum = min(center, min(min(north, south), min(east, west)));
          vec3 maximum = max(center, max(max(north, south), max(east, west)));
          if (contrast > threshold) {
            // Average along the edge; crossing it would smear small signs and lights.
            vec2 tangent = vec2(-(n - s), e - w);
            float magnitude = max(abs(tangent.x), abs(tangent.y));
            if (magnitude > .001) {
              vec2 offset = tangent / magnitude * sourceTexel * .5;
              vec3 along = (texture2D(tDiffuse, uv + offset).rgb
                + texture2D(tDiffuse, uv - offset).rgb) * .5;
              color = mix(center, along, .55 * resolveStrength);
            }
          } else {
            // Clamping to local extrema prevents bright or dark sharpening halos.
            vec3 average = (north + south + east + west) * .25;
            color = clamp(center + (center - average) * sharpness * resolveStrength, minimum, maximum);
          }
        }
        if (strength > .0006) {
          vec2 p = uv - vec2(.5, .48);
          vec2 offset = p * strength * smoothstep(.23, .7, length(p));
          color = color * .5 + texture2D(tDiffuse, uv - offset).rgb * .3
            + texture2D(tDiffuse, uv - offset * 2.).rgb * .2;
        }
        if (bloomEnabled > .5) color += texture2D(tBloom, uv).rgb;
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
    this.uniforms.sharpness.value = [.12, .14, .16, .18, .20][Math.max(0, Math.min(4, level))];
  }
}

export function makePresentationPass() {
  return new DrivingPresentationPass();
}
