import * as THREE from 'three';

export const NITRO_OUTLETS = [
  { x: -.80, y: .30, z: 2.405, radius: .062, length: 1.65 },
  { x: -.225, y: .222, z: 2.405, radius: .035, length: 1.35 },
  { x: -.075, y: .222, z: 2.405, radius: .035, length: 1.35 },
  { x: .075, y: .222, z: 2.405, radius: .035, length: 1.35 },
  { x: .225, y: .222, z: 2.405, radius: .035, length: 1.35 },
  { x: .80, y: .30, z: 2.405, radius: .062, length: 1.65 },
] as const;
const GLOW_PATCHES = [
  { x: -.80, width: .64, length: 2.16 },
  { x: 0, width: .91, length: 1.90 },
  { x: .80, width: .64, length: 2.16 },
] as const;
const RINGS = 10;
const SIDES = 10;

export interface NitroEffects {
  /** One bounded draw for both bumper ends, center plumes, and their road glow. */
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Intensity is 0–1. Animation changes uniforms only; GPU buffers remain static. */
  update(elapsed: number, delta: number, intensity: number): void;
  reset(): void;
}

/** Rearward (+Z) green nitrous fire at both bumper ends and the four center outlets. */
export function createNitroEffects(parent: THREE.Object3D): NitroEffects {
  const vertexCount = NITRO_OUTLETS.length * 2 * (RINGS + 1) * (SIDES + 1) + GLOW_PATCHES.length * 4;
  const indexCount = NITRO_OUTLETS.length * 2 * RINGS * SIDES * 6 + GLOW_PATCHES.length * 6;
  const positions = new Float32Array(vertexCount * 3);
  const parameters = new Float32Array(vertexCount * 4);
  const origins = new Float32Array(vertexCount * 4);
  const lengths = new Float32Array(vertexCount);
  const indices = new Uint16Array(indexCount);
  let vertex = 0;
  let index = 0;

  for (let outlet = 0; outlet < NITRO_OUTLETS.length; outlet++) {
    const nozzle = NITRO_OUTLETS[outlet];
    for (let layer = 0; layer < 2; layer++) {
      const start = vertex;
      for (let ring = 0; ring <= RINGS; ring++) {
        const along = ring / RINGS;
        const radius = nozzle.radius * (layer === 0 ? 1 : .486) * Math.pow(1 - along, .72);
        for (let side = 0; side <= SIDES; side++) {
          const angle = side / SIDES * Math.PI * 2;
          const p = vertex * 3;
          const a = vertex * 4;
          positions[p] = nozzle.x + Math.cos(angle) * radius;
          positions[p + 1] = nozzle.y + Math.sin(angle) * radius;
          positions[p + 2] = nozzle.z + along * nozzle.length * (layer === 0 ? 1 : .563);
          parameters[a] = along;
          parameters[a + 1] = angle;
          parameters[a + 2] = layer;
          parameters[a + 3] = outlet;
          origins[a] = nozzle.x;
          origins[a + 1] = nozzle.y;
          origins[a + 2] = nozzle.z;
          origins[a + 3] = nozzle.radius;
          lengths[vertex] = nozzle.length;
          vertex++;
        }
      }
      for (let ring = 0; ring < RINGS; ring++) {
        for (let side = 0; side < SIDES; side++) {
          const a = start + ring * (SIDES + 1) + side;
          const b = a + SIDES + 1;
          indices[index++] = a; indices[index++] = a + 1; indices[index++] = b;
          indices[index++] = a + 1; indices[index++] = b + 1; indices[index++] = b;
        }
      }
    }
  }

  // Three localized green reflections reuse the plume draw without lights or render passes.
  for (const patch of GLOW_PATCHES) {
    const glowStart = vertex;
    for (let corner = 0; corner < 4; corner++) {
      const u = corner % 2;
      const v = corner < 2 ? 0 : 1;
      const p = vertex * 3;
      const a = vertex * 4;
      positions[p] = patch.x + (u - .5) * patch.width;
      positions[p + 1] = .043;
      positions[p + 2] = 2.40 + v * patch.length;
      parameters[a] = u;
      parameters[a + 1] = v;
      parameters[a + 2] = 2;
      parameters[a + 3] = 0;
      vertex++;
    }
    indices[index++] = glowStart; indices[index++] = glowStart + 2; indices[index++] = glowStart + 1;
    indices[index++] = glowStart + 1; indices[index++] = glowStart + 2; indices[index++] = glowStart + 3;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aJet', new THREE.BufferAttribute(parameters, 4));
  geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 4));
  geometry.setAttribute('aLength', new THREE.BufferAttribute(lengths, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Shader displacement stays within these bounds, including the full-length release tail.
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1.14, .02, 2.395), new THREE.Vector3(1.14, .44, 4.57));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, .20, 3.48), 1.63);

  const uniforms = {
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uGroundToBody: { value: new THREE.Matrix4() },
  };
  const material = new THREE.ShaderMaterial({
    name: 'Nitrous / emerald fire, lime core, soft green road reflection',
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    vertexShader: `
      attribute vec4 aJet;
      attribute vec4 aOrigin;
      attribute float aLength;
      uniform float uTime;
      uniform float uStrength;
      uniform mat4 uGroundToBody;
      varying vec4 vJet;
      varying vec3 vRadial;
      varying vec3 vView;
      void main() {
        vJet = aJet;
        vec3 transformed = position;
        vec3 radial = vec3(cos(aJet.y), sin(aJet.y), 0.0);
        if (aJet.z < 1.5) {
          float along = aJet.x;
          float phase = aJet.w * 1.73;
          float core = aJet.z;
          float taper = pow(max(0.0, 1.0 - along), 0.72);
          float flutter = sin(uTime * 34.0 - along * 22.0 + phase) * 0.10
            + sin(uTime * 57.0 - along * 37.0 + phase) * 0.045;
          float throat = aOrigin.w * mix(1.0, 0.486, core);
          float swell = 1.0 + sin(along * 3.14159) * mix(0.63, 0.20, core);
          float radius = throat * taper * swell * (1.0 + flutter * along);
          float lengthPulse = 1.0 + sin(uTime * 26.0 + phase) * 0.06;
          float jetLength = aLength * mix(1.0, 0.563, core) * (0.28 + uStrength * 0.72) * lengthPulse;
          transformed = aOrigin.xyz;
          transformed += radial * radius;
          transformed.z += along * jetLength;
          // The inlet never shifts; only the downstream flame gently ripples.
          transformed.x += sin(uTime * 19.0 - along * 14.0 + phase) * 0.011 * along * along;
          transformed.y += sin(uTime * 23.0 - along * 17.0 + phase) * 0.007 * along * along;
        } else {
          // Suspension can pitch/roll the body; its road reflection stays flat beneath the car.
          transformed = (uGroundToBody * vec4(position, 1.0)).xyz;
        }
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        vRadial = normalize(normalMatrix * radial);
        vView = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uStrength;
      varying vec4 vJet;
      varying vec3 vRadial;
      varying vec3 vView;
      void main() {
        vec3 color;
        float alpha;
        if (vJet.z > 1.5) {
          vec2 centered = vec2((vJet.x - 0.5) * 2.0, (vJet.y - 0.38) * 1.6);
          float falloff = max(0.0, 1.0 - dot(centered, centered));
          color = vec3(0.035, 0.72, 0.12);
          alpha = falloff * falloff * 0.22 * uStrength;
        } else {
          float along = vJet.x;
          float core = vJet.z;
          float edge = abs(dot(normalize(vRadial), normalize(vView)));
          float softEdge = 0.32 + 0.68 * smoothstep(0.0, 0.80, edge);
          float tipFade = pow(max(0.0, 1.0 - along), 0.78);
          float cells = 0.86 + 0.14 * sin(along * 43.0 - uTime * 38.0 + vJet.w * 1.73);
          vec3 emerald = vec3(0.025, 1.30, 0.16);
          vec3 green = vec3(0.12, 1.85, 0.24);
          vec3 hot = vec3(0.76, 2.25, 0.38);
          color = mix(green, emerald, smoothstep(0.16, 0.95, along));
          color = mix(color, hot, core * (1.0 - smoothstep(0.04, 0.90, along)));
          alpha = uStrength * tipFade * softEdge * cells * mix(0.44, 0.74, core);
        }
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
  material.userData.noCastShadow = true;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Nitrous / green fire at both bumper ends and center';
  mesh.userData.dynamic = true;
  mesh.userData.noCastShadow = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  parent.add(mesh);

  let strength = 0;
  return {
    mesh,
    update(elapsed, delta, intensity) {
      const target = Math.max(0, Math.min(1, intensity));
      const response = target > strength ? 28 : 16;
      strength += (target - strength) * (1 - Math.exp(-Math.max(0, delta) * response));
      if (target === 0 && strength < .004) strength = 0;
      uniforms.uTime.value = elapsed % 120;
      uniforms.uStrength.value = strength;
      mesh.visible = strength > 0;
      if (mesh.visible) {
        parent.updateMatrix();
        uniforms.uGroundToBody.value.copy(parent.matrix).invert();
      }
    },
    reset() {
      strength = 0;
      uniforms.uStrength.value = 0;
      mesh.visible = false;
    },
  };
}
