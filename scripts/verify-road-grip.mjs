import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import * as THREE from 'three';

async function moduleUrl(path) {
  const source = await readFile(path, 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...js.matchAll(/from ['"]([^'"]+)['"]/g)]) {
    const specifier = match[1];
    const url = specifier.startsWith('.') ? await moduleUrl(resolve(dirname(path), specifier + '.ts')) : import.meta.resolve(specifier);
    js = js.replace(match[0], `from '${url}'`);
  }
  return 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
}
const { stepVehicle } = await import(await moduleUrl(resolve('lib/vehicle-dynamics.ts')));
const { createTireFeedback } = await import(await moduleUrl(resolve('lib/tire-feedback.ts')));
const { addRoadSkidMarks } = await import(await moduleUrl(resolve('lib/road-skid-marks.ts')));
const contacts = Array.from({ length: 4 }, (_, i) => ({ x: -22 + (i < 2 ? -.895 : .895), z: i % 2 ? 1.43 : -1.43, height: .009, grip: .95, coverage: 0, depth: 0 }));
const command = (extra = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...extra });
const handling = [];
for (const speed of [10, 20, 35, 60]) {
  for (const throttle of [0, 1]) {
    const motion = { position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -speed), yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 };
    let peakSlip = 0;
    for (let i = 0; i < 240; i++) {
      stepVehicle(motion, command({ steer: .65, throttle }), contacts, 1 / 120);
      const u = -motion.velocity.x * Math.sin(motion.yaw) - motion.velocity.z * Math.cos(motion.yaw);
      const v = -motion.velocity.x * Math.cos(motion.yaw) + motion.velocity.z * Math.sin(motion.yaw);
      peakSlip = Math.max(peakSlip, Math.abs(Math.atan2(v, Math.abs(u))));
    }
    assert.ok(peakSlip < .1, `Normal steering at ${speed * 3.6} km/h with throttle ${throttle} stays below six degrees of sideslip`);
    for (let i = 0; i < 120; i++) stepVehicle(motion, command(), contacts, 1 / 120);
    assert.ok(Math.abs(motion.yawRate) < .03, 'Steering release stops continued body rotation');
    handling.push({ kmh: speed * 3.6, throttle, peakSlipDegrees: peakSlip * 180 / Math.PI, releasedYawRate: motion.yawRate });
  }
}

const tires = createTireFeedback();
assert.equal(tires.update(30, 0, 0, false, contacts).squeal, 0, 'Fast coasting makes no tire squeal');
assert.equal(tires.update(8, 0, 1, false, contacts).squeal, 0, 'An ordinary low-speed stop makes no skid marks');
assert.ok(tires.update(30, 0, 1, false, contacts).wheels.every(strength => strength > .4), 'A straight high-speed service-brake stop marks all four tires');
assert.ok(tires.update(8, 0, 1, false, contacts).squeal > .3, 'Hard-stop feedback continues below its entry speed');
assert.equal(tires.update(0, 0, 1, false, contacts).squeal, 0, 'Tire sound is silent at standstill');
assert.equal(tires.update(20, 0, 0, false, contacts).squeal, 0, 'Releasing the brake clears the hard-stop latch');
const snow = contacts.map(contact => ({ ...contact, coverage: 1, height: .14, grip: .32 }));
assert.equal(tires.update(30, 0, 1, true, snow).squeal, 0, 'Snow uses snow tracks rather than asphalt rubber or squeal');
tires.reset();
const drift = tires.update(20, 0, 0, true, contacts);
assert.ok(drift.wheels[1] > drift.wheels[0] && drift.wheels[3] > drift.wheels[2], 'The handbrake emphasizes the locked rear tires');

const scene = new THREE.Scene(), tracks = addRoadSkidMarks(scene);
const geometry = tracks.mesh.geometry;
tracks.update(0, contacts, [1, 1, 1, 1]);
for (const contact of contacts) contact.z -= .5;
tracks.update(.1, contacts, [1, 1, 1, 1]);
assert.equal(tracks.diagnostics().emitted, 4, 'Each wheel emits its own ribbon');
const anchored = Array.from(geometry.attributes.position.array.slice(0, 48));
tracks.update(.2, contacts, [0, 0, 0, 0]);
assert.deepEqual(Array.from(geometry.attributes.position.array.slice(0, 48)), anchored, 'Old marks remain fixed to the road');
tracks.resetContinuity();
for (const contact of contacts) contact.z -= 20;
tracks.update(.3, contacts, [1, 1, 1, 1]);
assert.equal(tracks.diagnostics().emitted, 4, 'Reset or teleport cannot draw a line across the world');
for (let i = 0; i < 1100; i++) {
  for (const contact of contacts) contact.z = (i % 400) * .5 - 100;
  tracks.update(1 + i / 60, contacts, [1, 1, 1, 1]);
}
assert.equal(tracks.mesh.geometry, geometry, 'Long sessions reuse the same geometry');
assert.equal(tracks.diagnostics().used, tracks.diagnostics().capacity, 'The rubber pool is bounded');
const beforeSnow = tracks.diagnostics().emitted;
tracks.update(100, snow, [1, 1, 1, 1]);
tracks.update(101, snow.map(contact => ({ ...contact, z: contact.z - 1 })), [1, 1, 1, 1]);
assert.equal(tracks.diagnostics().emitted, beforeSnow, 'Rubber ribbons never draw on snow');
tracks.updateTime(200);
assert.equal(tracks.mesh.material.uniforms.time.value, 200, 'Existing marks keep aging while driving is paused');
const report = { handling, skidMarks: tracks.diagnostics() };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/road-grip-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
