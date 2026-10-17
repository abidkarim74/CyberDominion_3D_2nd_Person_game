import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

await mkdir('artifacts', { recursive: true });
for (const name of ['person-seat-motion', 'person-ground-motion']) await writeFile(`artifacts/${name}-gait-compiled.mjs`, ts.transpileModule(await readFile(`lib/${name}.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { PersonSeatMotion } = await import('../artifacts/person-seat-motion-gait-compiled.mjs');
const { PersonGroundMotion } = await import('../artifacts/person-ground-motion-gait-compiled.mjs');
const scale = .92 * .92;

// Retain actual geometry, skinning and animations while replacing materials;
// Node does not need image decoding to inspect the shipped player's skeleton.
async function loadPlayer(path) {
  const bytes = await readFile(path), jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  delete gltf.materials; delete gltf.images; delete gltf.textures;
  const json = Buffer.from(JSON.stringify(gltf)), paddedLength = Math.ceil(json.length / 4) * 4;
  const body = bytes.subarray(20 + jsonLength), output = Buffer.alloc(20 + paddedLength + body.length, 32);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20); body.copy(output, 20 + paddedLength);
  return new GLTFLoader().parseAsync(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength), '');
}

const asset = process.env.PERSON_ASSET || 'public/models/person/person.glb';
const player = await loadPlayer(asset);
const model = player.scene; model.scale.multiplyScalar(scale);
const root = new THREE.Group(); root.add(model);
const bones = new Map(); model.traverse(object => { if (object.isBone) bones.set(object.name.toLowerCase().replace(/[^a-z0-9]/g, ''), object); });
const find = suffix => [...bones].find(([name]) => name.endsWith(suffix.toLowerCase()))?.[1];
const mixer = new THREE.AnimationMixer(model);
const actions = new Map(player.animations.map(clip => [clip.name, mixer.clipAction(clip)]));
const pose = (name, time = 0) => { mixer.stopAllAction(); actions.get(name).reset().play(); mixer.setTime(time); model.updateMatrixWorld(true); };
const joints = Object.fromEntries(['left', 'right'].map(side => [side, { hip: find(`${side}upleg`), knee: find(`${side}leg`), ankle: find(`${side}foot`) }]));
const metrics = () => Object.fromEntries(Object.entries(joints).map(([side, leg]) => {
  const points = Object.fromEntries(Object.entries(leg).map(([name, bone]) => [name, bone.getWorldPosition(new THREE.Vector3())]));
  const thigh = points.hip.clone().sub(points.knee), shin = points.ankle.clone().sub(points.knee);
  const axis = points.ankle.clone().sub(points.hip), kneeOffset = points.knee.clone().sub(points.hip);
  kneeOffset.addScaledVector(axis, -kneeOffset.dot(axis) / axis.lengthSq());
  return [side, { ...Object.fromEntries(Object.entries(points).map(([name, p]) => [name, p.toArray()])),
    kneeFlexionDegrees: 180 - THREE.MathUtils.radToDeg(thigh.angleTo(shin)),
    kneeLateralOffset: kneeOffset.x,
    reachRatio: points.hip.distanceTo(points.ankle) / (thigh.length() + shin.length()) }];
}));

function calibrate(name) {
pose(name);
const probes = { left: [], right: [] }, inverses = Object.fromEntries(Object.entries(joints).map(([side, leg]) => [side, leg.ankle.matrixWorld.clone().invert()]));
model.traverse(mesh => {
  if (!mesh.isSkinnedMesh) return;
  mesh.skeleton.update();
  const indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
  const sides = mesh.skeleton.bones.map(bone => bone.name.toLowerCase().match(/(left|right)(?:foot|toe)/)?.[1]);
  for (let vertex = 0; vertex < indices.count; vertex++) for (const side of ['left', 'right']) {
    let weight = 0;
    for (let component = 0; component < 4; component++) if (sides[indices.getComponent(vertex, component)] === side) weight += weights.getComponent(vertex, component);
    if (weight < .5) continue;
    probes[side].push(mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverses[side]));
  }
});
return probes;
}
const legacyProbes = calibrate('Seated'), probes = calibrate('Idle');
const clearance = (side, shape = probes) => {
  const rotation = joints[side].ankle.getWorldQuaternion(new THREE.Quaternion()), worldScale = joints[side].ankle.getWorldScale(new THREE.Vector3());
  return Math.max(.04, -Math.min(...shape[side].map(p => p.clone().multiply(worldScale).applyQuaternion(rotation).y)) + .010);
};
const solver = new PersonSeatMotion(model), grounding = new PersonGroundMotion(model), report = { asset, samples: [] };
let runMinimum = Infinity;
for (let sample = 0; sample < 48; sample++) {
  pose('Run', actions.get('Run').getClip().duration * sample / 48);
  for (const side of ['left', 'right']) runMinimum = Math.min(runMinimum,
    joints[side].ankle.getWorldPosition(new THREE.Vector3()).y - clearance(side));
}
const runBaseline = -Math.max(0, runMinimum);
report.runBaseline = runBaseline;
for (const name of ['Idle', 'Walk', 'Run']) {
  const duration = actions.get(name).getClip().duration;
  for (let frame = 0; frame < (name === 'Idle' ? 4 : 12); frame++) {
    solver.restore(); grounding.restore(); pose(name, duration * frame / (name === 'Idle' ? 4 : 12));
    const before = metrics(), legacyFloors = { left: clearance('left', legacyProbes), right: clearance('right', legacyProbes) };
    solver.update((_ankle, side) => legacyFloors[side]);
    const legacy = metrics(); solver.restore(); model.updateMatrixWorld(true);
    const floors = { left: clearance('left'), right: clearance('right') };
    grounding.update((_ankle, side) => floors[side], name === 'Run' ? runBaseline : 0);
    solver.update((_ankle, side) => floors[side]);
    const after = metrics();
    for (const side of ['left', 'right']) {
      assert.ok(Math.abs(before[side].kneeFlexionDegrees - after[side].kneeFlexionDegrees) < 1e-5,
        'Grounding preserves the captured anatomical knee bend instead of shortening the leg');
      assert.ok(after[side].ankle[1] >= floors[side] - 1e-7, 'The supporting boot remains above the road');
      if (name === 'Idle') assert.ok(after[side].kneeFlexionDegrees < 7 && Math.abs(after[side].kneeLateralOffset) < .02,
        'Idle remains upright with softly unlocked, aligned knees');
    }
    report.samples.push({ clip: name, time: duration * frame / (name === 'Idle' ? 4 : 12), before, legacy,
      clearance: floors, verticalOffset: grounding.diagnostics.verticalOffset, after });
  }
}

// Exercise authored planted/swing phases at the real controller's speed/scale,
// rather than accepting a still pose that happens to have straight knees.
solver.restore(); grounding.restore(); pose('Walk'); root.position.set(0, 0, 0);
actions.get('Walk').setEffectiveTimeScale(1 / scale);
let previousFeet, previousKnees, maximumKneeFrameAngle = 0;
const plantedSpeeds = [], leftHeights = [], rightHeights = [];
for (let frame = 0; frame < 360; frame++) {
  solver.restore(); grounding.restore(); root.position.z += 1.65 / 120;
  mixer.update(1 / 120); root.updateMatrixWorld(true);
  grounding.update((_ankle, side) => clearance(side));
  solver.update((_ankle, side) => clearance(side));
  const current = metrics(), feet = Object.fromEntries(Object.entries(current).map(([side, m]) => [side, new THREE.Vector3(...m.ankle)]));
  const knees = Object.values(joints).map(leg => leg.knee.getWorldQuaternion(new THREE.Quaternion()));
  for (const [side, heights] of [['left', leftHeights], ['right', rightHeights]]) {
    const height = current[side].ankle[1] - clearance(side); heights.push(height);
    if (frame > 12 && height < .012 && previousFeet) plantedSpeeds.push(Math.hypot(feet[side].x - previousFeet[side].x, feet[side].z - previousFeet[side].z) * 120);
  }
  if (previousKnees) maximumKneeFrameAngle = Math.max(maximumKneeFrameAngle, ...knees.map((q, i) => q.angleTo(previousKnees[i])));
  previousFeet = feet; previousKnees = knees;
}
plantedSpeeds.sort((a, b) => a - b);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const leftMean = mean(leftHeights), rightMean = mean(rightHeights);
const correlation = leftHeights.reduce((sum, value, i) => sum + (value - leftMean) * (rightHeights[i] - rightMean), 0) /
  Math.sqrt(leftHeights.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * rightHeights.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
report.walking = { plantedMedianSpeed: plantedSpeeds[Math.floor(plantedSpeeds.length / 2)], maximumKneeFrameAngle,
  alternatingFootHeightCorrelation: correlation, maximumSwingClearance: Math.max(...leftHeights, ...rightHeights) };
assert.ok(report.walking.plantedMedianSpeed < .35, 'The supporting foot counters body travel instead of sliding with the player');
assert.ok(correlation < -.4 && report.walking.maximumSwingClearance > .035, 'Left and right swing phases alternate and clear the road');
assert.ok(maximumKneeFrameAngle < .14, 'Knees follow the continuous captured gait without IK branch flips');
await writeFile('artifacts/person-gait-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.samples.map(sample => ({ clip: sample.clip, time: +sample.time.toFixed(3),
  before: [sample.before.left.kneeFlexionDegrees, sample.before.right.kneeFlexionDegrees].map(v => +v.toFixed(1)),
  legacy: [sample.legacy.left.kneeFlexionDegrees, sample.legacy.right.kneeFlexionDegrees].map(v => +v.toFixed(1)),
  after: [sample.after.left.kneeFlexionDegrees, sample.after.right.kneeFlexionDegrees].map(v => +v.toFixed(1)),
  ankle: [sample.before.left.ankle[1], sample.before.right.ankle[1]].map(v => +v.toFixed(3)),
  floor: [sample.clearance.left, sample.clearance.right].map(v => +v.toFixed(3)),
})), null, 2));
console.log('Walking:', JSON.stringify(report.walking), 'Run baseline:', runBaseline);
