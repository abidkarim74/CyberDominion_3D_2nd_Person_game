import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

await mkdir('artifacts', { recursive: true });
for (const name of ['cockpit-steering', 'person-steering-motion']) {
  await writeFile(`artifacts/${name}-compiled.mjs`, ts.transpileModule(await readFile(`lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText);
}
const { CockpitSteering } = await import('../artifacts/cockpit-steering-compiled.mjs');
const { PersonSteeringMotion } = await import('../artifacts/person-steering-motion-compiled.mjs');
const report = {};
const advance = (controller, duration, target, fps = 60) => {
  let elapsed = 0;
  while (elapsed < duration - 1e-12) {
    const delta = Math.min(1 / fps, duration - elapsed);
    controller.update(delta, target); elapsed += delta;
  }
};

const step = new CockpitSteering();
let first = 0, t90 = 0, previous = 0, maximumSpeed = 0, maximumAcceleration = 0;
for (let frame = 1; frame <= 360; frame++) {
  const velocityBefore = step.velocity;
  step.update(1 / 240, 1);
  if (frame === 4) first = step.angle;
  if (!t90 && step.angle >= 1.18 * .9) t90 = frame / 240;
  assert.ok(step.angle >= previous - 1e-12 && step.angle <= 1.18, 'A sustained input approaches its lock monotonically');
  maximumSpeed = Math.max(maximumSpeed, Math.abs(step.velocity));
  maximumAcceleration = Math.max(maximumAcceleration, Math.abs(step.velocity - velocityBefore) * 240);
  previous = step.angle;
}
assert.ok(first > 0 && first < .02, 'A key press begins with a small turn instead of jumping toward full lock');
assert.ok(t90 >= .25 && t90 <= .4, 'The wheel reaches 90% lock in a responsive quarter to four-tenths of a second');
assert.ok(Math.abs(step.angle - 1.18) < 1e-6 && Math.abs(step.velocity) < 1e-5, 'A held turn settles without oscillation');
assert.ok(maximumSpeed <= 5.6 + 1e-9 && maximumAcceleration <= 85 + 1e-8, 'Steering rate and acceleration remain bounded');
report.step = { firstFrameAngle: first, secondsTo90Percent: t90, maximumSpeed, maximumAcceleration, settledAngle: step.angle };

report.frameRates = [];
for (const fps of [30, 60, 120, 144]) {
  const controller = new CockpitSteering(), checkpoints = [];
  for (const target of [1, -1, 0]) for (let sample = 0; sample < 10; sample++) {
    advance(controller, .05, target, fps); checkpoints.push(controller.angle, controller.velocity);
  }
  report.frameRates.push({ fps, checkpoints });
}
for (const sample of report.frameRates.slice(1)) {
  sample.maximumDifference = Math.max(...sample.checkpoints.map((value, i) => Math.abs(value - report.frameRates[0].checkpoints[i])));
  assert.ok(sample.maximumDifference < 1e-9, '30, 60, 120 and 144 Hz give the same turn, reversal and return at equal elapsed time');
}

const reversal = new CockpitSteering();
advance(reversal, .15, 1);
const beforeReversal = { angle: reversal.angle, velocity: reversal.velocity };
reversal.update(1 / 60, -1);
const firstReversal = { angle: reversal.angle, velocity: reversal.velocity };
assert.ok(firstReversal.angle > beforeReversal.angle && firstReversal.velocity > 0 && firstReversal.velocity < beforeReversal.velocity,
  'Reversing input decelerates the turning wheel before changing direction');
assert.ok(Math.abs(firstReversal.velocity - beforeReversal.velocity) <= 85 / 60 + 1e-9,
  'A reversal cannot replace the existing angular velocity in one frame');
advance(reversal, .6, -1);
assert.ok(reversal.angle < -1.14, 'A sustained reversal approaches the opposite lock in under two-thirds of a second');
advance(reversal, .8, -1);
let lastAngle = reversal.angle;
for (let frame = 0; frame < 120; frame++) {
  reversal.update(1 / 120, 0);
  assert.ok(reversal.angle >= lastAngle - 1e-12 && reversal.angle <= 1e-9, 'Release returns to center without crossing or oscillating');
  lastAngle = reversal.angle;
}
assert.ok(Math.abs(reversal.angle) < 1e-4, 'Released steering settles at center');
report.reversal = { before: beforeReversal, nextFrame: firstReversal, returnedAngle: reversal.angle };

const robust = new CockpitSteering(), normalResume = new CockpitSteering();
robust.update(100, 1); normalResume.update(.1, 1);
assert.equal(robust.angle, normalResume.angle, 'Suspended-tab delta is limited to a small catch-up interval');
for (const delta of [NaN, Infinity, -1, 0]) {
  const before = [robust.angle, robust.velocity]; robust.update(delta, -1);
  assert.deepEqual([robust.angle, robust.velocity], before, 'Invalid or nonpositive time never moves the wheel');
}
robust.reset(); assert.deepEqual([robust.angle, robust.velocity], [0, 0], 'Reset clears the column angle and inertia');
advance(robust, 1, 100);
assert.ok(robust.angle <= 1.18 && robust.angle > 1.17, 'Out-of-range input is bounded by the physical lock');
advance(robust, 1, NaN);
assert.ok(Number.isFinite(robust.angle) && Math.abs(robust.angle) < 1e-4, 'Invalid input safely releases toward center');
let seed = 139, target = 0, peakRate = 0, peakAcceleration = 0;
robust.reset();
for (let frame = 0; frame < 4800; frame++) {
  if (frame % 31 === 0) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; target = (seed / 0xffffffff) * 4 - 2; }
  const before = robust.velocity;
  robust.update(1 / 240, target);
  assert.ok(Number.isFinite(robust.angle) && Math.abs(robust.angle) <= 1.18, 'Rapid arbitrary inputs stay finite and inside the steering stops');
  peakRate = Math.max(peakRate, Math.abs(robust.velocity));
  peakAcceleration = Math.max(peakAcceleration, Math.abs(robust.velocity - before) * 240);
}
assert.ok(peakRate <= 5.6 + 1e-9 && peakAcceleration <= 85 + 1e-8, 'Rapid reversals preserve rate and acceleration bounds');
report.robustness = { randomInputFrames: 4800, peakRate, peakAcceleration };

// A rotated, scaled cabin verifies that smoothing the real wheel also smooths
// the existing IK palms, without adding delayed hand targets that slide on it.
const cabin = new THREE.Group(), model = new THREE.Group(), column = new THREE.Group(), wheel = new THREE.Group();
cabin.position.set(8, .3, -9); cabin.rotation.set(.09, .47, -.07); cabin.scale.setScalar(.85);
column.position.set(0, 1, 0); column.rotation.x = -.17; column.add(wheel); cabin.add(column, model);
const arms = ['Left', 'Right'].map((side, index) => {
  const sign = index ? 1 : -1, upper = new THREE.Bone(), lower = new THREE.Bone(), hand = new THREE.Bone();
  upper.name = `mixamorig${side}Arm`; lower.name = `mixamorig${side}ForeArm`; hand.name = `mixamorig${side}Hand`;
  upper.position.set(sign * .22, 1.05, .35); lower.position.set(sign * .10, -.22, -.20); hand.position.set(-sign * .08, -.18, -.20);
  model.add(upper); upper.add(lower); lower.add(hand);
  for (const [finger, x, y, z] of [['Middle', 0, .09, 0], ['Index', -.025, .085, 0], ['Pinky', .025, .075, 0], ['Thumb', -.035, .035, .025]]) {
    const bone = new THREE.Bone(); bone.name = `mixamorig${side}Hand${finger}1`; bone.position.set(x, y, z); hand.add(bone);
  }
  return { upper, lower, hand, lengths: [lower.position.length(), hand.position.length()] };
});
cabin.updateMatrixWorld(true);
const solver = new PersonSteeringMotion(model, wheel), steering = new CockpitSteering();
let maximumGripError = 0, maximumPalmSpeed = 0, maximumArmFrameAngle = 0;
let previousPalms, previousRotations;
for (let frame = 0; frame < 180; frame++) {
  solver.restore(); wheel.rotation.z = steering.update(1 / 60, frame < 40 ? 1 : frame < 90 ? -1 : 0);
  cabin.updateMatrixWorld(true); solver.update(1);
  const diagnostics = solver.diagnostics;
  maximumGripError = Math.max(maximumGripError, diagnostics.maximumGripError);
  const palms = diagnostics.grips.map(grip => new THREE.Vector3(...grip.actual));
  const rotations = arms.flatMap(arm => [arm.upper, arm.lower].map(bone => bone.getWorldQuaternion(new THREE.Quaternion())));
  if (previousPalms) maximumPalmSpeed = Math.max(maximumPalmSpeed, ...palms.map((p, i) => p.distanceTo(previousPalms[i]) * 60));
  if (previousRotations) maximumArmFrameAngle = Math.max(maximumArmFrameAngle, ...rotations.map((q, i) => q.angleTo(previousRotations[i])));
  previousPalms = palms; previousRotations = rotations;
  for (const arm of arms) assert.deepEqual([arm.lower.position.length(), arm.hand.position.length()], arm.lengths,
    'Smoothed steering never stretches the character arms');
}
assert.ok(maximumGripError < 1e-7, 'Both palms remain attached to the smoothed real wheel without tracking lag');
assert.ok(maximumPalmSpeed < .8 && maximumArmFrameAngle < .35, 'Palms and elbows move continuously through turn, reversal and release');
report.hands = { maximumGripError, maximumPalmSpeed, maximumArmFrameAngle };
await writeFile('artifacts/cockpit-steering-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ step: report.step, frameRateDifference: Math.max(...report.frameRates.map(sample => sample.maximumDifference ?? 0)),
  reversal: report.reversal, robustness: report.robustness, hands: report.hands }, null, 2));
