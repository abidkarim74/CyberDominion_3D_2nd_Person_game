import * as THREE from 'three';
import type { SnowContact } from './snow-surface';
import { isAsphaltContact } from './tire-feedback';

const CAPACITY = 4096, HALF_WIDTH = .14, LIFETIME = 120;

/** One fixed geometry pool for world-space rubber ribbons from all four tires. */
export function addRoadSkidMarks(scene: THREE.Scene) {
  const positions = new Float32Array(CAPACITY * 12);
  const uv = new Float32Array(CAPACITY * 8);
  const marks = new Float32Array(CAPACITY * 8);
  const indices = new Uint16Array(CAPACITY * 6);
  for (let i = 0; i < CAPACITY; i++) {
    const v = i * 4;
    indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
  }
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const uvAttribute = new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage);
  const markAttribute = new THREE.BufferAttribute(marks, 2).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('uv', uvAttribute);
  geometry.setAttribute('mark', markAttribute);
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: `attribute vec2 mark; uniform float time;
      varying vec2 local; varying vec2 detail;
      #include <fog_pars_vertex>
      void main() {
        local = uv; detail = mark;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.);
        gl_Position = projectionMatrix * mvPosition;
        if (time - mark.x > ${LIFETIME}.) gl_Position = vec4(2.,2.,2.,1.);
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float time; varying vec2 local; varying vec2 detail;
      #include <fog_pars_fragment>
      void main() {
        float edge = 1. - smoothstep(.72, 1., abs(local.x - .5) * 2.);
        float grooves = smoothstep(.04,.07,abs(local.x-.28)) * smoothstep(.04,.07,abs(local.x-.72));
        float grain = .9 + .1 * sin(local.y * 96. + local.x * 37.);
        float fade = 1. - smoothstep(80.,${LIFETIME}.,time-detail.x);
        float alpha = edge * detail.y * mix(.58,.94,grooves) * grain * fade;
        if (alpha < .01) discard;
        gl_FragColor = vec4(vec3(.006,.008,.011), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Road / tire skid marks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.excludeFromReflection = true;
  scene.add(mesh);
  const last = Array.from({ length: 4 }, () => ({ x: 0, z: 0, sideX: 0, sideZ: 0, distance: 0, valid: false }));
  let cursor = 0, used = 0, emitted = 0;

  return {
    mesh,
    updateTime(time: number) { material.uniforms.time.value = time; },
    update(time: number, contacts: readonly SnowContact[], strengths: readonly number[]) {
      material.uniforms.time.value = time;
      let dirty = false;
      for (let wheel = 0; wheel < last.length; wheel++) {
        const contact = contacts[wheel], p = last[wheel], strength = strengths[wheel];
        if (strength <= .025 || !isAsphaltContact(contact)) { p.valid = false; continue; }
        const dx = contact.x - p.x, dz = contact.z - p.z, distance = Math.hypot(dx, dz);
        if (!p.valid || distance > 8) {
          p.x = contact.x; p.z = contact.z; p.valid = true; p.distance = 0; p.sideX = p.sideZ = 0;
          continue;
        }
        if (distance < .16) continue;
        const sideX = -dz / distance * HALF_WIDTH, sideZ = dx / distance * HALF_WIDTH;
        // Retain the preceding ribbon's edges to join bends without gaps.
        const previousX = p.sideX || p.sideZ ? p.sideX : sideX;
        const previousZ = p.sideX || p.sideZ ? p.sideZ : sideZ;
        const pos = cursor * 12, tex = cursor * 8;
        const y = Math.max(.043, contact.height + .025);
        positions.set([
          p.x + previousX, y, p.z + previousZ,
          p.x - previousX, y, p.z - previousZ,
          contact.x + sideX, y, contact.z + sideZ,
          contact.x - sideX, y, contact.z - sideZ,
        ], pos);
        uv.set([0, p.distance, 1, p.distance, 0, p.distance + distance, 1, p.distance + distance], tex);
        for (let vertex = 0; vertex < 4; vertex++) {
          marks[tex + vertex * 2] = time;
          marks[tex + vertex * 2 + 1] = strength;
        }
        positionAttribute.addUpdateRange(pos, 12);
        uvAttribute.addUpdateRange(tex, 8);
        markAttribute.addUpdateRange(tex, 8);
        cursor = (cursor + 1) % CAPACITY; used = Math.min(CAPACITY, used + 1); emitted++;
        p.x = contact.x; p.z = contact.z; p.distance += distance; p.sideX = sideX; p.sideZ = sideZ;
        dirty = true;
      }
      if (dirty) {
        positionAttribute.needsUpdate = uvAttribute.needsUpdate = markAttribute.needsUpdate = true;
        geometry.setDrawRange(0, used * 6);
      }
    },
    resetContinuity() { for (const wheel of last) wheel.valid = false; },
    diagnostics() { return { emitted, used, capacity: CAPACITY, lifetime: LIFETIME }; },
  };
}
