import * as THREE from 'three';
import { CITY_EDGE, ROAD_WIDTH, roadDistance } from './city-layout';
import type { CoveredRoad } from './city-infrastructure';

const CAPACITY = 768;
const DROPLETS = 3;
const SURFACE_Y = .052;

/** A fixed pool of world-space rain impacts: one ripple draw and one spray draw. */
export function addRoadRain(scene: THREE.Scene, shelters: readonly CoveredRoad[]) {
  const impacts = new Float32Array(CAPACITY * 4);
  const seeds = new Float32Array(CAPACITY);
  const sprayImpacts = new Float32Array(CAPACITY * DROPLETS * 4);
  const spraySeeds = new Float32Array(CAPACITY * DROPLETS);
  for (let i = 0; i < CAPACITY; i++) {
    impacts[i * 4 + 2] = -100;
    seeds[i] = Math.random();
    for (let j = 0; j < DROPLETS; j++) {
      sprayImpacts[(i * DROPLETS + j) * 4 + 2] = -100;
      spraySeeds[i * DROPLETS + j] = (j + seeds[i]) / DROPLETS;
    }
  }

  const impactAttribute = new THREE.InstancedBufferAttribute(impacts, 4).setUsage(THREE.DynamicDrawUsage);
  const plane = new THREE.PlaneGeometry(2, 2);
  const rings = new THREE.InstancedBufferGeometry();
  rings.index = plane.index;
  rings.attributes.position = plane.attributes.position;
  rings.attributes.uv = plane.attributes.uv;
  rings.setAttribute('impact', impactAttribute);
  rings.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 1));
  rings.instanceCount = CAPACITY;
  // The attributes above are shared; the temporary geometry owns no GPU resources yet.
  plane.dispose();

  const uniforms = {
    time: { value: 0 },
    resolution: { value: 900 },
    carPosition: { value: new THREE.Vector3() },
    carForward: { value: new THREE.Vector2(0, -1) },
  };
  const lighting = /* glsl */ `
    uniform vec3 carPosition;
    uniform vec2 carForward;
    vec3 rainLight(vec2 world) {
      vec2 offset = world - carPosition.xz;
      float distanceToCar = length(offset);
      float headlights = smoothstep(.86, .98, dot(offset / max(distanceToCar, .01), carForward));
      headlights *= (1. - smoothstep(5., 23., distanceToCar)) * smoothstep(1.7, 3., distanceToCar);
      float neon = .5 + .5 * sin(world.x * .13 + world.y * .08);
      return mix(vec3(.20, .32, .39), vec3(.36, .25, .38), neon) + vec3(.30, .32, .30) * headlights;
    }
  `;
  const rippleMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    vertexShader: /* glsl */ `
      attribute vec4 impact;
      attribute float seed;
      uniform float time;
      varying vec2 local;
      varying vec3 world;
      varying float age;
      varying float variation;
      void main() {
        age = (time - impact.z) / (.62 + seed * .4);
        variation = seed;
        local = position.xy;
        world = vec3(impact.x + position.x * impact.w, ${SURFACE_Y}, impact.y - position.y * impact.w);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
        if (age < 0. || age > 1.) gl_Position = vec4(2., 2., 2., 1.);
      }
    `,
    fragmentShader: /* glsl */ `
      ${lighting}
      varying vec2 local;
      varying vec3 world;
      varying float age;
      varying float variation;
      float ring(float radius, float crest, float width) {
        return 1. - smoothstep(width, width + max(fwidth(radius), .012), abs(radius - crest));
      }
      void main() {
        float radius = length(local);
        float crest = .06 + age * .88;
        float angle = atan(local.y, local.x);
        // Fine overlapping waves and a short-lived scalloped crown at the point of impact.
        float distortion = sin(angle * 7. + variation * 30.) * .007 * age;
        float waveRadius = radius + distortion;
        float facets = .24 + .76 * pow(.5 + .5 * sin(angle * 5. + variation * 30. + radius * 8.), 2.);
        float wave = ring(waveRadius, crest, .009);
        wave += ring(waveRadius, crest * .69, .008) * .45 * smoothstep(.08, .24, age);
        wave += ring(waveRadius, crest * .42, .006) * .18 * smoothstep(.18, .4, age);
        float crown = ring(radius, .08 + age * .7, .024) * pow(.5 + .5 * cos(angle * 9. + variation * 17.), 4.);
        crown *= 1. - smoothstep(.04, .22, age);
        float darkEdge = ring(waveRadius, crest + .032, .014) * .22;
        float distanceFade = 1. - smoothstep(18., 38., distance(cameraPosition, world));
        float life = smoothstep(0., .06, age) * pow(1. - age, 1.8);
        float alpha = (wave * facets * .62 + crown * .8 + darkEdge) * life * distanceFade;
        if (alpha < .004 || radius > 1.) discard;
        vec3 color = rainLight(world.xz) * (1. - darkEdge * 2.7);
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const rippleMesh = new THREE.Mesh(rings, rippleMaterial);
  rippleMesh.name = 'Road rain / expanding water ripples';
  rippleMesh.frustumCulled = false;
  scene.add(rippleMesh);

  const sprayAttribute = new THREE.BufferAttribute(sprayImpacts, 4).setUsage(THREE.DynamicDrawUsage);
  const sprayGeometry = new THREE.BufferGeometry();
  sprayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * DROPLETS * 3), 3));
  sprayGeometry.setAttribute('impact', sprayAttribute);
  sprayGeometry.setAttribute('seed', new THREE.BufferAttribute(spraySeeds, 1));
  const sprayMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      ${lighting}
      attribute vec4 impact;
      attribute float seed;
      uniform float time;
      uniform float resolution;
      varying float opacity;
      varying vec3 tint;
      void main() {
        float age = (time - impact.z) / (.19 + seed * .1);
        float life = clamp(age, 0., 1.);
        float angle = seed * 37.;
        vec3 world = vec3(impact.x, ${SURFACE_Y}, impact.y);
        world.xz += vec2(cos(angle), sin(angle)) * life * impact.w * .55;
        world.y += 4. * life * (1. - life) * (.07 + seed * .14);
        vec4 view = viewMatrix * vec4(world, 1.);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp(resolution * (.020 + seed * .015) / max(1., -view.z), 1., 5.);
        opacity = (1. - life) * .62 * (1. - smoothstep(13., 30., distance(cameraPosition, world)));
        if (age < 0. || age > 1.) { opacity = 0.; gl_Position = vec4(2., 2., 2., 1.); }
        tint = rainLight(world.xz) * 1.15;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float opacity;
      varying vec3 tint;
      void main() {
        vec2 droplet = (gl_PointCoord - .5) * vec2(1.15, .8);
        float radius = length(droplet);
        float shape = 1. - smoothstep(.10, .48, radius);
        float highlight = exp(-dot(droplet + vec2(.07, -.09), droplet + vec2(.07, -.09)) * 55.);
        if (shape * opacity < .005) discard;
        gl_FragColor = vec4(tint * (.65 + highlight * .7), shape * opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const spray = new THREE.Points(sprayGeometry, sprayMaterial);
  spray.name = 'Road rain / tiny impact splashes';
  spray.frustumCulled = false;
  scene.add(spray);

  let cursor = 0;
  let emission = 0;
  let dirty = false;

  function impact(x: number, z: number, time: number) {
    // Restrict impacts to the playable street grid, excluding sidewalks and roofs.
    const laneX = roadDistance(x);
    const laneZ = roadDistance(z);
    if (Math.abs(x) > CITY_EDGE || Math.abs(z) > CITY_EDGE || Math.min(laneX, laneZ) > ROAD_WIDTH / 2 - .35) return;
    if (shelters.some(roof => Math.abs(x - roof.x) < roof.hx && Math.abs(z - roof.z) < roof.hz)) return;
    const offset = cursor * 4;
    const radius = .18 + seeds[cursor] * .22;
    impacts[offset] = x;
    impacts[offset + 1] = z;
    impacts[offset + 2] = time;
    impacts[offset + 3] = radius;
    for (let j = 0; j < DROPLETS; j++) {
      const start = (cursor * DROPLETS + j) * 4;
      sprayImpacts[start] = x;
      sprayImpacts[start + 1] = z;
      sprayImpacts[start + 2] = time;
      sprayImpacts[start + 3] = radius;
    }
    cursor = (cursor + 1) % CAPACITY;
    dirty = true;
  }

  return {
    impact,
    update(delta: number, time: number, position: THREE.Vector3, yaw: number, height: number) {
      uniforms.time.value = time;
      uniforms.resolution.value = height;
      uniforms.carPosition.value.copy(position);
      uniforms.carForward.value.set(-Math.sin(yaw), -Math.cos(yaw));
      // Finer raindrops are too small to draw in the air but still disturb the road.
      // Concentrate these near the player; existing visible streaks also call impact().
      emission += Math.min(delta, .04) * 460;
      while (emission >= 1) {
        emission--;
        const angle = Math.random() * Math.PI * 2;
        const radius = 2 + Math.random() * 26;
        impact(position.x + Math.cos(angle) * radius, position.z + Math.sin(angle) * radius, time - Math.random() * delta);
      }
      if (dirty) {
        impactAttribute.needsUpdate = true;
        sprayAttribute.needsUpdate = true;
        dirty = false;
      }
    },
  };
}
