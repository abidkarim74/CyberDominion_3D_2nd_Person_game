import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  const stability = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity;
    const trafficStep = g.traffic.step; g.traffic.step = () => 0;
    const results = [];
    for (const [label, deltas] of [['30fps', [1/30]], ['60fps', [1/60]], ['144fps', [1/144]], ['uneven frames', [1/24, 1/60, .1, 1/120]]]) {
      g.reset(); g.setCameraView('driver'); g.carPosition.y = .3;
      let elapsed = 0, frame = 0, peakBodyOffset = 0, minimumHeight = Infinity;
      while (elapsed < 6) {
        const delta = deltas[frame++ % deltas.length]; elapsed += delta; g.elapsed += delta;
        g.updateDriving(delta); g.updateCamera(delta);
        minimumHeight = Math.min(minimumHeight, g.carPosition.y);
        peakBodyOffset = Math.max(peakBodyOffset, Math.abs(g.carRig.body.position.y));
      }
      const position = g.carPosition.clone(), body = g.carRig.body.position.clone();
      const camera = g.camera.position.clone(), orientation = g.camera.quaternion.clone();
      let carMotion = 0, bodyMotion = 0, cameraMotion = 0, rotationMotion = 0;
      while (elapsed < 8) {
        const delta = deltas[frame++ % deltas.length]; elapsed += delta; g.elapsed += delta;
        g.updateDriving(delta); g.updateCamera(delta);
        carMotion = Math.max(carMotion, position.distanceTo(g.carPosition));
        bodyMotion = Math.max(bodyMotion, body.distanceTo(g.carRig.body.position));
        cameraMotion = Math.max(cameraMotion, camera.distanceTo(g.camera.position));
        rotationMotion = Math.max(rotationMotion, orientation.angleTo(g.camera.quaternion));
      }
      results.push({ label, peakBodyOffset, minimumHeight, carMotion, bodyMotion, cameraMotion, rotationMotion,
        suspensionVelocity: g.suspensionVelocity, speed: g.velocity.length() });
    }
    g.traffic.step = trafficStep;
    g.reset(); g.setCameraView('driver');
    g.yaw = .7; g.car.rotation.y = .7; g.carRig.body.rotation.set(.08, 0, -.06); g.carRig.body.position.y = .004;
    g.updateCamera(0, true);
    const seatError = g.camera.position.clone().applyMatrix4(g.carRig.body.matrixWorld.clone().invert()).distanceTo(g.carRig.cockpit.eye);
    g.reset(); const resetBodyOffset = g.carRig.body.position.y;
    const instruments = g.carRig.cockpit, initialVersion = instruments.dashboardMap.version;
    for (let i = 0; i < 120; i++) instruments.update(1/60, { speed: 0, boost: 1, boosting: false, firing: false }, 0, true);
    const idleUploads = instruments.dashboardMap.version - initialVersion;
    for (let i = 0; i < 120; i++) instruments.update(1/60, { speed: i, boost: .5, boosting: true, firing: true }, 1, true);
    const movingUploads = instruments.dashboardMap.version - initialVersion;
    const readout = instruments.readout;
    const resourcesBefore = { ...g.renderer.info.memory };
    for (let i = 0; i < 12; i++) g.toggleCameraView();
    const resourcesAfter = { ...g.renderer.info.memory };
    g.reset(); g.active = false; g.previousTime = 0;
    g.animationFrame = requestAnimationFrame(g.frameHandler);
    return { results, seatError, resetBodyOffset, idleUploads, movingUploads, readout, resourcesBefore, resourcesAfter };
  });
  for (const result of stability.results) {
    assert.equal(result.peakBodyOffset, 0, `${result.label}: no artificial idle bob`);
    assert.ok(result.minimumHeight >= .015 - 1e-10, `${result.label}: suspension settles without overshoot`);
    assert.equal(result.speed, 0); assert.equal(result.suspensionVelocity, 0);
    assert.ok(result.carMotion < 1e-10 && result.bodyMotion < 1e-10 && result.cameraMotion < 1e-10 && result.rotationMotion < 1e-7,
      `${result.label}: the car and driver camera remain still after settling`);
  }
  assert.ok(stability.seatError < 1e-10, 'The driver eye follows the full suspended cabin transform');
  assert.equal(stability.resetBodyOffset, 0); assert.equal(stability.idleUploads, 0);
  assert.ok(stability.movingUploads > 15 && stability.movingUploads <= 20, 'Changing instruments upload at most ten times per second');
  assert.ok(stability.readout.speed > 100 && stability.readout.firing);
  assert.deepEqual(stability.resourcesBefore, stability.resourcesAfter, 'Camera switches retain GPU resources');
  const performance = [];
  for (const level of [0, 4]) {
    await page.evaluate(level => { const g = document.querySelector('canvas').__drive; g.qualityLevel = level; g.resize(); }, level);
    await page.waitForTimeout(1500);
    performance.push(await page.evaluate(async level => {
      const g = document.querySelector('canvas').__drive;
      const frames = [], calls = [], cpu = []; let previous;
      const render = g.composer.render;
      g.composer.render = function(...args) { const start = window.performance.now(); render.apply(this, args); cpu.push(window.performance.now()-start); };
      await new Promise(resolve => { function tick(time) {
        if (previous !== undefined) { frames.push(time-previous); calls.push(g.renderer.info.render.calls); }
        previous=time; if (frames.length<60) requestAnimationFrame(tick); else resolve();
      } requestAnimationFrame(tick); });
      g.composer.render = render;
      const summarize = list => { list.sort((a,b)=>a-b); return { median: list[Math.floor(list.length*.5)], p95: list[Math.floor(list.length*.95)] }; };
      return { level, frameMs: summarize(frames), renderCpuMs: summarize(cpu), calls: summarize(calls),
        scenePixelRatio: g.scenePixelRatio, presentationRatio: g.renderer.getPixelRatio(),
        scenePixels: g.composer.renderTarget1.width * g.composer.renderTarget1.height,
        contextLost: g.renderer.getContext().isContextLost() };
    }, level));
  }
  assert.ok(performance[1].scenePixels < performance[0].scenePixels * .45, 'Sustained pressure reduces GPU pixel workload');
  assert.ok(performance[1].presentationRatio >= performance[1].scenePixelRatio, 'The output retains its edge/detail resolve');
  assert.ok(performance.every(result => !result.contextLost));
  await page.screenshot({ path: 'artifacts/driver-detail-adaptive.png' });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.qualityLevel = 0; g.resize(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/driver-detail-full.png' });
  const report = { stability, performance, errors };
  await writeFile('artifacts/driver-stability-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No runtime or shader errors');
} finally { await browser.close(); }
