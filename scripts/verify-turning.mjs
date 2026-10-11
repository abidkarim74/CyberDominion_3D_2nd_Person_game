import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile('lib/vehicle-dynamics.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { stepVehicle } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const surface = snowy => Array.from({ length: 4 }, () => ({ height: .009, grip: snowy ? .32 : .95, coverage: snowy ? 1 : 0, depth: snowy ? .1 : 0 }));
const state = speed => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -speed), yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 });
function turn(speed, steer = 1, snowy = false) {
  const m = state(speed);
  for (let i = 0; i < 120; i++) stepVehicle(m, { throttle: 0, steer, handbrake: false, boost: false }, surface(snowy), 1 / 120);
  return m;
}
const handling = [];
for (const speed of [4, 10, 20, 35, 60]) {
  const left = turn(speed), right = turn(speed, -1);
  assert.ok(left.yaw > .04 && left.position.x < -.05, 'Moving cars respond to steering');
  assert.ok(Math.abs(left.yaw + right.yaw) < 1e-8 && Math.abs(left.position.x + right.position.x) < 1e-8, 'Normal steering is symmetric');
  assert.ok(left.velocity.length() <= speed && left.velocity.length() > speed * .5, 'Cornering dissipates tire energy without an artificial speed boost or a stall');
  const yawAtRelease = left.yaw;
  for (let i = 0; i < 60; i++) stepVehicle(left, { throttle: 0, steer: 0, handbrake: false, boost: false }, surface(false), 1 / 120);
  assert.ok(Math.abs(left.steeringAngle) < .001, 'Front wheels recenter promptly when steering is released');
  const yawRateBeforeCountersteer = left.yawRate;
  for (let i = 0; i < 36; i++) stepVehicle(left, { throttle: 0, steer: -1, handbrake: false, boost: false }, surface(false), 1 / 120);
  assert.ok(left.yawRate < yawRateBeforeCountersteer, 'Countersteering applies a correcting yaw moment');
  handling.push({ kmh: speed * 3.6, yawAtRelease, speedAfterCountersteer: left.velocity.length() * 3.6, yawRateBeforeCountersteer, yawRateAfterCountersteer: left.yawRate });
}
const low = turn(4), high = turn(60);
assert.ok(turn(20).yaw > .84, 'At 72 km/h full steering gives a strong road turn within one second');
assert.ok(turn(35).yaw > .66 && high.yaw > .46, 'Steering retains useful authority at cruising and maximum speed');
const lowTravelAngle = Math.abs(Math.atan2(-low.velocity.x, -low.velocity.z));
const highTravelAngle = Math.abs(Math.atan2(-high.velocity.x, -high.velocity.z));
assert.ok(highTravelAngle < lowTravelAngle * .5, 'Responsive high-speed steering still requires a substantially wider turn');
const snow = turn(10, 1, true), dry = turn(10);
assert.ok(Math.abs(snow.velocity.x) < Math.abs(dry.velocity.x), 'Snow provides less authority to redirect momentum');
const reverse = state(-6);
for (let i = 0; i < 60; i++) stepVehicle(reverse, { throttle: -1, steer: 1, handbrake: false, boost: false }, surface(false), 1 / 120);
assert.ok(reverse.yaw < -.2 && reverse.position.z > 1, 'Reverse steering turns in the opposite direction');
// Measure both heading and actual travel after the car is already accelerating.
// A yaw-only check can pass while momentum continues almost straight.
const inputResponse = [];
for (const boost of [false, true]) {
  for (const [speed, minimumYaw, minimumTravel] of [[10, .135, .130], [20, .132, .120], [35, .108, .099], [60, .073, .067]]) {
    const m = state(speed), contacts = surface(false);
    const command = steer => ({ throttle: 1, steer, handbrake: false, boost });
    for (let i = 0; i < 30; i++) stepVehicle(m, command(0), contacts, 1 / 120);
    const startingKmh = m.velocity.length() * 3.6;
    for (let i = 0; i < 15; i++) stepVehicle(m, command(1), contacts, 1 / 120);
    const onsetYaw = m.yaw, onsetTravel = Math.atan2(-m.velocity.x, -m.velocity.z);
    assert.ok(onsetYaw > minimumYaw, `A 125 ms steering input changes heading at ${startingKmh.toFixed(1)} km/h with boost ${boost}`);
    assert.ok(onsetTravel > minimumTravel, 'The tires promptly redirect travel as well as the visible car');
    assert.ok(Math.abs(onsetYaw - onsetTravel) < .02, 'Actual travel follows the heading during a short steering tap');
    for (let i = 0; i < 45; i++) stepVehicle(m, command(1), contacts, 1 / 120);
    const travelBeforeCountersteer = Math.atan2(-m.velocity.x, -m.velocity.z);
    for (let i = 0; i < 6; i++) stepVehicle(m, command(-1), contacts, 1 / 120);
    const countersteerRate = m.yawRate;
    const countersteerTravel = Math.atan2(-m.velocity.x, -m.velocity.z) - travelBeforeCountersteer;
    assert.ok(countersteerRate < 0, 'Countersteering reverses the turn within 50 ms while accelerating');
    assert.ok(countersteerTravel < -.005, 'Countersteering redirects momentum within the same 50 ms input');
    for (let i = 0; i < 24; i++) stepVehicle(m, command(0), contacts, 1 / 120);
    assert.ok(Math.abs(m.yawRate) < .03, 'Releasing steering settles body rotation within 200 ms with the accelerator held');
    inputResponse.push({ startingKmh, boost, onsetYawDegrees: onsetYaw * 180 / Math.PI, onsetTravelDegrees: onsetTravel * 180 / Math.PI, countersteerRate, countersteerTravelDegrees: countersteerTravel * 180 / Math.PI, releasedYawRate: m.yawRate });
  }
}
const result = { handling, inputResponse, lowTravelAngle, highTravelAngle, reverseYaw: reverse.yaw };
console.log(JSON.stringify(result, null, 2));
await writeFile('artifacts/turning-verification.json', JSON.stringify(result, null, 2));
