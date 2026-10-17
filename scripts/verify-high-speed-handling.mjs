import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile('lib/vehicle-dynamics.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { stepVehicle, PLAYER_STEERING_ASSIST } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const dt = 1 / 120;
const road = [.95, .95, .95, .95];
const contactsFor = grips => grips.map(grip => ({ height: .009, grip, coverage: grip < .4 ? 1 : 0, depth: 0 }));
const state = kmh => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -kmh / 3.6), yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 });
const command = extra => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, steeringAssist: PLAYER_STEERING_ASSIST, ...extra });
const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const heading = motion => Math.atan2(-motion.velocity.x, -motion.velocity.z);
function simulate(kmh, inputAt, seconds, grips = road, beforeStep = () => {}) {
  const motion = state(kmh), contacts = contactsFor(grips), samples = [];
  let peakG = 0, peakFastG = 0, peakJerk = 0, peakSlip = 0, peakYawStep = 0, lastAcceleration = 0;
  for (let tick = 0; tick < Math.round(seconds / dt); tick++) {
    const t = tick * dt;
    beforeStep(motion, t);
    const oldHeading = heading(motion), oldSpeed = motion.velocity.length(), oldYawRate = motion.yawRate;
    stepVehicle(motion, command(inputAt(t)), contacts, dt);
    const speed = motion.velocity.length();
    const acceleration = angleDifference(heading(motion), oldHeading) * (oldSpeed + speed) / (2 * dt);
    const longitudinal = -motion.velocity.x * Math.sin(motion.yaw) - motion.velocity.z * Math.cos(motion.yaw);
    const lateral = -motion.velocity.x * Math.cos(motion.yaw) + motion.velocity.z * Math.sin(motion.yaw);
    const slip = speed > 3 ? Math.abs(Math.atan2(lateral, Math.abs(longitudinal))) : 0;
    peakG = Math.max(peakG, Math.abs(acceleration) / 9.81);
    if (speed >= 180 / 3.6) peakFastG = Math.max(peakFastG, Math.abs(acceleration) / 9.81);
    peakJerk = Math.max(peakJerk, Math.abs(acceleration - lastAcceleration) / dt);
    peakSlip = Math.max(peakSlip, slip);
    peakYawStep = Math.max(peakYawStep, Math.abs(motion.yawRate - oldYawRate));
    lastAcceleration = acceleration;
    assert.ok([motion.yaw, motion.yawRate, motion.steeringAngle, ...motion.position.toArray(), ...motion.velocity.toArray()].every(Number.isFinite), 'Handling stays finite');
    assert.ok(speed <= oldSpeed + 1e-8, 'Coasting and braking cannot create speed');
    samples.push({ t, speed, yaw: motion.yaw, yawRate: motion.yawRate, steering: motion.steeringAngle, acceleration });
  }
  return { motion, samples, peakG, peakFastG, peakJerk, peakSlipDegrees: peakSlip * 180 / Math.PI, peakYawStep };
}
const roundedMetrics = result => Object.fromEntries(['peakG', 'peakFastG', 'peakJerk', 'peakSlipDegrees', 'peakYawStep'].map(key => [key, +result[key].toFixed(5)]));
const sweeps = [];
for (const kmh of [80, 100, 140, 180, 220, 352]) {
  const turn = simulate(kmh, () => ({ steer: 1 }), 1);
  const right = simulate(kmh, () => ({ steer: -1 }), 1);
  assert.ok(Math.abs(turn.motion.yaw + right.motion.yaw) < 1e-10 && Math.abs(turn.motion.position.x + right.motion.position.x) < 1e-10, 'Left and right handling match');
  assert.ok(turn.peakSlipDegrees < 2, 'A regular road turn stays planted');
  const correction = simulate(kmh, t => ({ steer: t < .2 ? 0 : t < .6 ? 1 : t < 1 ? -1 : 0 }), 2);
  const afterRelease = correction.samples.filter(sample => sample.t >= 1);
  assert.ok(afterRelease.every(sample => sample.yawRate < .0001), 'A released right turn does not swing back left');
  assert.ok(Math.abs(correction.motion.yawRate) < .0001, 'Neutral steering settles to straight travel');
  if (kmh >= 180) {
    assert.ok(turn.peakG < 2.15, 'High-speed road turns stay around 1.5–2 g');
    assert.ok(correction.peakJerk < 230 && correction.peakYawStep < .04, 'Countersteering follows a smooth arc');
    const reversed = correction.samples.find(sample => sample.t >= .6 && sample.yawRate < 0);
    assert.ok(reversed && reversed.t - .6 >= .075 && reversed.t - .6 < .3, 'High-speed countersteering reverses progressively and remains responsive');
  }
  sweeps.push({ kmh, fullTurn: roundedMetrics(turn), correction: roundedMetrics(correction) });
}
for (const kmh of [220, 352]) {
  const straight = simulate(kmh, () => ({}), 5);
  assert.equal(straight.motion.position.x, 0, 'Straight driving has no lateral wander');
  assert.equal(straight.motion.yawRate, 0, 'Straight driving has no spontaneous yaw');
  const release = simulate(kmh, t => ({ steer: t < .5 ? 1 : 0 }), 2);
  assert.ok(release.samples.filter(sample => sample.t >= .5).every(sample => sample.yawRate > -.0001), 'Releasing left steering does not swing right');
  const braking = simulate(kmh, () => ({ steer: 1, brake: 1 }), 20);
  assert.equal(braking.motion.velocity.length(), 0, 'A high-speed brake turn comes to a complete stop');
  assert.equal(braking.motion.yawRate, 0, 'A brake turn settles without spinning at rest');
  assert.ok(braking.peakFastG < 2.2 && braking.peakSlipDegrees < 2, 'High-speed braking and turning stay planted');
  sweeps.push({ kmh, brakeTurn: roundedMetrics(braking) });
}
const mixed = [];
for (const grips of [[.95, .6, .95, .6], [.95, .95, .32, .32], [.32, .32, .32, .32], [.95, .32, .95, .32]]) {
  const result = simulate(352, t => ({ steer: t < 1 ? 1 : t < 1.6 ? -1 : 0 }), 3, grips);
  assert.ok(result.peakFastG < 2.2, 'Mixed traction does not request excessive high-speed cornering');
  if (grips[1] >= .6 || grips[0] === .95 && grips[1] === .95) assert.ok(result.peakSlipDegrees < 2, 'Balanced and partial mixed traction stay planted');
  // Pure snow and front road/rear pure snow can physically slide: retain reduced grip.
  mixed.push({ grips, ...roundedMetrics(result) });
}
for (const centerKmh of [80, 180]) {
  const varied = simulate(centerKmh, () => ({ steer: 1 }), 6, road, (motion, t) => {
    motion.velocity.setLength((centerKmh + 2 * Math.sin(t * Math.PI)) / 3.6);
  });
  const settled = varied.samples.filter(sample => sample.t >= 2);
  assert.ok(settled.every(sample => sample.yawRate > 0), 'Crossing speed thresholds does not reverse yaw');
  const largestStep = Math.max(...settled.slice(1).map((sample, i) => Math.abs(sample.yawRate - settled[i].yawRate)));
  assert.ok(largestStep < .003, 'Small speed changes across thresholds do not cause steering jumps');
}
console.log(JSON.stringify({ sweeps, mixed, passed: 'Straight tracking, tap/counter/release, full turns, brake stops, mixed grip, threshold continuity and left/right symmetry.' }, null, 2));
