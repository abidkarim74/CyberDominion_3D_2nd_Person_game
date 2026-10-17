import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

await mkdir('artifacts', { recursive: true });
const source = await readFile('lib/person-seat-motion.ts', 'utf8');
await writeFile('artifacts/person-seat-motion-compiled.mjs', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { PersonSeatMotion } = await import('../artifacts/person-seat-motion-compiled.mjs');
const model = new THREE.Group();
model.position.set(8, .3, -9);
model.rotation.set(.09, .47, -.07);
model.scale.setScalar(.8464);
const rigs = ['Left', 'Right'].map((side, index) => {
  const upper = new THREE.Bone(), lower = new THREE.Bone(), foot = new THREE.Bone();
  upper.name = `mixamorig${side}UpLeg`;
  lower.name = `mixamorig${side}Leg`;
  foot.name = `mixamorig${side}Foot`;
  upper.position.set(index ? .1 : -.1, 1.05, 0);
  lower.position.set(0, -.38, .16);
  foot.position.set(0, -.38, -.09);
  foot.rotation.set(.14, .06, -.08);
  model.add(upper); upper.add(lower); lower.add(foot);
  return { side: side.toLowerCase(), upper, lower, foot };
});
model.updateMatrixWorld(true);
const point = new THREE.Vector3(), rotation = new THREE.Quaternion();
const original = rigs.map(rig => ({
  hip: rig.upper.getWorldPosition(point).clone(),
  foot: rig.foot.getWorldPosition(point).clone(),
  rotation: rig.foot.getWorldQuaternion(rotation).clone(),
  quaternions: [rig.upper, rig.lower, rig.foot].map(bone => bone.quaternion.clone()),
  lengths: [rig.lower.position.length(), rig.foot.position.length()],
}));
const solver = new PersonSeatMotion(model);
const contacts = Object.fromEntries(rigs.map((rig, index) => [rig.side, {
  position: original[index].foot.clone().add(new THREE.Vector3(index ? -.03 : .03, .15, -.08)),
  rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(.02, .6, -.05)),
  weight: 1,
}]));

for (const weight of [0, .5, 1]) {
  for (let frame = 0; frame < 60; frame++) {
    solver.restore();
    model.updateMatrixWorld(true);
    for (const contact of Object.values(contacts)) contact.weight = weight;
    solver.update(-100, 1, contacts);
    rigs.forEach((rig, index) => {
      const expected = original[index].foot.clone().lerp(contacts[rig.side].position, weight);
      assert.ok(rig.foot.getWorldPosition(point).distanceTo(expected) < 1e-7,
        'Independent foot targets blend continuously without accumulating across frames');
      const expectedRotation = original[index].rotation.clone().slerp(contacts[rig.side].rotation, weight);
      assert.ok(rig.foot.getWorldQuaternion(rotation).angleTo(expectedRotation) < 1e-7,
        'Soles use the requested orientation under a rotated and scaled cabin');
      assert.ok(rig.upper.getWorldPosition(point).distanceTo(original[index].hip) < 1e-7,
        'Grounding never moves the seated pelvis');
      assert.deepEqual([rig.lower.position.length(), rig.foot.position.length()], original[index].lengths,
        'Reaching does not stretch either leg');
    });
  }
}
solver.restore();
rigs.forEach((rig, index) => [rig.upper, rig.lower, rig.foot].forEach((bone, joint) =>
  assert.ok(bone.quaternion.equals(original[index].quaternions[joint]), 'Restore recovers the authored pose')));
const sides = [];
solver.update((ankle, side) => { sides.push(side); return ankle.y + .1; });
assert.deepEqual(sides, ['left', 'right'], 'Terrain sampling receives each foot independently');
solver.restore();
solver.update(100);
rigs.forEach(rig => [rig.upper, rig.lower, rig.foot].forEach(bone =>
  assert.ok(bone.quaternion.toArray().every(Number.isFinite), 'Unreachable targets remain finite')));
console.log('Foot targets, blend continuity, cabin rotation, fixed hips, bone lengths, restoration, and unreachable targets passed');
