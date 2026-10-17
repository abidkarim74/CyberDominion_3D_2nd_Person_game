import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const label = process.env.CYBERPUNK_LABEL || process.argv[2] || 'verification';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(label === 'baseline' ? 3500 : 12000);
  const measure = async () => page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const intervals = [], calls = [], triangles = [];
    let last = performance.now();
    await new Promise(resolve => { function tick(t) {
      intervals.push(t - last); last = t;
      calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
      if (intervals.length < 90) requestAnimationFrame(tick); else resolve();
    } requestAnimationFrame(tick); });
    const summarize = values => { values.sort((a, b) => a - b); return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) }; };
    const gl = g.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    let meshes = 0, staticBatches = 0, pointLights = 0;
    const features = [];
    g.scene.traverse(o => { if (o.isMesh) meshes++; if (o.userData.cityBounds) staticBatches++; if (o.isPointLight) pointLights++; if (/cyber|district|advert|billboard|storefront|skyline|ocean|snow|hologram|lantern|market/i.test(o.name) && features.length < 80) features.push({ name: o.name, visible: o.visible, count: o.count }); });
    return { framesMs: summarize(intervals), calls: summarize(calls), triangles: summarize(triangles), pixelRatio: g.renderer.getPixelRatio(), qualityLevel: g.qualityLevel, averageFrame: g.averageFrame, reflectionVisible: g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, gpu: extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL), contextLost: gl.isContextLost(), meshes, staticBatches, pointLights, features };
  });
  const regions = [];
  for (const [region, x, z, yaw] of [['central', -22, -22, 0], ['north', 22, -330, Math.PI], ['east', 330, 220, Math.PI], ['west', -330, 0, 0]]) {
    await page.evaluate(({ x, z, yaw }) => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.active = false; g.carPosition.set(x, .015, z); g.car.position.copy(g.carPosition);
      g.yaw = yaw; g.car.rotation.y = yaw;
      g.camera.position.set(x + Math.sin(yaw) * 8.4, 3.2, z + Math.cos(yaw) * 8.4);
    }, { x, z, yaw });
    await page.waitForTimeout(1000);
    const profile = await measure();
    regions.push({ region, ...profile });
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/cyberpunk-${label}-${region}.png` });
  }
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.reset(); g.active = true; });
  await page.keyboard.down('w'); await page.keyboard.down('Shift'); await page.keyboard.down('f');
  await page.waitForTimeout(2500);
  const driving = await page.evaluate(() => { const g = document.querySelector('canvas').__drive; return { ...g.lastTelemetry, bullets: g.bullets.length, smoke: g.smokeParticles.length, position: g.carPosition.toArray() }; });
  driving.performance = await measure();
  await page.keyboard.up('f'); await page.keyboard.up('Shift'); await page.keyboard.up('w');
  await page.screenshot({ path: `artifacts/cyberpunk-${label}-driving.png` });
  await page.keyboard.press('r');
  const reset = await page.evaluate(() => { const g = document.querySelector('canvas').__drive; return { position: g.carPosition.toArray(), speed: g.velocity.length(), boost: g.boostCharge, bullets: g.bullets.length, yaw: g.yaw }; });
  await page.keyboard.press('c');
  await page.waitForTimeout(1200);
  const driverView = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
  const driver = await measure();
  await page.screenshot({ path: `artifacts/cyberpunk-${label}-driver.png` });
  await page.getByRole('button', { name: 'Switch to chase view' }).click();
  const chaseView = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
  const clearance = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    const distance = v => Math.abs(v - (Math.round((v - 22) / 44) * 44 + 22));
    const blocked = [], stray = [];
    for (const road of Array.from({ length: 18 }, (_, i) => (i - 8.5) * 44)) for (const across of [false, true]) for (const lane of [-4.4, 0, 4.4]) for (let along = -387; along <= 387; along++) {
      const x = across ? along : road + lane, z = across ? road + lane : along;
      const hit = g.collisionWorld.query({ x, z }).find(b => Math.abs(x - b.x) < b.hx + (across ? 2.65 : 1.05) && Math.abs(z - b.z) < b.hz + (across ? 1.05 : 2.65));
      if (hit) { blocked.push({ x, z, road, across, lane, hit }); break; }
    }
    g.scene.updateMatrixWorld(true);
    let examined = 0;
    g.scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.material.transparent || o.userData.dynamic) return;
      for (let parent = o; parent; parent = parent.parent) if (parent === g.car) return;
      const p = o.geometry.attributes.position; if (!p) return;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), m = o.matrixWorld.elements;
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (wy < .3 || wy > 2.3 || Math.abs(wx) > 387 || Math.abs(wz) > 387) continue;
        examined++;
        if (Math.min(distance(wx), distance(wz)) < 8.6 && stray.length < 30) stray.push({ name: o.name, x: wx, y: wy, z: wz, type: o.geometry.type });
      }
    });
    return { blocked, stray, examined, colliders: g.colliders.length, collisionStats: g.collisionWorld.stats };
  });
  const mobile = [];
  for (const [width, height] of [[375, 812], [320, 640], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
    const play = page.getByRole('button', { name: 'PLAY', exact: true });
    await play.waitFor({ state: 'visible' });
    const bounds = await play.boundingBox();
    const layout = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], contentWidth: document.documentElement.scrollWidth, title: document.querySelector('h1')?.textContent, contextLost: document.querySelector('canvas').__drive.renderer.getContext().isContextLost() }));
    await page.screenshot({ path: `artifacts/cyberpunk-${label}-mobile-${width}x${height}.png` });
    await play.click();
    const started = await page.evaluate(() => document.querySelector('canvas').__drive.active);
    await page.getByRole('button', { name: 'Switch to driver view' }).click();
    const camera = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
    let inspection = null;
    const inspect = page.getByRole('button', { name: 'Inspect car from all sides', exact: true });
    if (await inspect.count()) {
      const inspectBounds = await inspect.boundingBox();
      await inspect.click();
      const orbit = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
      await page.getByRole('button', { name: 'Return to driving camera', exact: true }).click();
      const returned = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
      inspection = { inspectBounds, orbit, returned };
    }
    mobile.push({ width, height, bounds, ...layout, started, camera, inspection });
  }
  const report = { regions, driving, reset, driverView, chaseView, driver, clearance, mobile, errors };
  await writeFile(`artifacts/cyberpunk-${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0, 'No browser errors');
  assert.ok(regions.every(r => !r.contextLost), 'WebGL remains healthy across the city');
  assert.ok(driving.speed > 30 && driving.boosting && driving.firing, 'Driving, boost, and firing work');
  assert.deepEqual(reset.position, [-22, .015, -22], 'R resets the car position');
  assert.equal(reset.speed, 0, 'R stops the car');
  assert.equal(driverView, 'driver', 'C activates cockpit camera');
  assert.equal(chaseView, 'chase', 'Camera button returns to chase camera');
  assert.equal(clearance.blocked.length, 0, 'New city geometry keeps every road clear');
  assert.equal(clearance.stray.length, 0, 'No low inert geometry occupies driving lanes');
  assert.ok(mobile.every(m => m.started && m.camera === 'driver' && !m.contextLost && m.contentWidth <= m.width && m.bounds.x >= 0 && m.bounds.y >= 0 && m.bounds.x + m.bounds.width <= m.width && m.bounds.y + m.bounds.height <= m.height), 'Mobile start and camera controls remain visible and work');
  assert.ok(mobile.every(m => !m.inspection || (m.inspection.orbit === 'orbit' && m.inspection.returned === 'driver' && m.inspection.inspectBounds.x >= 0 && m.inspection.inspectBounds.y >= 0 && m.inspection.inspectBounds.x + m.inspection.inspectBounds.width <= m.width && m.inspection.inspectBounds.y + m.inspection.inspectBounds.height <= m.height)), 'Mobile inspection fits and returns to the previous camera');
} finally { await browser.close(); }
