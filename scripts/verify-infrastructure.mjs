import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://localhost:3001/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY' }).click();
  await page.waitForTimeout(3500);
  const routes = await page.evaluate(() => document.querySelector('canvas').__drive.coveredRoads.slice(1));
  const results = [];
  for (const [index, route] of routes.entries()) {
    const side = route.hx > route.hz;
    await page.evaluate(({route, side}) => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.active = true;
      g.carPosition.set(route.x + (side ? route.hx + 5 : 0), .015, route.z + (side ? 0 : route.hz + 5));
      g.car.position.copy(g.carPosition); g.yaw = side ? Math.PI / 2 : 0; g.car.rotation.y = g.yaw;
      g.camera.position.copy(g.carPosition); g.camera.position.y = 3.2;
      g.camera.position.x += side ? 8.4 : 0; g.camera.position.z += side ? 0 : 8.4;
    }, {route, side});
    await page.keyboard.down('w'); await page.waitForTimeout(1200); await page.keyboard.up('w');
    const result = await page.evaluate(({route, side}) => {
      const g = document.querySelector('canvas').__drive;
      const position = g.carPosition.toArray();
      const moved = side ? route.x + route.hx + 5 - position[0] : route.z + route.hz + 5 - position[2];
      g.active = false; g.velocity.set(0, 0, 0);
      const insideCollider = g.colliders.some(b => Math.abs(position[0] - b.x) < b.hx + .88 && Math.abs(position[2] - b.z) < b.hz + 2.06);
      return { label: route.label, position, moved, insideCollider };
    }, {route, side});
    assert.ok(result.moved > 10, `${route.label} allows driving`);
    assert.equal(result.insideCollider, false, `${route.label} has clear lanes`);
    await page.screenshot({ path: `artifacts/route-${index + 1}.png` });
    await page.evaluate(() => { document.querySelector('canvas').__drive.active = true; });
    await page.keyboard.down('w');
    await page.waitForFunction(({route, side}) => {
      const p = document.querySelector('canvas').__drive.carPosition;
      return side ? p.x < route.x - route.hx - 4 : p.z < route.z - route.hz - 4;
    }, {route, side}, {timeout: 10000});
    await page.keyboard.up('w');
    result.exited = true;
    results.push(result);
  }
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.reset();
    g.scene.updateMatrixWorld(true); g.camera.fov = 43; g.camera.updateProjectionMatrix();
    g.camera.position.set(5.3, 2.3, 6); g.camera.lookAt(0, .65, 0);
    g.renderer.shadowMap.needsUpdate = true; g.composer.render();
  });
  await page.screenshot({ path: 'artifacts/car-rear-detail.png' });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.camera.position.set(5.3, 2.1, -6); g.camera.lookAt(0, .65, 0); g.composer.render();
  });
  await page.screenshot({ path: 'artifacts/car-front-detail.png' });
  assert.equal(errors.length, 0, 'No runtime or console errors on added routes');
  await writeFile('artifacts/infrastructure-verification.json', JSON.stringify({routes: results, errors}, null, 2));
  console.log(JSON.stringify({routes: results, errors}, null, 2));
} finally { await browser.close(); }
