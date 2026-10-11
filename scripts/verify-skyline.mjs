import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile('lib/cyberpunk-buildings.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("from 'three'", `from '${import.meta.resolve('three')}'`);
const { planSkylineBuilding, makeSkylineStyles, addSkylineBuilding, SKYLINE_SHAPES } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

// Geometry QA does not need a GPU: textures only need a canvas object with a 2D drawing API.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: (_target, property) => property === 'globalAlpha' ? 1 : () => {} }) }) };
const scene = new THREE.Scene(); const styles = makeSkylineStyles(); const colliders = []; const signs = new Map();
const plans = []; let seed = 1;
for (let ix = -8; ix <= 8; ix++) for (let iz = -8; iz <= 8; iz++) {
  const plan = planSkylineBuilding(ix * 44, iz * 44, seed++);
  assert.deepEqual(plan, planSkylineBuilding(plan.x, plan.z, plan.seed), 'City dimensions are deterministic');
  plans.push(plan); addSkylineBuilding(scene, styles, colliders, plan, signs);
}
scene.updateMatrixWorld(true);
const roadDistance = value => Math.abs(value - (Math.round((value - 22) / 44) * 44 + 22));
const vector = new THREE.Vector3(); let triangles = 0; let vertices = 0;
for (const group of scene.children) {
  const plan = group.userData.skylineBuilding; const bounds = new THREE.Box3().setFromObject(group);
  assert.ok(bounds.max.y <= plan.height + 20, 'Roof accessories remain bounded');
  assert.ok(bounds.max.x - bounds.min.x < 25.5 && bounds.max.z - bounds.min.z < 25.5, 'Every silhouette stays on its block island');
  const collider = colliders[plan.seed - 1];
  group.traverse(object => {
    assert.ok(!object.isLight, 'Buildings do not add real-time lights');
    if (!(object instanceof THREE.Mesh)) return;
    assert.ok(!object.material.transparent, 'Architecture has no transparent overdraw');
    const p = object.geometry.getAttribute('position');
    triangles += (object.geometry.index?.count ?? p.count) / 3;
    const uv = object.geometry.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      vector.fromBufferAttribute(p, i).applyMatrix4(object.matrixWorld); vertices++;
      assert.ok(Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z), 'Generated vertices are finite');
      assert.ok(Math.min(roadDistance(vector.x), roadDistance(vector.z)) >= 9.3, 'Architecture keeps the entire 18m roadway clear');
      if (vector.y > .35 && vector.y < 1.6) assert.ok(Math.abs(vector.x - collider.x) <= collider.hx + .001 && Math.abs(vector.z - collider.z) <= collider.hz + .001, 'Vehicle-height volumes match their collider');
      if (uv) assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)), 'Window UVs remain finite');
    }
  });
}
const buckets = {
  low: plans.filter(p => p.height < 34).length,
  medium: plans.filter(p => p.height >= 34 && p.height < 90).length,
  tall: plans.filter(p => p.height >= 90 && p.height < 200).length,
  skyscrapers: plans.filter(p => p.height >= 200).length,
};
assert.ok(buckets.low >= 60 && buckets.medium >= 80 && buckets.tall >= 40 && buckets.skyscrapers >= 10, 'Low rises, mid rises, towers and skyscrapers all contribute to the skyline');
assert.equal(new Set(plans.map(p => p.shape)).size, SKYLINE_SHAPES.length, 'All twelve silhouettes appear');
assert.ok(Math.max(...plans.map(p => p.height)) >= 300, 'There are exceptionally tall landmarks');
assert.ok(Math.max(...plans.map(p => p.width)) - Math.min(...plans.map(p => p.width)) > 10, 'Building widths vary substantially');
assert.ok(triangles < 65000, 'The entire new skyline remains within its static geometry budget');
assert.equal(signs.size, 5, 'Advertisements reuse five materials');
assert.equal(scene.userData.cyberpunkSkylineTriangles, triangles, 'Runtime metadata matches built geometry');
console.log(JSON.stringify({ buildings: plans.length, shapes: SKYLINE_SHAPES.length, buckets, heightRange: [Math.min(...plans.map(p => p.height)), Math.max(...plans.map(p => p.height))], widthRange: [Math.min(...plans.map(p => p.width)), Math.max(...plans.map(p => p.width))], triangles, vertices, startingBlocks: plans.filter(p => Math.abs(p.x) <= 44 && Math.abs(p.z) <= 44).map(p => ({ x: p.x, z: p.z, height: p.height, archetype: p.archetype })) }, null, 2));
