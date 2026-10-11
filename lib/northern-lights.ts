import * as THREE from 'three';

/** A small, seamless field uploaded once. Red holds coherent rays; green holds soft folds. */
export function makeNorthernLights() {
  let seed = 7391;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const width = 256, height = 128;
  const rays = Float32Array.from({ length: width }, random);
  const lattice = Float32Array.from({ length: width * 16 }, random);
  const sample = (x: number, y: number, columns: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (dx: number, dy: number) => lattice[((iy + dy) % 16) * width + (ix + dx) % columns];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(at(0, 0), at(1, 0), sx),
      THREE.MathUtils.lerp(at(0, 1), at(1, 1), sx), sy,
    );
  };
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = Math.round((rays[x] * .65 + sample(x, y / 8, width) * .35) * 255);
    pixels[i + 1] = Math.round(sample(x / 8, y / 8, 32) * 255);
    pixels[i + 2] = 0;
    pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.name = 'Aurora / immutable periodic ray and fold field';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return {
    texture,
    uniforms: {
      auroraTime: { value: 0 },
      auroraStrength: { value: 1 },
      auroraDetail: { value: 1 },
      auroraField: { value: texture },
    },
    update(time: number) {
      this.uniforms.auroraTime.value = time;
    },
    setQuality(level: number) {
      // Retain flowing curtains at every tier; omit the distant third veil and fine rays on slow devices.
      this.uniforms.auroraDetail.value = level < 2 ? 1 : 0;
    },
    dispose() { texture.dispose(); },
  };
}

/** Bounded texture samples in the existing sky/water draws, without raymarching or extra passes. */
export const northernLightsShader = /* glsl */ `
  uniform sampler2D auroraField;
  uniform float auroraTime;
  uniform float auroraStrength;
  uniform float auroraDetail;

  vec3 northernLights(vec3 direction, float detail) {
    float elevation = direction.y;
    if (auroraStrength <= 0. || elevation < .025 || elevation > .94) return vec3(0.);
    // Periodic angular coordinates keep the curtains continuous when the camera turns through north.
    float longitude = atan(direction.x, -direction.z) / 6.2831853;
    float t = auroraTime;
    vec3 light = vec3(0.);
    for (int layer = 0; layer < 3; layer++) {
      if (layer == 2 && detail < .5) break;
      float id = float(layer);
      float u = longitude + id * .173 + t * (.0018 + id * .0007);
      float angle = u * 6.2831853;
      float fold = sin(angle * 3. + sin(angle * 2. - t * .045 + id) * 1.15 + t * .075 + id * 2.);
      float curl = sin(angle * 7. - t * .11 + id * 1.7) * .022;
      float base = .115 + id * .125 + fold * (.070 + id * .016) + curl;
      vec2 fieldUv = vec2(u * 3. + fold * .032, t * .008 + id * .27);
      float cloud = texture2D(auroraField, fieldUv).g;
      float height = .17 + cloud * .27 + .035 * sin(angle * 5. + t * .06);
      float above = elevation - base;
      float rise = max(above, 0.);
      float envelope = smoothstep(-.028, .016, above) * exp(-rise / height * 3.1);
      envelope *= 1. - smoothstep(height * .65, height * 1.6, rise);
      float arc = exp(-pow(above / .019, 2.)) * .20;
      // Rays shear slightly with altitude. Mipmaps filter narrow fibres instead of shimmering.
      float shear = fold * (.026 + rise * .09) + sin(rise * 12. - angle * 3. + t * .035) * rise * .06;
      float rays = texture2D(auroraField, vec2(u * 4. + shear, rise * .7 - t * .006 + id * .31)).r;
      float fibres = .38 + rays * rays * 1.35;
      if (detail > .5) {
        float fine = texture2D(auroraField, vec2(u * 9. + shear * 2.25, rise * .5 - t * .004)).r;
        fibres *= .72 + fine * .65;
      }
      float activity = .60 + .40 * sin(angle * 2. - t * .09 + id * 2.4);
      activity *= smoothstep(.12, .63, cloud) * (.82 + .18 * sin(t * .16 + angle * 4. + id));
      float upper = smoothstep(.045, height * .95, rise);
      vec3 green = mix(vec3(.15, .90, .24), vec3(.025, .31, .24), upper);
      green += vec3(.16, .24, .12) * exp(-abs(above) * 42.) * smoothstep(.6, .92, rays);
      vec3 violet = vec3(.29, .065, .38) * smoothstep(.07, .21, rise) * (1. - upper * .45);
      light += (green + violet) * (envelope * fibres + arc) * activity * (.70 - id * .16);
    }
    return light * smoothstep(.025, .085, elevation) * (1. - smoothstep(.68, .94, elevation)) * auroraStrength;
  }
`;
