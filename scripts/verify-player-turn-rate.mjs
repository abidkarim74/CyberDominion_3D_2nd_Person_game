import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const source = await readFile('lib/vehicle-dynamics.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { stepVehicle, PLAYER_STEERING_ASSIST, MAX_NITRO_SPEED_KMH } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const surface = grip => Array.from({ length: 4 }, () => ({ height: .009, grip, coverage: grip === .32 ? 1 : 0, depth: grip === .32 ? .1 : 0 }));
const state = speed => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -speed), yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 });
const command = extra => ({ throttle: 0, brake: 0, steer: 1, handbrake: false, boost: false, ...extra });
function advance(m, input, seconds, grip = .95) {
  let peakSlip = 0, peakSpeed = m.velocity.length();
  const contacts = surface(grip);
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    stepVehicle(m, input, contacts, 1 / 120);
    const longitudinal = -m.velocity.x * Math.sin(m.yaw) - m.velocity.z * Math.cos(m.yaw);
    const lateral = -m.velocity.x * Math.cos(m.yaw) + m.velocity.z * Math.sin(m.yaw);
    if (m.velocity.length() > 3) peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(lateral, Math.abs(longitudinal))));
    peakSpeed = Math.max(peakSpeed, m.velocity.length());
    assert.ok([m.yaw, m.yawRate, ...m.position.toArray(), ...m.velocity.toArray()].every(Number.isFinite), 'Steering stays finite');
  }
  return { peakSlip, peakSpeed };
}
const travelAngle = m => Math.atan2(-m.velocity.x, -m.velocity.z);
const handling = [];
for (const brake of [0, 1]) {
  for (const throttle of [0, 1]) {
    for (const speed of [20, 35, 60, MAX_NITRO_SPEED_KMH / 3.6]) {
      const baseline = state(speed), player = state(speed), right = state(speed);
      const boosting = speed > 220 / 3.6 && throttle > 0 && !brake;
      const nitro = { boost: boosting, boostTargetSpeed: boosting ? speed : 0 };
      const input = command({ brake, throttle, ...nitro, steeringAssist: PLAYER_STEERING_ASSIST });
      advance(baseline, command({ brake, throttle, ...nitro }), .125);
      const metrics = advance(player, input, .125);
      advance(right, { ...input, steer: -1 }, .125);
      const gain = player.yaw / baseline.yaw;
      assert.ok(gain > 1.25, 'Player steering provides at least 25% more heading change at road speed');
      assert.ok(travelAngle(player) > travelAngle(baseline) * 1.25, 'The tighter turn redirects actual momentum');
      assert.ok(Math.abs(player.yaw - travelAngle(player)) < .035, 'Body heading and actual travel remain close');
      assert.ok(Math.abs(player.yaw + right.yaw) < 1e-8 && Math.abs(player.position.x + right.position.x) < 1e-8, 'Left and right turns match');
      const onsetTravel = travelAngle(player);
      advance(player, { ...input, steer: -1 }, .05);
      assert.ok(player.yawRate < 0 && travelAngle(player) < onsetTravel, 'Countersteering changes heading and travel within 50 ms');
      advance(player, { ...input, steer: 0 }, .2);
      assert.ok(Math.abs(player.yawRate) < .03, 'Releasing steering settles the car within 200 ms');
      handling.push({ kmh: speed * 3.6, brake, throttle, boosting, gain, tapTravelDegrees: onsetTravel * 180 / Math.PI, peakSlipDegrees: metrics.peakSlip * 180 / Math.PI });
    }
  }
}
// Check long turns and complete stops, beyond the initial keyboard tap.
const sustainedTurns = [];
for (const speed of [10, 20, 35, 60, MAX_NITRO_SPEED_KMH / 3.6]) {
  for (const brake of [0, 1]) {
    const m = state(speed);
    const metrics = advance(m, command({ brake, steeringAssist: PLAYER_STEERING_ASSIST }), brake ? 20 : 2);
    assert.ok(metrics.peakSlip < .18, `Sustained turn at ${speed * 3.6} km/h, brake ${brake}, stays planted (slip ${metrics.peakSlip * 180 / Math.PI} degrees)`);
    assert.ok(metrics.peakSpeed <= speed + 1e-6, 'Steering and braking cannot create speed');
    if (brake) {
      assert.equal(m.velocity.length(), 0, 'Full brake and steer reach a complete stop');
      assert.equal(m.yawRate, 0, 'A stopped car does not spin');
    }
    sustainedTurns.push({ kmh: speed * 3.6, brake, peakSlipDegrees: metrics.peakSlip * 180 / Math.PI, finalSpeed: m.velocity.length() });
  }
}
// Parking, reverse, handbrake, and snow keep their existing handling.
for (const [speed, grip, extra] of [[0, .95, {}], [1, .95, {}], [-6, .95, { throttle: -1 }], [20, .32, {}], [20, .95, { handbrake: true }]]) {
  const baseline = state(speed), player = state(speed);
  advance(baseline, command(extra), 2, grip);
  advance(player, command({ ...extra, steeringAssist: PLAYER_STEERING_ASSIST }), 2, grip);
  assert.ok(baseline.position.distanceTo(player.position) < 1e-8 && Math.abs(baseline.yaw - player.yaw) < 1e-8, 'Assistance preserves parking, reverse, snow, and drift behavior');
}
// Render cadence must not change the stronger steering or direction switches.
const results = [30, 60, 144].map(fps => {
  const m = state(35); let accumulator = 0, tick = 0;
  for (let frame = 0; frame < fps * 3; frame++) {
    accumulator += 1 / fps;
    while (accumulator + 1e-9 >= 1 / 120) {
      advance(m, command({ steeringAssist: PLAYER_STEERING_ASSIST, steer: tick < 120 ? 1 : tick < 240 ? -1 : 0 }), 1 / 120);
      accumulator = Math.max(0, accumulator - 1 / 120); tick++;
    }
  }
  return m;
});
for (const m of results) assert.ok(m.position.distanceTo(results[0].position) < 1e-8 && Math.abs(m.yaw - results[0].yaw) < 1e-8, 'Player steering is independent of render frame rate');
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/player-turn-rate-verification.json', JSON.stringify({ handling, sustainedTurns }, null, 2));
console.log(JSON.stringify({ handling, sustainedTurns }, null, 2));
