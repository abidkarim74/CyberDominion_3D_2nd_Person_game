import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const directory = 'artifacts/person-locomotion';
await mkdir(directory, { recursive: true });
for (const name of ['city-layout', 'city-collision', 'person-scale', 'person-controller', 'person-idle-motion', 'person-face-motion',
  'person-seat-motion', 'person-ground-motion', 'person-steering-motion', 'person-driver-visibility']) {
  const source = await readFile(`lib/${name}.ts`, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  await writeFile(`${directory}/${name}.mjs`, compiled.replace(/from '(\.\/[\w-]+)'/g, "from '$1.mjs'"));
}
const { PersonController } = await import(`../${directory}/person-controller.mjs`);
const { PersonIdleMotion } = await import(`../${directory}/person-idle-motion.mjs`);
const { ColliderGrid } = await import(`../${directory}/city-collision.mjs`);
const { PERSON_WORLD_SCALE } = await import(`../${directory}/person-scale.mjs`);

// Keep the actual skin/skeleton/captures while avoiding browser image decoding.
const asset = process.env.PERSON_ASSET || 'public/models/person/person.glb';
const bytes = await readFile(asset), jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) delete primitive.material;
delete gltf.materials; delete gltf.images; delete gltf.textures;
const json = Buffer.from(JSON.stringify(gltf)), paddedLength = Math.ceil(json.length / 4) * 4;
const body = bytes.subarray(20 + jsonLength), output = Buffer.alloc(20 + paddedLength + body.length, 32);
output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(paddedLength, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20); body.copy(output, 20 + paddedLength);
const player = await new GLTFLoader().parseAsync(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength), '');

// Initialise normal controller state without its asynchronous network request.
const load = GLTFLoader.prototype.load;
GLTFLoader.prototype.load = () => {};
const person = new PersonController(new THREE.Scene(), new ColliderGrid([]), () => 0);
GLTFLoader.prototype.load = load;
person.model = player.scene; person.model.scale.multiplyScalar(PERSON_WORLD_SCALE);
person.root.add(person.model); person.mixer = new THREE.AnimationMixer(person.model);
person.model.traverse(object => {
  const side = object.isBone && object.name.toLowerCase().match(/(left|right)foot$/)?.[1];
  if (side) person.footRest.set(side, { bone: object });
});
for (const clip of player.animations) {
  const name = person.canonicalClipName(clip.name);
  if (name) person.actions.set(name, person.mixer.clipAction(clip));
}
person.calibrateStridePhases();
person.play('Idle', 0); person.mixer.update(0);
person.idleMotion = new PersonIdleMotion(person.model);
person.mode = 'walking'; person.loaded = true;
person.driverBlocker.x = person.driverBlocker.z = 1000;
person.position.set(0, 0, 0); person.yaw = Math.PI;

const report = { asset, stridePhases: Object.fromEntries(person.stridePhases), transitions: [], maximumTurnRate: 0,
  maximumAcceleration: 0, maximumLean: 0 };
