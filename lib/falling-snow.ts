import * as THREE from 'three';
import type { CoveredRoad } from './city-infrastructure';

export const SNOW_COUNT = 3200;
const WIDTH = 80;
const DEPTH = 96;
const HEIGHT = 28;

/** A fixed, GPU-animated flake field. Only uniforms change during gameplay. */
export function addFallingSnow(scene: THREE.Scene, shelters: readonly CoveredRoad[]) {
  const positions = new Float32Array(SNOW_COUNT * 3);
  const variations = new Float32Array(SNOW_COUNT);
  let state = 6500;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = 0; i < SNOW_COUNT; i++) {
    positions[i * 3] = (random() - .5) * WIDTH;
    positions[i * 3 + 1] = random() * HEIGHT;
    positions[i * 3 + 2] = (random() - .5) * DEPTH;
    variations[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('variation', new THREE.BufferAttribute(variations, 1));
  const shelterCount = Math.max(1, shelters.length);
  const uniforms = {
    time: { value: 0 }, resolution: { value: 900 },
    carPosition: { value: new THREE.Vector3() }, carForward: { value: new THREE.Vector2(0, -1) },
    shelters: { value: shelters.length ? shelters.map(r => new THREE.Vector4(r.x, r.z, r.hx, r.hz)) : [new THREE.Vector4(1e6, 1e6, 0, 0)] },
    ceilings: { value: shelters.length ? shelters.map(r => r.ceiling) : [0] },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: true,
    vertexShader: /* glsl */ `
      attribute float variation;
      uniform float time;
      uniform float resolution;
      uniform vec3 carPosition;
      uniform vec2 carForward;
      uniform vec4 shelters[${shelterCount}];
      uniform float ceilings[${shelterCount}];
      varying float opacity;
      varying float seed;
      varying float rotation;
      varying vec3 tint;
      #include <fog_pars_vertex>
      void main() {
        seed = variation;
        vec3 world = position;
        float phase = variation * 62.83;
        world.y = .055 + mod(position.y - time * (.65 + variation * 1.05), ${HEIGHT}.);
        world.x += time * .34 + sin(time * (.42 + variation * .3) + phase) * (.3 + variation * .65);
        world.z += time * .12 + cos(time * .36 + phase) * .55;
        // Wrapping only at the distant boundary prevents flakes following the moving car.
        world.x += floor((carPosition.x - world.x + ${WIDTH / 2}.) / ${WIDTH}.) * ${WIDTH}.;
        world.z += floor((carPosition.z - world.z + ${DEPTH / 2}.) / ${DEPTH}.) * ${DEPTH}.;
        vec4 mvPosition = viewMatrix * vec4(world, 1.);
        gl_Position = projectionMatrix * mvPosition;
        float size = .035 + pow(variation, 2.) * .085;
        gl_PointSize = clamp(resolution * size / max(.6, -mvPosition.z), .85, 9.);
        vec2 offset = world.xz - carPosition.xz;
        float distanceToCar = length(offset);
        float light = smoothstep(.82, .98, dot(offset / max(distanceToCar, .01), carForward));
        light *= (1. - smoothstep(7., 28., distanceToCar)) * (1. - smoothstep(3., 8., world.y));
        tint = mix(vec3(.54, .64, .76), vec3(.82, .88, .94), variation) + vec3(.24, .22, .18) * light;
        opacity = (.52 + variation * .38) * (1. - smoothstep(35., 65., distanceToCar));
        opacity *= smoothstep(.55, 1.7, -mvPosition.z) * smoothstep(.055, .22, world.y);
        opacity *= .83 + .17 * sin(time * 1.8 + phase);
        rotation = phase + time * (.4 + variation * .7);
        for (int i = 0; i < ${shelterCount}; i++) {
          vec2 roofOffset = abs(world.xz - shelters[i].xy);
          if (roofOffset.x < shelters[i].z && roofOffset.y < shelters[i].w && world.y < ceilings[i] + size) opacity = 0.;
        }
        if (opacity < .005) gl_Position = vec4(2., 2., 2., 1.);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying float opacity;
      varying float seed;
      varying float rotation;
      varying vec3 tint;
      #include <fog_pars_fragment>
      void main() {
        vec2 p = gl_PointCoord - .5;
        float c = cos(rotation), s = sin(rotation);
        p = mat2(c, -s, s, c) * p;
        p.x *= 1. + seed * .35;
        float radius = length(p);
        float lobes = 1. + .065 * cos(atan(p.y, p.x) * 5. + seed * 13.);
        float shape = (1. - smoothstep(.12, .48, radius * lobes)) * (.8 + .2 * exp(-dot(p, p) * 28.));
        float alpha = shape * opacity;
        if (alpha < .015) discard;
        gl_FragColor = vec4(tint, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  Object.assign(uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.fog));
  const flakes = new THREE.Points(geometry, material);
  flakes.name = 'Snow / drifting flakes';
  flakes.renderOrder = 4;
  flakes.frustumCulled = false;
  scene.add(flakes);
  return {
    flakes,
    update(time: number, position: THREE.Vector3, yaw: number, height: number) {
      uniforms.time.value = time;
      uniforms.carPosition.value.copy(position);
      uniforms.carForward.value.set(-Math.sin(yaw), -Math.cos(yaw));
      uniforms.resolution.value = height;
    },
  };
}
