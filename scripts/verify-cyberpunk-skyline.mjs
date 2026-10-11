import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.scene.userData.cyberpunkSkyline?.length, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(1500);
  const city = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    const buildings = g.scene.userData.cyberpunkSkyline;
    const heights = buildings.map(b => b.height);
    const blocked = [];
    // Check whole driving lanes, including the car footprint, against the actual collision grid.
    for (let i = 0; i < 18; i++) for (const across of [false, true]) for (const lane of [-4.4, 0, 4.4]) {
      const road = (i - 8.5) * 44 + lane;
      const from = across ? { x: -385, z: road } : { x: road, z: -385 };
      const to = across ? { x: 385, z: road } : { x: road, z: 385 };
      const hit = g.collisionWorld.sweep(from, to, across ? Math.PI / 2 : 0);
      if (hit) blocked.push({ across, lane, road, collider: hit.collider });
    }
    const glows = g.scene.children.filter(o => o.name === 'City / batched avenue glow');
    return {
      count: buildings.length, minimumHeight: Math.min(...heights), maximumHeight: Math.max(...heights),
      low: heights.filter(h => h < 32).length, medium: heights.filter(h => h >= 32 && h < 90).length,
      high: heights.filter(h => h >= 90).length, landmarks: buildings.filter(b => b.landmark).length,
      shapes: new Set(buildings.map(b => b.shape)).size,
      widthRange: [Math.min(...buildings.map(b => b.width)), Math.max(...buildings.map(b => b.width))],
      depthRange: [Math.min(...buildings.map(b => b.depth)), Math.max(...buildings.map(b => b.depth))],
      blocked, avenueMeshes: glows.length, avenueSinglePass: glows.every(o => o.material.forceSinglePass),
      contextLost: g.renderer.getContext().isContextLost(),
    };
  });
  assert.equal(city.count, 289);
  assert.equal(city.shapes, 12, 'Every architecture silhouette appears in the city');
  assert.ok(city.minimumHeight < 20 && city.maximumHeight >= 300, 'Low blocks and skyscrapers form a clear height hierarchy');
  assert.ok(city.low > 50 && city.medium > 50 && city.high > 50 && city.landmarks === 8, 'The skyline has varied districts and deliberate landmarks');
  assert.ok(city.widthRange[1] - city.widthRange[0] > 9 && city.depthRange[1] - city.depthRange[0] > 9, 'Footprints vary as well as height');
  assert.deepEqual(city.blocked, [], 'All lanes remain clear with the full car footprint');
  assert.ok(city.avenueMeshes === 2 && city.avenueSinglePass, 'Avenue glows use only two single-pass batches');
  assert.equal(city.contextLost, false);

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.carPosition.set(-22, .015, 220); g.car.position.copy(g.carPosition); g.velocity.set(0, 0, -20);
  });
  await page.keyboard.down('w');
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; for (let i = 0; i < 30; i++) g.updateDriving(1 / 120); });
  await page.keyboard.down('a');
  const onset = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    for (let i = 0; i < 15; i++) g.updateDriving(1 / 120);
    return { yaw: g.yaw, speedKmh: g.velocity.length() * 3.6, x: g.carPosition.x, steeringAngle: g.vehicleMotion.steeringAngle };
  });
  assert.ok(onset.yaw > .026 && onset.x < -22 && onset.speedKmh > 70, 'The real W+A input turns promptly at road speed');
  await page.keyboard.up('a'); await page.keyboard.down('d');
  const countersteer = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    for (let i = 0; i < 12; i++) g.updateDriving(1 / 120);
    return { yawRate: g.vehicleMotion.yawRate, steeringAngle: g.vehicleMotion.steeringAngle };
  });
  assert.ok(countersteer.yawRate < 0 && countersteer.steeringAngle < 0, 'Real keyboard countersteering reverses the turn within 100ms');
  await page.keyboard.up('d'); await page.keyboard.up('w');

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false; g.updateCamera(0, true); g.updateSnow(0); g.updateCityVisibility(g.carPosition);
    g.renderer.shadowMap.needsUpdate = true; g.composer.render();
  });
  await page.screenshot({ path: 'artifacts/cyberpunk-skyline-street.png' });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.camera.position.set(-410, 155, 455); g.camera.lookAt(0, 88, 0); g.camera.fov = 64; g.camera.updateProjectionMatrix();
    g.composer.render();
  });
  await page.screenshot({ path: 'artifacts/cyberpunk-skyline-overview.png' });
  assert.deepEqual(errors, [], 'No browser or shader errors');
  const result = { city, onset, countersteer, errors };
  await writeFile('artifacts/cyberpunk-skyline-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
