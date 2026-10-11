import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.reset(); g.carPosition.set(-22, .015, 250); g.car.position.copy(g.carPosition); g.velocity.set(0, 0, -100 / 3.6);
  });
  await page.keyboard.down('s');
  const braking = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    let frames = 0;
    while (g.velocity.length() > .05 && frames < 300) { g.updateDriving(1 / 60); frames++; }
    for (let i = 0; i < 120; i++) g.updateDriving(1 / 60);
    return { seconds: frames / 60, speed: g.velocity.length(), reverse: g.reverseEngaged, z: g.carPosition.z };
  });
  assert.ok(braking.seconds < 3.4 && braking.speed === 0 && !braking.reverse, 'The real S key brakes promptly and holds a stop');
  await page.keyboard.up('s'); await page.keyboard.down('s');
  const reverse = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    for (let i = 0; i < 60; i++) g.updateDriving(1 / 60);
    return { zVelocity: g.velocity.z, engaged: g.reverseEngaged };
  });
  assert.ok(reverse.engaged && reverse.zVelocity > 1, 'A second press at rest engages reverse');
  await page.keyboard.up('s');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.carPosition.set(-22, .015, -60); g.car.position.copy(g.carPosition); g.velocity.set(0, 0, -16);
  });
  await page.keyboard.down(' '); await page.keyboard.down('a');
  const drift = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    // Rear lock needs time to build a genuine slide from this 16 m/s start.
    for (let i = 0; i < 48; i++) g.updateDriving(1 / 60);
    g.updateSnow(1 / 60); g.updateCamera(0, true); g.updateCityVisibility(g.carPosition); g.composer.render();
    return { yaw: g.yaw, lateralSpeed: Math.abs(g.velocity.dot(g.right)), speed: g.velocity.length(), drifting: g.lastTelemetry.drifting, particles: g.particles.length, brakeIntensity: g.brakeLights[0].material.emissiveIntensity, position: g.carPosition.toArray(), keys: [...g.pressed] };
  });
  assert.ok(drift.yaw > .2 && drift.lateralSpeed > 2 && drift.drifting, 'Space plus steering produces a real slide through the intersection: ' + JSON.stringify(drift));
  assert.ok(drift.particles > 0, 'The actual handbrake slide emits tire smoke');
  assert.equal(drift.brakeIntensity, 4.5, 'The drift brake lights the brake lamps');
  await page.screenshot({ path: 'artifacts/braking-drift.png' });
  await page.keyboard.up(' '); await page.keyboard.up('a');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.carPosition.set(-22, .015, -60); g.car.position.copy(g.carPosition); g.velocity.set(0, 0, -16);
  });
  await page.keyboard.down('s'); await page.keyboard.down('a');
  const brakeTurn = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    let lateralSpeed = 0, peakSlip = 0, drifting = false;
    for (let i = 0; i < 72; i++) {
      g.updateDriving(1 / 60);
      lateralSpeed = Math.max(lateralSpeed, Math.abs(g.velocity.dot(g.right)));
      if (g.velocity.length() > 3) peakSlip = Math.max(peakSlip, Math.atan2(Math.abs(g.velocity.dot(g.right)), Math.abs(g.velocity.dot(g.forward))));
      drifting ||= g.lastTelemetry.drifting;
    }
    return { yaw: g.yaw, lateralSpeed, peakSlip, speed: g.velocity.length(), drifting };
  });
  assert.ok(brakeTurn.yaw > .2 && brakeTurn.speed < 6 && brakeTurn.peakSlip < .15 && !brakeTurn.drifting, 'S braking retains useful steering and decelerates with stable ABS tire grip: ' + JSON.stringify(brakeTurn));
  await page.keyboard.up('s'); await page.keyboard.up('a');
  const quality = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.qualityLevel = 0; g.qualityWarmup = -1;
    g.reflections.setQuality(0); g.renderer.shadowMap.enabled = true; g.resize();
    const before = { pixelRatio: g.renderer.getPixelRatio(), snowCount: g.snowfall.flakes.geometry.drawRange.count };
    g.active = false;
    // Simulate sustained slow frames without the expensive GPU render.
    const render = g.composer.render;
    g.composer.render = () => {};
    g.previousTime = 1;
    for (let i = 1; i <= 240; i++) { g.frame(1 + i * 50); cancelAnimationFrame(g.animationFrame); }
    g.composer.render = render;
    let gpuBatches = 0, blocks = 0;
    g.scene.traverse(o => { if (o.isBatchedMesh) { gpuBatches++; blocks += o.userData.cityBatchEntries.length; } });
    return { before, after: { pixelRatio: g.renderer.getPixelRatio(), snowCount: g.snowfall.flakes.geometry.drawRange.count }, shadows: g.renderer.shadowMap.enabled, reflection: g.reflections.mirror.visible, gpuBatches, blocks, multiDraw: !!g.renderer.getContext().getExtension('WEBGL_multi_draw') };
  });
  assert.ok(quality.after.pixelRatio < quality.before.pixelRatio, 'Sustained slow frames reduce render cost');
  assert.equal(quality.before.snowCount, quality.after.snowCount, 'Adaptive rendering preserves weather coverage');
  assert.ok(!quality.shadows && !quality.reflection && quality.gpuBatches > 0, 'The lowest quality removes expensive extra passes while retaining city geometry batches');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  const visual = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false; g.updateCamera(0, true); g.updateSnow(0); g.updateCityVisibility(g.carPosition);
    g.composer.render();
    const capture = g.reflections.mirror.onBeforeRender;
    g.reflections.mirror.onBeforeRender = () => {};
    g.renderer.shadowMap.needsUpdate = false;
    const sky = []; g.scene.traverse(o => { if (o.name === 'Island / blue hour sky and marine haze' || o.name === 'Cyberpunk / industrial night sky') sky.push(o); });
    const orders = sky.map(o => o.renderOrder), oceanOrder = g.island.water.renderOrder;
    const canvas = document.createElement('canvas'); canvas.width = g.renderer.domElement.width; canvas.height = g.renderer.domElement.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = () => { g.composer.render(); context.drawImage(g.renderer.domElement, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
    sky.forEach(o => o.renderOrder = -10); g.island.water.renderOrder = 0;
    const original = pixels();
    sky.forEach((o, i) => o.renderOrder = orders[i]); g.island.water.renderOrder = oceanOrder;
    const optimized = pixels();
    let maxDifference = 0, squaredDifference = 0;
    for (let i = 0; i < original.length; i++) { const difference = Math.abs(original[i] - optimized[i]); maxDifference = Math.max(maxDifference, difference); squaredDifference += difference * difference; }
    g.reflections.mirror.onBeforeRender = capture;
    return { maxDifference, rmsDifference: Math.sqrt(squaredDifference / original.length) };
  });
  assert.ok(visual.rmsDifference < .5, 'Avoiding hidden sky/ocean pixels preserves the rendered image');
  await page.screenshot({ path: 'artifacts/city-quality-preserved.png' });
  assert.deepEqual(errors, [], 'No shader or runtime errors');
  const report = { braking, reverse, drift, brakeTurn, quality, visual, errors };
  await writeFile('artifacts/city-motion-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
