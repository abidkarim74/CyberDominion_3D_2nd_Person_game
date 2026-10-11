import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.getByRole('button', { name: 'Switch to driver view' }).click({ noWaitAfter: true });
  await page.waitForTimeout(800);
  const report = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.reset(); g.active = false;
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true);
    const mirror = g.reflections.mirror, mirrorVisible = mirror.visible; mirror.visible = false;
    const glass = g.carRig.body.children.find(o => o.material?.name === 'Bugatti cabin / clear inner laminated windows');
    const canvas = document.createElement('canvas'); canvas.width = g.renderer.domElement.width; canvas.height = g.renderer.domElement.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = () => { g.composer.render(); context.drawImage(g.renderer.domElement, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
    const changedPixels = (before, after, lower, upper) => {
      let count = 0;
      for (let y = Math.floor(canvas.height * lower); y < canvas.height * upper; y++) for (let x = Math.floor(canvas.width * .25); x < canvas.width * .8; x++) {
        const i = (y * canvas.width + x) * 4;
        if (Math.max(...[0, 1, 2].map(channel => Math.abs(before[i + channel] - after[i + channel]))) > 4) count++;
      }
      return count;
    };
    const withGlass = pixels(); glass.visible = false; const withoutGlass = pixels(); glass.visible = true;
    const windshieldPixels = changedPixels(withGlass, withoutGlass, .30, .53);

    // Isolate actual bonnet triangles, then measure their contribution to the
    // driver image. A material/property check alone cannot catch an occluded hood.
    const paint = g.carRig.body.children.find(o => o.material?.name === 'Bugatti / racing red gloss clearcoat');
    const geometry = paint.geometry.clone(), position = geometry.attributes.position, indices = [];
    for (let i = 0; i < position.count; i += 3) if ([i, i + 1, i + 2].every(j => position.getZ(j) < -1.40 && position.getY(j) > .70 && Math.abs(position.getX(j)) < .67)) indices.push(i, i + 1, i + 2);
    geometry.setIndex(indices);
    const material = paint.material.clone(); material.color.setHex(0x00ff00); material.emissive.setHex(0x00ff00); material.emissiveIntensity = 4; material.toneMapped = false;
    const bonnet = new paint.constructor(geometry, material); paint.parent.add(bonnet); paint.visible = false;
    const withBonnet = pixels(); bonnet.visible = false; const withoutBonnet = pixels();
    const bonnetPixels = changedPixels(withBonnet, withoutBonnet, .50, .68);
    bonnet.removeFromParent(); geometry.dispose(); material.dispose(); paint.visible = true; mirror.visible = mirrorVisible;
    let invalidGeometry = 0;
    g.car.traverse(o => { if (o.isMesh) for (const name of ['position', 'normal', 'uv']) { const attribute = o.geometry.attributes[name]; if (attribute && !Array.from(attribute.array).every(Number.isFinite)) invalidGeometry++; } });
    const eye = g.camera.position.clone().sub(g.carPosition).toArray();
    const resourcesBefore = { ...g.renderer.info.memory };
    for (let i = 0; i < 12; i++) g.toggleCameraView();
    const resourcesAfter = { ...g.renderer.info.memory };
    g.composer.render();
    return { windshieldPixels, bonnetPixels, eye, invalidGeometry, resourcesBefore, resourcesAfter, draws: g.renderer.info.render.calls, passes: g.composer.passes.length, contextLost: g.renderer.getContext().isContextLost() };
  });
  assert.ok(report.windshieldPixels > 500, 'Windshield glass visibly renders from the driver seat');
  assert.ok(report.bonnetPixels > 500, 'Actual bonnet surface is visible beyond the dashboard');
  assert.equal(report.invalidGeometry, 0);
  assert.equal(report.contextLost, false);
  assert.equal(report.passes, 4, 'Cockpit uses the existing rendering pipeline');
  assert.deepEqual(report.resourcesBefore, report.resourcesAfter, 'Camera switching does not allocate new GPU resources');
  await page.screenshot({ path: 'artifacts/cockpit-shell-driver.png' });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.updateCamera(0, true); g.composer.render(); });
  await page.screenshot({ path: 'artifacts/cockpit-shell-compact.png' });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.active = true; g.renderer.domElement.focus(); });
  await page.keyboard.down('w'); await page.keyboard.down('a');
  const driving = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive; g.active = true;
    for (let i = 0; i < 120; i++) g.updateDriving(1 / 120);
    g.updateCamera(0, true); g.carRig.cockpit.update(.1, g.lastTelemetry, g.steerInput, true); g.composer.render();
    return { speed: g.lastTelemetry.speed, steering: g.carRig.cockpit.steeringWheel.rotation.z, seatDistance: g.camera.position.distanceTo(g.carPosition) };
  });
  await page.keyboard.up('a'); await page.keyboard.up('w');
  assert.ok(driving.speed > 0 && Math.abs(driving.steering) > .2, 'Driver steering and acceleration still respond');
  assert.ok(driving.seatDistance < 1.3, 'Driver camera stays inside the cabin');
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'chase');
  await page.keyboard.press('o');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'orbit');
  assert.deepEqual(errors, [], 'No browser or shader errors');
  Object.assign(report, { driving, errors });
  await writeFile('artifacts/cockpit-shell-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
