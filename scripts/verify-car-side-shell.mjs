import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

// Load only the procedural body: this regression needs no browser or canvas textures.
const sourcePath = new URL('../lib/cyber-car-body.ts', import.meta.url);
const source = (await readFile(sourcePath, 'utf8')).replace(
  /from\s+(['"])three\1/g,
  `from ${JSON.stringify(import.meta.resolve('three'))}`,
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { addCyberBody, addCyberCabin } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const materials = Object.fromEntries(['paint', 'carbon', 'alloy', 'amber', 'glass'].map(name => {
  const material = new THREE.MeshBasicMaterial({
    side: THREE.FrontSide,
    transparent: name === 'glass',
    opacity: name === 'glass' ? .68 : 1,
  });
  material.name = name;
  return [name, material];
}));
const body = new THREE.Group();
addCyberBody(body, materials);
body.updateWorldMatrix(true, true);
const opaque = [], painted = [];
let triangles = 0;
body.traverse(object => {
  if (!(object instanceof THREE.Mesh)) return;
  assert.ok(!Array.isArray(object.material), 'Body test expects one material per surface');
  assert.equal(object.material.side, THREE.FrontSide, 'Exterior panels retain one-sided culling');
  const position = object.geometry.getAttribute('position');
  assert.ok(position && position.count > 0, 'Body surfaces have vertices');
  for (let i = 0; i < position.array.length; i++) {
    assert.ok(Number.isFinite(position.array[i]), 'All body vertices are finite');
  }
  triangles += (object.geometry.index?.count ?? position.count) / 3;
  if (!object.material.transparent) opaque.push(object);
  if (object.material === materials.paint) painted.push(object);
});

const bounds = new THREE.Box3().setFromObject(body);
const size = bounds.getSize(new THREE.Vector3());
assert.ok(size.x <= 2.12, `Body width ${size.x.toFixed(4)} exceeds its driving footprint`);
assert.ok(size.z <= 5.4 && size.z >= 4.9, 'Body keeps its full-length supercar footprint');
assert.ok(bounds.max.y <= 1.45 && bounds.min.y >= .15, 'Body stays within its low roof/ground clearance');
assert.ok(Math.abs(bounds.min.x + bounds.max.x) < 1e-5, 'Body bounds are centered and mirror symmetric');

const failures = [];
const raycaster = new THREE.Raycaster();
// Stop before the opposite side or cockpit: a hit must be on the visible near-side skin.
function sideHit(side, y, z, meshes = opaque, nearSideX = .84) {
  raycaster.set(new THREE.Vector3(side * 3, y, z), new THREE.Vector3(-side, 0, 0));
  raycaster.near = 0;
  raycaster.far = 3 - nearSideX;
  return raycaster.intersectObjects(meshes, false)[0] ?? null;
}
const pointLabel = (side, y, z) => `${side < 0 ? 'left' : 'right'} y=${y.toFixed(3)} z=${z.toFixed(3)}`;
function checkPair(hits, label) {
  if (hits[0] && hits[1] && Math.abs(hits[0].distance - hits[1].distance) > .003) {
    failures.push(`${label}: side skin differs by more than 3 mm`);
  }
}

// Door paint remains continuous from the front arch to the small aft intake.
// Query paint separately so a tiny handle or seam cannot hide the underlying door.
let doorSamples = 0;
for (const y of [.34, .44, .55, .65, .75]) {
  for (const z of [-.9, -.75, -.6, -.45, -.3, -.15, 0, .15, .3, .45]) {
    const hits = [-1, 1].map(side => {
      doorSamples++;
      const hit = sideHit(side, y, z, painted, .82);
      if (!hit) failures.push(`Missing outward painted door at ${pointLabel(side, y, z)}`);
      else if (hit.face.normal.x * side <= .1) failures.push(`Door normal faces inward at ${pointLabel(side, y, z)}`);
      return hit;
    });
    checkPair(hits, `Door y=${y} z=${z}`);
  }
}

// Tire swept silhouette is clear at the outer side. An inner wheel tub may exist
// inside x=.84; it must not cover the visible tire opening or create an exposed gap.
let archOpeningSamples = 0, fenderSamples = 0;
for (const axleZ of [-1.43, 1.43]) {
  for (const radius of [0, .2, .36, .405]) {
    const angles = radius === 0 ? [Math.PI / 2] : [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3, 5 * Math.PI / 6, Math.PI];
    for (const angle of angles) {
      const y = .385 + Math.sin(angle) * radius, z = axleZ + Math.cos(angle) * radius;
      for (const side of [-1, 1]) {
        archOpeningSamples++;
        const hit = sideHit(side, y, z);
        if (hit) failures.push(`Body blocks wheel opening at ${pointLabel(side, y, z)} (${hit.object.material.name}, x=${hit.point.x.toFixed(3)})`);
      }
    }
  }
  for (const angle of [Math.PI / 6, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3, 5 * Math.PI / 6]) {
    const y = .385 + Math.sin(angle) * .46, z = axleZ + Math.cos(angle) * .46;
    const hits = [-1, 1].map(side => {
      fenderSamples++;
      const hit = sideHit(side, y, z, opaque, .89);
      if (!hit) failures.push(`Missing solid outer fender at ${pointLabel(side, y, z)}`);
      return hit;
    });
    checkPair(hits, `Fender y=${y.toFixed(3)} z=${z.toFixed(3)}`);
  }
}

// Keep cabin queries separate so its added panels cannot mask body coverage
// failures or change the body-only bounds and triangle report above.
const cabin = new THREE.Group();
addCyberCabin(cabin, materials);
cabin.updateWorldMatrix(true, true);
let glassSamples = 0, headerSamples = 0;
function cabinHit(origin, direction, far) {
  raycaster.set(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
  raycaster.near = 0;
  raycaster.far = far;
  return raycaster.intersectObject(cabin, true)[0] ?? null;
}
function checkGlass(hit, label, axis, outward) {
  glassSamples++;
  if (!hit || hit.object.material !== materials.glass) failures.push(`Missing exterior glass at ${label}`);
  else if (hit.face.normal.getComponent(axis) * outward <= .1) failures.push(`Glass normal faces inward at ${label}`);
}
for (const [y, z] of [[1.04, -.52], [1.13, -.1], [1.10, .2], [1.10, .48], [.97, .68]]) {
  const hits = [-1, 1].map(side => {
    const hit = cabinHit([side * 3, y, z], [-side, 0, 0], 2.65);
    checkGlass(hit, pointLabel(side, y, z), 0, side);
    return hit;
  });
  checkPair(hits, `Side window y=${y} z=${z}`);
}
for (const [label, y, z, directionZ] of [
  ['low windshield', .95, -2, 1], ['high windshield', 1.18, -2, 1],
  ['low rear window', 1.0, 2, -1], ['high rear window', 1.19, 2, -1],
]) {
  checkGlass(cabinHit([0, y, z], [0, 0, directionZ], 2), label, 2, -directionZ);
}
for (const [label, y, z, directionZ] of [
  ['front roof header', 1.26, -.4, 1], ['rear roof header', 1.273, .72, -1],
]) {
  headerSamples++;
  const hit = cabinHit([0, y, z], [0, 0, directionZ], .25);
  if (!hit || hit.object.material !== materials.paint) failures.push(`Open canopy slit at ${label}`);
}

console.log(JSON.stringify({
  doorSamples,
  archOpeningSamples,
  fenderSamples,
  glassSamples,
  headerSamples,
  triangles,
  bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), width: size.x, length: size.z },
  failures,
}, null, 2));
assert.equal(failures.length, 0, `${failures.length} side-shell regression checks failed`);
