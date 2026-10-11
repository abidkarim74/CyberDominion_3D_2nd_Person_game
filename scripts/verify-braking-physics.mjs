import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile('lib/vehicle-dynamics.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { stepVehicle } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const surface = snow => Array.from({ length: 4 }, () => ({ height: .009, grip: snow ? .32 : .95, coverage: snow ? 1 : 0, depth: snow ? .1 : 0 }));
const state = speed => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -speed), yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 });
const input = (extra = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...extra });
function run(speed, command, seconds, snowy = false) {
  const m = state(speed), contacts = surface(snowy);
  let peakSlip = 0, peakSpeed = speed, minimumLongitudinal = speed;
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    stepVehicle(m, command, contacts, 1 / 120);
    const u = -m.velocity.x * Math.sin(m.yaw) - m.velocity.z * Math.cos(m.yaw);
    const v = -m.velocity.x * Math.cos(m.yaw) + m.velocity.z * Math.sin(m.yaw);
    if (m.velocity.length() > 3) peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(v, Math.abs(u))));
    peakSpeed = Math.max(peakSpeed, m.velocity.length()); minimumLongitudinal = Math.min(minimumLongitudinal, u);
    assert.ok([m.yaw, m.yawRate, ...m.velocity.toArray(), ...m.position.toArray()].every(Number.isFinite), 'The simulation stays finite');
  }
  return { m, peakSlip, peakSpeed, minimumLongitudinal };
}
function stop(kmh, handbrake = false, snowy = false) {
  const m = state(kmh / 3.6), contacts = surface(snowy);
  let seconds = 0;
  while (m.velocity.length() > .05 && seconds < 35) {
    stepVehicle(m, input({ brake: handbrake ? 0 : 1, handbrake }), contacts, 1 / 120);
    seconds += 1 / 120;
  }
  return { kmh, handbrake, snowy, seconds, distance: m.position.length(), finalSpeed: m.velocity.length() };
}
const stops = [stop(100), stop(220), stop(100, true), stop(100, false, true)];
const normal = run(20, input({ steer: .65 }), 1.2);
const drift = run(20, input({ steer: .65, handbrake: true }), 1.2);
const brakeTurn = run(20, input({ steer: .65, brake: 1 }), 1.2);
const rightDrift = run(20, input({ steer: -.65, handbrake: true }), 1.2);
const snowyTurn = run(6, input({ throttle: 1, steer: 1 }), 2, true);
const heldStop = run(20, input({ brake: 1 }), 10);
const reverse = run(0, input({ throttle: -1 }), 3);
const standing = run(0, input({ steer: 1, handbrake: true }), 3);
const coast = run(20, input(), 2);
const brakeInputResponse = [];
for (const [speed, minimumYaw, minimumTravel] of [[10, .120, .116], [20, .082, .074], [35, .065, .055], [60, .044, .037]]) {
  const left = run(speed, input({ brake: 1, steer: 1, throttle: 1 }), .125);
  const right = run(speed, input({ brake: 1, steer: -1, throttle: 1 }), .125);
  const travel = Math.atan2(-left.m.velocity.x, -left.m.velocity.z);
  const onsetYaw = left.m.yaw;
  assert.ok(left.m.yaw > minimumYaw && travel > minimumTravel, 'A short brake-and-steer input promptly redirects heading and travel');
  assert.ok(left.m.velocity.length() < speed - .8, 'A sharp turn still brakes strongly with the accelerator held');
  assert.ok(Math.abs(left.m.yaw + right.m.yaw) < 1e-8 && Math.abs(left.m.position.x + right.m.position.x) < 1e-8, 'Left and right brake turns respond equally');
  const m = left.m;
  for (let i = 0; i < 12; i++) stepVehicle(m, input({ brake: 1, steer: -1 }), surface(false), 1 / 120);
  const counterTravel = Math.atan2(-m.velocity.x, -m.velocity.z) - travel;
  assert.ok(m.yawRate < 0 && counterTravel < 0, 'Countersteering while braking redirects momentum within 100 ms');
  brakeInputResponse.push({ kmh: speed * 3.6, onsetYawDegrees: onsetYaw * 180 / Math.PI, onsetTravelDegrees: travel * 180 / Math.PI, counterTravelDegrees: counterTravel * 180 / Math.PI });
}
const report = {
  stops,
  brakeInputResponse,
  cornering: { normalSlipDeg: normal.peakSlip * 180 / Math.PI, driftSlipDeg: drift.peakSlip * 180 / Math.PI, brakeTurnSlipDeg: brakeTurn.peakSlip * 180 / Math.PI, brakeTurnYaw: brakeTurn.m.yaw, normalYaw: normal.m.yaw, driftYaw: drift.m.yaw, driftSpeed: drift.m.velocity.length(), snowYaw: snowyTurn.m.yaw, snowX: snowyTurn.m.position.x },
  heldBrakeSpeed: heldStop.m.velocity.length(), reverseSpeed: reverse.m.velocity.length(), coastSpeed: coast.m.velocity.length(),
};
console.log(JSON.stringify(report, null, 2));
assert.ok(stops[0].seconds < 2.3 && stops[0].distance < 32, '100 km/h service braking stops promptly within 32 meters');
assert.ok(stops[1].seconds < 4.7 && stops[1].distance < 140 && stops[1].finalSpeed === 0, 'Braking stops the car promptly from its maximum speed');
assert.ok(stops[2].seconds < 2.7 && stops[2].distance < 38, 'The drift brake provides strong deceleration');
assert.ok(stops[3].distance > stops[0].distance * 2, 'Snow retains a physically longer stopping distance');
assert.ok(normal.peakSlip < .06, 'A normal road turn stays planted instead of drifting');
assert.ok(drift.peakSlip > .25 && drift.peakSlip > normal.peakSlip * 2, 'Rear lock produces an actual momentum slide while steering');
assert.ok(drift.m.yaw > 0 && rightDrift.m.yaw < 0, 'Drifts follow the requested steering direction');
assert.ok(brakeTurn.m.yaw > .7 && brakeTurn.peakSlip < .15 && brakeTurn.m.velocity.length() < normal.m.velocity.length(), 'Service brakes allow a sharp, stable turn while slowing');
assert.ok(Math.abs(drift.m.yaw + rightDrift.m.yaw) < 1e-8 && Math.abs(drift.m.position.x + rightDrift.m.position.x) < 1e-8, 'Left and right drifts are symmetric');
assert.equal(heldStop.m.velocity.length(), 0, 'Holding the pedal keeps the car stopped');
assert.ok(heldStop.minimumLongitudinal >= -1e-8, 'Brakes never accidentally engage reverse');
assert.ok(reverse.m.velocity.z > 1, 'Reverse remains available from rest');
assert.equal(standing.m.yaw, 0, 'A stationary car cannot rotate');
assert.ok(normal.peakSpeed <= 20 + 1e-6 && coast.m.velocity.length() < 20, 'Coasting and cornering cannot manufacture energy');
for (const speed of [10, 20, 35, 60]) {
  for (const steer of [-1, 1]) {
    const turningStop = run(speed, input({ brake: 1, steer }), 10);
    assert.equal(turningStop.m.velocity.length(), 0, 'Holding full brake and steer reaches a complete stop');
    assert.equal(turningStop.m.yawRate, 0, 'A brake-and-steer stop cannot keep spinning at rest');
    assert.ok(turningStop.peakSpeed <= Math.abs(speed) + 1e-6, 'Service braking cannot manufacture speed during a turn');
    assert.ok(turningStop.peakSlip < .18, 'Full steering under ABS stays stable through the entire stop');
  }
}
const reverseStop = run(-15, input({ brake: 1, steer: 1 }), 10);
assert.equal(reverseStop.m.velocity.length(), 0, 'Braking while steering also stops reverse travel');
assert.equal(reverseStop.m.yawRate, 0, 'A reverse brake stop settles without spinning');
for (const command of [input({ throttle: 1 }), input({ handbrake: true, steer: .5 }), input({ brake: 1 }), input({ brake: 1, steer: 1 })]) {
  const results = [30, 60, 144].map(fps => {
    const m = state(20); let accumulator = 0;
    for (let frame = 0; frame < fps * 3; frame++) {
      accumulator += 1 / fps;
      while (accumulator + 1e-9 >= 1 / 120) { stepVehicle(m, command, surface(false), 1 / 120); accumulator = Math.max(0, accumulator - 1 / 120); }
    }
    return m;
  });
  for (const m of results) assert.ok(m.position.distanceTo(results[0].position) < 1e-8 && Math.abs(m.yaw - results[0].yaw) < 1e-8, 'Handling is independent of render frame rate');
}
const top = run(0, input({ throttle: 1, boost: true }), 90);
assert.ok(top.peakSpeed <= 220 / 3.6 + 1e-6 && top.m.velocity.length() * 3.6 > 219.9, 'The existing top speed is preserved');
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/braking-physics-verification.json', JSON.stringify(report, null, 2));
