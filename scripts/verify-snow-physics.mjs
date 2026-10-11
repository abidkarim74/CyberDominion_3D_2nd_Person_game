import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
const source = await readFile('lib/vehicle-dynamics.ts', 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { stepVehicle, MAX_SPEED_KMH } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
const surface = (snow) =>
  Array.from({ length: 4 }, () => ({
    x: 0,
    z: 0,
    height: snow ? 0.14 : 0.009,
    coverage: snow ? 1 : 0,
    depth: snow ? 0.33 : 0,
    grip: snow ? 0.32 : 0.95,
  }));
const state = () => ({
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  yaw: 0,
  yawRate: 0,
  steeringAngle: 0,
  acceleration: 0,
  grip: 1,
  snow: 0,
});
const input = (throttle = 0, steer = 0, handbrake = false, boost = false) => ({
  throttle,
  steer,
  handbrake,
  boost,
});
function drive(snow, seconds, command, initialSpeed = 0, frameRate = 60) {
  const motion = state();
  motion.velocity.z = -initialSpeed;
  for (let frame = 0; frame < seconds * frameRate; frame++)
    for (let sub = 0; sub < 120 / frameRate; sub++)
      stepVehicle(motion, command, surface(snow), 1 / 120);
  return motion;
}
const dry = drive(false, 4, input(1)),
  snow = drive(true, 4, input(1));
assert.ok(
  snow.velocity.length() < dry.velocity.length() * 0.6,
  'Snow traction and rolling resistance reduce acceleration',
);
assert.ok(
  dry.acceleration <= 0.95 * 9.81 + 1e-6 &&
    snow.acceleration <= 0.32 * 9.81 + 1e-6,
  'Wheel forces stay within friction limits',
);
function brake(snow) {
  const m = state();
  m.velocity.z = -12;
  let frames = 0;
  while (-m.velocity.z > 0.5 && frames++ < 2400)
    stepVehicle(m, input(-1), surface(snow), 1 / 120);
  return {
    distance: -m.position.z,
    seconds: frames / 120,
    speed: m.velocity.length(),
  };
}
const dryBraking = brake(false),
  snowBraking = brake(true);
assert.ok(
  snowBraking.distance > dryBraking.distance * 1.6,
  'Snow has a meaningfully longer braking distance',
);
const stopped = drive(false, 3, input(0, 1));
assert.equal(stopped.yaw, 0, 'A stationary car cannot turn in place');
const coast = drive(false, 5, input(), 12);
assert.ok(coast.velocity.length() < 12, 'Coasting loses energy');
const reverse = drive(true, 3, input(-1));
assert.ok(reverse.velocity.z > 1, 'Reverse works on snow');
const at10 = drive(true, 5, input(1, 0.35), 0, 10),
  at30 = drive(true, 5, input(1, 0.35), 0, 30),
  at120 = drive(true, 5, input(1, 0.35), 0, 120);
assert.ok(
  at10.position.distanceTo(at120.position) < 0.005 &&
    at30.position.distanceTo(at120.position) < 0.005,
  'Physics is consistent at 10, 30, and 120 render FPS',
);
const lateralDry = state(),
  lateralSnow = state();
lateralDry.velocity.set(3, 0, -10);
lateralSnow.velocity.copy(lateralDry.velocity);
for (let i = 0; i < 60; i++) {
  stepVehicle(lateralDry, input(), surface(false), 1 / 120);
  stepVehicle(lateralSnow, input(), surface(true), 1 / 120);
}
assert.ok(
  Math.abs(lateralSnow.velocity.x) > Math.abs(lateralDry.velocity.x) + 0.1,
  'Snow preserves more sideways slip',
);
const dryTurn = drive(false, 2, input(1, 1), 10);
const rightTurn = drive(false, 2, input(1, -1), 10);
const snowTurn = drive(true, 2, input(1, 1), 6);
const quickTurn = drive(false, 0.3, input(0, 1), 4);
assert.ok(
  dryTurn.yaw > 0.65 && quickTurn.yaw > 0.09,
  'Steering responds promptly at low speed and while accelerating',
);
assert.ok(
  snowTurn.yaw > 0.4 && snowTurn.position.x < -2 && snowTurn.velocity.length() < dryTurn.velocity.length(),
  'Accelerating on snow leaves enough grip to follow a turn',
);
assert.ok(
  Math.abs(dryTurn.yaw + rightTurn.yaw) < 1e-8 &&
    Math.abs(dryTurn.position.x + rightTurn.position.x) < 1e-8,
  'Left and right steering respond equally',
);
const topSpeeds = [];
for (const boost of [false, true]) {
  const m = state();
  let peakKmh = 0;
  for (let i = 0; i < 90 * 120; i++) {
    stepVehicle(m, input(1, 0, false, boost), surface(false), 1 / 120);
    peakKmh = Math.max(peakKmh, m.velocity.length() * 3.6);
    assert.ok(peakKmh <= 220 + 1e-6, 'Forward speed never exceeds 220 km/h');
  }
  assert.ok(m.velocity.length() * 3.6 > 219.9, 'The car can reach 220 km/h');
  topSpeeds.push({ boost, finalKmh: m.velocity.length() * 3.6, peakKmh });
}
assert.equal(MAX_SPEED_KMH, 220);
const result = {
  steering: {
    dryTurnDegrees: (dryTurn.yaw * 180) / Math.PI,
    snowTurnDegrees: (snowTurn.yaw * 180) / Math.PI,
    quickTurnDegrees: (quickTurn.yaw * 180) / Math.PI,
  },
  topSpeeds,
  drySpeed: dry.velocity.length(),
  snowSpeed: snow.velocity.length(),
  dryBraking,
  snowBraking,
  stationaryYaw: stopped.yaw,
  reverseSpeed: reverse.velocity.length(),
  frameRatePositionDifference: at30.position.distanceTo(at120.position),
  dryLateralSpeed: lateralDry.velocity.x,
  snowLateralSpeed: lateralSnow.velocity.x,
};
await writeFile(
  'artifacts/snow-physics-verification.json',
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
