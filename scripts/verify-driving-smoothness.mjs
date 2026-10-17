import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const report = { errors: [], criteria: {
  straight: 'Every render advances; speed ripple <0.3 m/s; camera gap/height ripple <5 mm; no sideways drift.',
  steering: 'Countersteer within 200 ms; no held-turn stalls; no neutral zigzags; yaw rate <0.04 rad/s after 200 ms and <0.002 rad/s after 600 ms; tail travel <0.2 degrees.',
  lifecycle: 'Raw keys cannot kick camera; pause/reset stay anchored; collision presentation stays at corrected contact.',
} };
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });

  report.motion = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.qualityWarmup = Infinity;
    const original = { step: g.traffic.step, sweep: g.collisionWorld.sweep, contacts: g.updateWheelContacts };
    // Isolate presentation cadence from traffic, walls, and changing road grip.
    // Actual collision correction is checked separately below.
    g.traffic.step = () => 0;
    g.collisionWorld.sweep = () => null;
    g.updateWheelContacts = () => {
      for (const c of g.wheelContacts) Object.assign(c, { height: .009, grip: .95, coverage: 0, depth: 0 });
    };
    const angle = value => Math.atan2(Math.sin(value), Math.cos(value));
    const range = values => Math.max(...values) - Math.min(...values);
    const seed = (kmh, view = 'chase') => {
      g.reset(); g.active = true; g.setCameraView(view);
      g.carPosition.set(-22, .015, 160);
      g.velocity.set(0, 0, -kmh / 3.6);
      g.yaw = g.vehicleMotion.yaw = 0;
      g.car.position.copy(g.carPosition); g.car.rotation.y = 0;
      g.physicsAccumulator = 0;
      g.syncVehiclePresentation?.();
      g.pressed.add('w');
      if (kmh > 220) { g.nitroRemaining = 3; g.nitroTargetSpeed = kmh / 3.6; }
      g.updateCamera(0, true);
    };
    const advance = delta => {
      g.elapsed += delta;
      g.updateDriving(delta); g.updateCamera(delta);
      if (![...g.car.position.toArray(), ...g.carPosition.toArray(), ...g.camera.position.toArray(),
        ...g.camera.quaternion.toArray(), g.yaw, g.car.rotation.y].every(Number.isFinite)) throw new Error('Non-finite driving presentation');
    };
    const straight = [];
    const cadences = [50, 75, 90, 144, 240].map(fps => ({ label: `${fps} Hz`, deltas: [1 / fps] }));
    cadences.push({ label: 'uneven 50–240 Hz', deltas: [1 / 50, 1 / 144, 1 / 75, 1 / 240, 1 / 90] });
    try {
      for (const kmh of [220, 352]) for (const cadence of cadences) {
        seed(kmh);
        let elapsed = 0, frame = 0;
        const speeds = [], cameraGaps = [], cameraHeights = [];
        let peakSideways = 0, peakYaw = 0, stationaryFrames = 0, physicsOnlyStationaryFrames = 0;
        while (elapsed < 1.6) {
          const delta = cadence.deltas[frame++ % cadence.deltas.length];
          const before = g.car.position.clone();
          const physicsBefore = g.carPosition.clone();
          advance(delta); elapsed += delta;
          if (elapsed < .5) continue;
          const distance = before.distanceTo(g.car.position);
          speeds.push(distance / delta);
          if (distance < 1e-8) stationaryFrames++;
          if (physicsBefore.distanceTo(g.carPosition) < 1e-8) physicsOnlyStationaryFrames++;
          cameraGaps.push(g.camera.position.z - g.car.position.z);
          cameraHeights.push(g.camera.position.y - g.car.position.y);
          peakSideways = Math.max(peakSideways, Math.abs(g.car.position.x + 22), Math.abs(g.camera.position.x + 22));
          peakYaw = Math.max(peakYaw, Math.abs(g.car.rotation.y));
        }
        straight.push({ kmh, cadence: cadence.label, stationaryFrames, physicsOnlyStationaryFrames, speedRangeMps: range(speeds),
          minimumRenderedSpeedMps: Math.min(...speeds), cameraGapRangeMeters: range(cameraGaps),
          cameraHeightRangeMeters: range(cameraHeights), peakSidewaysMeters: peakSideways, peakYawRadians: peakYaw });
      }

      const steering = [];
      for (const kmh of [220, 352]) for (const fps of [50, 75, 90, 144, 240]) {
        seed(kmh);
        const dt = 1 / fps;
        for (let i = 0; i < Math.ceil(.2 * fps); i++) advance(dt);
        g.pressed.add('a');
        const heldYawSteps = [];
        for (let i = 0; i < Math.ceil(.25 * fps); i++) {
          const before = g.car.rotation.y; advance(dt);
          if (i > .1 * fps) heldYawSteps.push(angle(g.car.rotation.y - before) / dt);
        }
        const leftYaw = g.yaw;
        g.pressed.delete('a'); g.pressed.add('d');
        let countersteerTime = null;
        for (let i = 0; i < Math.ceil(.25 * fps); i++) {
          advance(dt);
          if (countersteerTime === null && g.vehicleMotion.yawRate < -.01) countersteerTime = (i + 1) * dt;
        }
        g.pressed.delete('d');
        let releasePeakYawRate = 0, releaseReversals = 0, lastSign = 0, postReleaseYawTravel = 0;
        for (let i = 0; i < Math.ceil(.6 * fps); i++) {
          const before = g.car.rotation.y; advance(dt);
          if (i < .2 * fps) continue;
          const change = angle(g.car.rotation.y - before);
          postReleaseYawTravel += Math.abs(change);
          releasePeakYawRate = Math.max(releasePeakYawRate, Math.abs(g.vehicleMotion.yawRate));
          const sign = Math.abs(change) > 1e-6 ? Math.sign(change) : 0;
          if (sign && lastSign && sign !== lastSign) releaseReversals++;
          if (sign) lastSign = sign;
        }
        steering.push({ kmh, fps, leftYawDegrees: leftYaw * 180 / Math.PI, countersteerSeconds: countersteerTime,
          heldStationaryYawFrames: heldYawSteps.filter(step => Math.abs(step) < 1e-8).length,
          minimumHeldYawRate: Math.min(...heldYawSteps), maximumHeldYawRate: Math.max(...heldYawSteps),
          releasePeakYawRate, finalYawRate: Math.abs(g.vehicleMotion.yawRate), releaseReversals,
          postReleaseYawDegrees: postReleaseYawTravel * 180 / Math.PI });
      }

      const inputCamera = [];
      for (const view of ['chase', 'driver']) {
        seed(352, view);
        const position = g.camera.position.clone(), target = g.cameraTarget.clone();
        g.pressed.add('d'); advance(.001); // No physics step: a key alone must not kick the view sideways.
        inputCamera.push({ view, sidewaysCameraMeters: Math.abs(g.camera.position.x - position.x),
          sidewaysTargetMeters: Math.abs(g.cameraTarget.x - target.x), yawChange: Math.abs(g.car.rotation.y) });
      }

      seed(352); advance(1 / 144);
      g.setDriving(false); g.updateCamera(1 / 60);
      const pausedPosition = g.car.position.clone(), pausedCamera = g.camera.position.clone();
      for (let i = 0; i < 60; i++) g.updateCamera(1 / 60);
      const pause = { positionMotion: pausedPosition.distanceTo(g.car.position), cameraMotion: pausedCamera.distanceTo(g.camera.position),
        poseError: g.car.position.distanceTo(g.carPosition), accumulator: g.physicsAccumulator };
      g.setDriving(true); advance(1 / 240);
      const resume = { poseError: g.car.position.distanceTo(g.carPosition), finite: g.car.position.toArray().every(Number.isFinite) };
      g.reset();
      const reset = { poseError: g.car.position.distanceTo(g.carPosition), speed: g.velocity.length(),
        cameraGapMeters: g.camera.position.distanceTo(g.car.position), yaw: g.car.rotation.y };

      seed(352);
      let collisionCalls = 0;
      g.collisionWorld.sweep = () => {
        collisionCalls++;
        return { time: .4, collider: { x: -22, z: 156, hx: 4, hz: 1 } };
      };
      advance(1 / 50);
      const collision = { calls: collisionCalls, presentationError: g.car.position.distanceTo(g.carPosition),
        speedAfterImpactKmh: g.velocity.length() * 3.6, boosting: g.lastTelemetry.boosting };
      g.collisionWorld.sweep = () => null;
      for (let i = 0; i < 20; i++) advance(1 / 240);
      collision.finiteAfterContact = [...g.car.position.toArray(), ...g.camera.position.toArray()].every(Number.isFinite);
      return { straight, steering, inputCamera, pause, resume, reset, collision };
    } finally {
      g.traffic.step = original.step; g.collisionWorld.sweep = original.sweep; g.updateWheelContacts = original.contacts;
      g.reset(); g.active = false;
    }
  });

  for (const result of report.motion.straight) {
    const label = `${result.kmh} km/h / ${result.cadence}`;
    assert.equal(result.stationaryFrames, 0, `${label}: every render advances the moving car`);
    assert.ok(result.speedRangeMps < .3, `${label}: no alternating short/long physics-step jumps (${result.speedRangeMps})`);
    assert.ok(result.minimumRenderedSpeedMps > result.kmh / 3.6 * .98, `${label}: rendered travel retains speed`);
    assert.ok(result.cameraGapRangeMeters < .005, `${label}: chase distance does not pulse (${result.cameraGapRangeMeters})`);
    assert.ok(result.cameraHeightRangeMeters < .005, `${label}: no artificial high-speed camera bob`);
    assert.ok(result.peakSidewaysMeters < 1e-9 && result.peakYawRadians < 1e-9, `${label}: straight driving stays straight`);
  }
  for (const result of report.motion.steering) {
    const label = `${result.kmh} km/h / ${result.fps} Hz`;
    assert.ok(result.leftYawDegrees > .5, `${label}: steering still responds`);
    assert.ok(result.countersteerSeconds !== null && result.countersteerSeconds <= .2, `${label}: countersteering responds within 200 ms`);
    assert.equal(result.heldStationaryYawFrames, 0, `${label}: turning continues between physics ticks`);
    assert.ok(result.minimumHeldYawRate > 0, `${label}: a held turn does not weave`);
    assert.ok(result.releasePeakYawRate < .04 && result.finalYawRate < .002, `${label}: steering release fully settles`);
    assert.equal(result.releaseReversals, 0, `${label}: release does not zigzag`);
    assert.ok(result.postReleaseYawDegrees < .2, `${label}: no residual high-speed steering wander`);
  }
  for (const result of report.motion.inputCamera) {
    assert.ok(result.sidewaysCameraMeters < 1e-10 && result.sidewaysTargetMeters < 1e-10 && result.yawChange === 0,
      `${result.view}: a raw key does not jerk the camera before the car turns`);
  }
  assert.ok(report.motion.pause.positionMotion < 1e-10 && report.motion.pause.cameraMotion < .005, 'Pause holds the car and camera still');
  assert.equal(report.motion.pause.poseError, 0); assert.equal(report.motion.pause.accumulator, 0);
  assert.ok(report.motion.resume.finite && report.motion.resume.poseError < 1, 'Resume retains a continuous car pose');
  assert.equal(report.motion.reset.poseError, 0); assert.equal(report.motion.reset.speed, 0); assert.equal(report.motion.reset.yaw, 0);
  assert.ok(report.motion.reset.cameraGapMeters < 12, 'Reset snaps the camera back to its car');
  assert.equal(report.motion.collision.calls, 1);
  assert.ok(report.motion.collision.presentationError < 1e-10 && report.motion.collision.finiteAfterContact, 'A corrected contact cannot interpolate through the obstacle');
  assert.equal(report.motion.collision.boosting, false);
  assert.ok(report.motion.collision.speedAfterImpactKmh < 20, 'Collision still resolves high-speed impact');
  assert.deepEqual(report.errors, [], 'No browser runtime or shader errors');
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false; report.failure = error.message;
  throw error;
} finally {
  await writeFile('artifacts/high-speed-smoothness-verification.json', JSON.stringify(report, null, 2));
  await browser.close();
}
