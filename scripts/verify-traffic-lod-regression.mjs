import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import * as THREE from 'three';
import { createTrafficLod } from '../lib/traffic-lod.ts';

// Run with: node --experimental-transform-types scripts/verify-traffic-lod-regression.mjs
// Synthetic geometry keeps this regression independent of a browser/GPU.
const source = new THREE.Group();
source.position.set(7, .4, -12); source.rotation.y = .6;
const body = new THREE.Group(); source.add(body);
body.position.set(.2, .3, -.1); body.rotation.z = .1;
const authoredNormal = new THREE.Vector3(.4, .6, Math.sqrt(.48));
function triangle(material, x) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    ...authoredNormal, ...authoredNormal, ...authoredNormal,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geometry, material); mesh.position.x = x;
  body.add(mesh); return mesh;
}
const paint = new THREE.MeshStandardMaterial({ color: 0x2277cc });
paint.userData.vehiclePaint = true;
const painted = triangle(paint, 0);
painted.rotation.set(.3, -.2, .1); painted.scale.set(.8, 1.4, .6);
triangle(new THREE.MeshStandardMaterial({ color: 0x333333 }), 2);
const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: .53 });
glass.name = 'Car / smoked laminated canopy'; triangle(glass, 4);
const headlights = [triangle(new THREE.MeshBasicMaterial({ color: 0xffffff }), 6)];
const brakeLights = [triangle(new THREE.MeshStandardMaterial({ emissive: 0xff0000 }), 8)];
const reverseLights = [triangle(new THREE.MeshStandardMaterial({ emissive: 0xffffff }), 10)];
triangle(new THREE.MeshStandardMaterial({ alphaTest: .35 }), 30);
triangle(new THREE.MeshStandardMaterial({ alphaMap: new THREE.Texture() }), 40);
triangle(new THREE.MeshBasicMaterial({ transparent: true, opacity: .9, alphaMap: new THREE.Texture() }), 50);
const hidden = triangle(new THREE.MeshStandardMaterial(), 60); hidden.visible = false;
triangle(new THREE.MeshStandardMaterial(), 70).userData.cockpitDetail = true;
source.updateWorldMatrix(true, true);
const transform = new THREE.Matrix4().multiplyMatrices(source.matrixWorld.clone().invert(), painted.matrixWorld);
const expectedNormal = authoredNormal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(transform));
const emitters = { headlights, brakeLights, reverseLights };
const lod = createTrafficLod(source, source, 0x4488cc, emitters);
assert.equal(lod.root.children.length, 6, 'A complete far exterior requires six surface draws');
for (const mesh of lod.root.children) {
  assert.equal(mesh.geometry.index.count, 3, 'Masked, hidden, cockpit and contact planes cannot become opaque proxy triangles');
  assert.equal(mesh.geometry.getAttribute('position').count, 3);
  assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
  assert.equal(Array.isArray(mesh.material), false);
}
const farPaint = lod.root.children.find(mesh => mesh.name.endsWith('paint'));
const normals = farPaint.geometry.getAttribute('normal');
for (let i = 0; i < normals.count; i++) {
  const actual = new THREE.Vector3().fromBufferAttribute(normals, i);
  assert.ok(actual.distanceTo(expectedNormal) < 1e-6, 'Authored normals survive nonuniform transforms rather than becoming face normals');
  assert.ok(Math.abs(actual.length() - 1) < 1e-6);
}
const farGlass = lod.root.children.find(mesh => mesh.name.endsWith('glass'));
assert.equal(farGlass.material.transparent, true); assert.equal(farGlass.material.opacity, .53);
assert.equal(farGlass.material.depthWrite, false); assert.equal(farGlass.material.side, THREE.FrontSide);
assert.ok(lod.root.children.every(mesh => !mesh.material.transparent || mesh.material.side !== THREE.DoubleSide),
  'No distant surface can require Three\'s second transparent backface draw');
lod.update(100 ** 2, false, .03, -.02, true, true);
assert.equal(lod.root.visible, true); assert.equal(body.visible, false);
assert.equal(lod.root.children.find(mesh => mesh.name.endsWith('brakes')).material.emissiveIntensity, 4.5);
assert.equal(lod.root.children.find(mesh => mesh.name.endsWith('reverse')).material.emissiveIntensity, 2.2);
lod.update(83 ** 2, false, 0, 0, false, false); assert.equal(lod.root.visible, true);
lod.update(71 ** 2, false, 0, 0, false, false); assert.equal(lod.root.visible, false); assert.equal(body.visible, true);
assert.equal(hidden.visible, false, 'Switching representation preserves authored hidden parts');
lod.update(83 ** 2, false, 0, 0, false, false); assert.equal(lod.root.visible, false);
lod.update(85 ** 2, false, 0, 0, false, false); assert.equal(lod.root.visible, true);
lod.update(100 ** 2, true, 0, 0, false, false); assert.equal(lod.root.visible, false); assert.equal(body.visible, true);

// Exercise the actual source hook without constructing unrelated canvas assets.
const carSource = await readFile(new URL('../lib/cinematic-car.ts', import.meta.url), 'utf8');
const start = carSource.indexOf('const shadowMaterial =');
const end = carSource.indexOf('const shadow =', start);
assert.ok(start > 0 && end > start);
const glowMap = new THREE.Texture();
const shadowMaterial = new Script(`${carSource.slice(start, end)}\nshadowMaterial;`).runInNewContext({ THREE, glowMap });
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 5.9), shadowMaterial);
const trafficShadow = shadow.clone();
assert.equal(trafficShadow.material, shadowMaterial, 'Traffic mesh cloning retains the analytic shadow hook');
const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader };
shadowMaterial.onBeforeCompile(shader, {});
assert.ok(shader.fragmentShader.includes('length(vAlphaMapUv - vec2(.5))'));
assert.ok(shader.fragmentShader.includes('smoothstep(.08, .5, contactRadius)'));
assert.equal(shader.fragmentShader.includes('#include <alphamap_fragment>'), false);
assert.equal(shadowMaterial.alphaMap, glowMap, 'Alpha UV varying remains enabled');
assert.equal(shadowMaterial.transparent, true); assert.equal(shadowMaterial.depthWrite, false);
assert.equal(shadowMaterial.customProgramCacheKey(), 'car-contact-shadow-analytic-v1');
for (const [u, v] of [[0, 0], [0, .5], [.5, 0], [1, .5], [.5, 1], [1, 1]]) {
  assert.ok(Math.hypot(u - .5, v - .5) >= .5, 'Every shadow-plane edge has zero analytic alpha');
}
console.log('Traffic LOD regression passed: six draws, alpha exclusion, transformed authored normals, transparent glass, hysteresis and analytic contact-shadow hook.');