const wrap = value => THREE.MathUtils.euclideanModulo(value + .5, 1) - .5;
function advance(frames, pressed, dt = 1 / 120) {
  for (let frame = 0; frame < frames; frame++) {
    person.idleMotion.restore();
    const before = person.activeAction;
    person.updateWalking(dt, new Set(pressed));
    const after = person.activeAction;
    if (before !== after && ['Walk', 'Run'].includes(before.getClip().name) && ['Walk', 'Run'].includes(after.getClip().name)) {
      const phaseBefore = before.time / before.getClip().duration - person.stridePhases.get(before.getClip().name);
      const phaseAfter = after.time / after.getClip().duration - person.stridePhases.get(after.getClip().name);
      const error = Math.abs(wrap(phaseAfter - phaseBefore));
      assert.ok(error < 1e-9, 'A gait change retains the same supporting-leg phase');
      report.transitions.push({ from: before.getClip().name, to: after.getClip().name, phaseError: error });
    }
    person.mixer.update(dt);
    person.idleMotion.update(dt, person.speed < .1, false, 0, person.locomotion);
    report.maximumTurnRate = Math.max(report.maximumTurnRate, Math.abs(person.locomotion.turnRate));
    report.maximumAcceleration = Math.max(report.maximumAcceleration, Math.abs(person.locomotion.acceleration));
    report.maximumLean = Math.max(report.maximumLean, Math.abs(person.idleMotion.travelRoll));
    assert.ok(person.position.toArray().every(Number.isFinite), 'Motion remains finite');
    assert.ok(Math.abs(person.locomotion.turnRate) <= 5.8 + 1e-6, 'Turning remains bounded');
    assert.ok(Math.abs(person.idleMotion.travelRoll) <= .12 + 1e-6, 'Cornering lean stays restrained');
  }
}
advance(120, ['w']);
assert.ok(Math.abs(person.speed - 1.65) < 1e-9, 'Walking reaches its authored speed');
advance(120, ['w', 'shift']);
assert.equal(person.activeAction.getClip().name, 'Run');
assert.ok(Math.abs(person.speed - 4.3) < 1e-9, 'Running reaches its authored speed');
advance(60, ['d', 'shift']);
advance(120, ['d']);
assert.equal(person.activeAction.getClip().name, 'Walk');
advance(120, []);
assert.equal(person.speed, 0, 'Stopping settles exactly with no residual drift');
assert.equal(person.activeAction.getClip().name, 'Idle');
advance(90, ['a']); advance(90, ['d']); advance(120, []);
assert.ok(report.transitions.some(t => t.from === 'Walk' && t.to === 'Run'));
assert.ok(report.transitions.some(t => t.from === 'Run' && t.to === 'Walk'));
assert.ok(report.maximumLean > .01, 'A running corner visibly transfers weight through the torso');

// Exercise the complete controller on the shipped rig, including the mixer:
// freezing just the procedural hand gestures would leave the clip's arm sway.
const handBones = [], armBones = [];
person.model.traverse(object => {
  if (!object.isBone) return;
  if (/(?:Left|Right)Hand$/.test(object.name)) handBones.push(object);
  if (/(?:Left|Right)(?:Arm|ForeArm)$/.test(object.name)) armBones.push(object);
});
assert.equal(handBones.length, 2);
const parkedCar = new THREE.Vector3(1000, 0, 1000), keys = new Set();
const frame = () => person.update(1 / 60, keys, parkedCar, 0, 0, []);
for (let i = 0; i < 180; i++) frame();
const positions = handBones.map(bone => bone.getWorldPosition(new THREE.Vector3()));
const rotations = handBones.map(bone => bone.getWorldQuaternion(new THREE.Quaternion()).normalize());
report.standingHands = { seconds: 30, maximumPositionChange: 0, maximumRotationChange: 0 };
for (let i = 0; i < 1800; i++) {
  frame();
  handBones.forEach((bone, index) => {
    report.standingHands.maximumPositionChange = Math.max(report.standingHands.maximumPositionChange,
      positions[index].distanceTo(bone.getWorldPosition(new THREE.Vector3())));
    report.standingHands.maximumRotationChange = Math.max(report.standingHands.maximumRotationChange,
      rotations[index].angleTo(bone.getWorldQuaternion(new THREE.Quaternion()).normalize()));
  });
}
assert.ok(report.standingHands.maximumPositionChange < 1e-6 && report.standingHands.maximumRotationChange < 1e-6,
  `Both hands remain still for thirty seconds after stopping: ${JSON.stringify(report.standingHands)}`);
report.armSwing = {};
for (const name of ['Walk', 'Run']) {
  keys.add('w'); if (name === 'Run') keys.add('shift');
  const before = armBones.map(bone => bone.quaternion.clone());
  let maximumChange = 0;
  for (let i = 0; i < 120; i++) {
    frame();
    armBones.forEach((bone, index) => { maximumChange = Math.max(maximumChange, before[index].angleTo(bone.quaternion)); });
  }
  assert.equal(person.activeAction.getClip().name, name);
  assert.ok(maximumChange > .05, `${name}: arms continue to animate while moving`);
  report.armSwing[name] = maximumChange;
}
person.idleMotion.restore(); person.idleMotion.update(1 / 60, false, true);
assert.equal(person.idleMotion.travelRoll, 0, 'Entering a vehicle immediately clears cornering lean');
assert.equal(person.idleMotion.travelPitch, 0, 'Entering a vehicle immediately clears acceleration lean');
await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
