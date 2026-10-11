import * as THREE from 'three';

/** Tapered, camera-facing drops share one instanced draw and the existing position pool. */
export function createRainStreaks(positions: Float32Array) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.attributes.position = plane.attributes.position;
  geometry.attributes.uv = plane.attributes.uv;
  geometry.instanceCount = positions.length / 6;
  plane.dispose();
  const endpoints = new THREE.InstancedInterleavedBuffer(positions, 6).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('dropHead', new THREE.InterleavedBufferAttribute(endpoints, 3, 0));
  geometry.setAttribute('dropTip', new THREE.InterleavedBufferAttribute(endpoints, 3, 3));
  const variations = new Float32Array(geometry.instanceCount);
  for (let i = 0; i < variations.length; i++) variations[i] = ((i * 73) % 997) / 997;
  geometry.setAttribute('variation', new THREE.InstancedBufferAttribute(variations, 1));
  const uniforms = {
    resolution: { value: new THREE.Vector2(1200, 800) },
    carPosition: { value: new THREE.Vector3() },
    carForward: { value: new THREE.Vector2(0, -1) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 dropHead;
      attribute vec3 dropTip;
      attribute float variation;
      uniform vec2 resolution;
      uniform vec3 carPosition;
      uniform vec2 carForward;
      varying vec2 local;
      varying float opacity;
      varying float headlight;
      varying float seed;
      void main() {
        local = uv;
        seed = variation;
        vec3 world = mix(dropTip, dropHead, uv.y);
        vec4 head = projectionMatrix * viewMatrix * vec4(dropHead, 1.);
        vec4 tip = projectionMatrix * viewMatrix * vec4(dropTip, 1.);
        vec4 view = viewMatrix * vec4(world, 1.);
        vec4 clip = projectionMatrix * view;
        vec2 screenDirection = (head.xy / max(head.w, .1) - tip.xy / max(tip.w, .1)) * resolution;
        vec2 side = vec2(screenDirection.y, -screenDirection.x) / max(length(screenDirection), .001);
        float width = clamp(resolution.y * (.006 + variation * .008) / max(1., -view.z), .6, 1.8);
        clip.xy += side * position.x * width * 2. / resolution * clip.w;
        gl_Position = clip;
        vec2 offset = world.xz - carPosition.xz;
        float distanceToCar = length(offset);
        float cone = smoothstep(.84, .98, dot(offset / max(distanceToCar, .01), carForward));
        headlight = cone * (1. - smoothstep(7., 25., distanceToCar)) * (1. - smoothstep(3., 8., world.y));
        opacity = (.18 + variation * .16 + headlight * .16) * (1. - smoothstep(38., 82., distanceToCar));
        opacity *= smoothstep(.8, 2.2, -view.z);
        if (dropHead.y < 0.) { opacity = 0.; gl_Position = vec4(2., 2., 2., 1.); }
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 local;
      varying float opacity;
      varying float headlight;
      varying float seed;
      void main() {
        float across = abs(local.x - .5) * 2.;
        float taper = mix(.92, .22, smoothstep(.02, .95, local.y));
        float edge = 1. - smoothstep(taper * .35, taper, across);
        float ends = smoothstep(0., .035, local.y) * (1. - smoothstep(.72, 1., local.y));
        float bead = exp(-pow((local.y - .085) * 14., 2.)) * (1. - smoothstep(.15, .7, across));
        float alpha = (edge * ends * (.34 + .5 * (1. - local.y)) + bead * .3) * opacity;
        if (alpha < .008) discard;
        vec3 color = mix(vec3(.36, .47, .58), vec3(.62, .73, .80), seed) + vec3(.18, .17, .14) * headlight;
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Rain / tapered falling droplets';
  mesh.frustumCulled = false;
  return {
    mesh, geometry,
    update(position: THREE.Vector3, yaw: number, width: number, height: number) {
      endpoints.needsUpdate = true;
      uniforms.carPosition.value.copy(position);
      uniforms.carForward.value.set(-Math.sin(yaw), -Math.cos(yaw));
      uniforms.resolution.value.set(width, height);
    },
  };
}
