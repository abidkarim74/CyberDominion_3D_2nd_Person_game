import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  const collision = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.active = false;
    const retail = g.colliders.filter(c => c.label === 'Cyberpunk / solid retail podium');
    const blocked = [], gaps = [];
    for (const plan of g.scene.userData.cyberpunkSkyline) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [-1, 1], [1, -1]]) {
        const from = g.camera.position.clone().set(plan.x + dx * 14, 1, plan.z + dz * 14);
        const to = from.clone().set(plan.x + dx * 10.8, 1, plan.z + dz * 10.8);
        if (!g.person.firstContact(from, to)) gaps.push({ x: plan.x, z: plan.z, dx, dz });
      }
    }
    for (let road = -374; road <= 374; road += 44) for (const across of [false, true]) for (const lane of [-4.4, 0, 4.4]) {
      for (let along = -387; along <= 387; along++) {
        const x = across ? along : road + lane, z = across ? road + lane : along;
        const hit = g.collisionWorld.query({ x, z }).find(c => Math.abs(x - c.x) < c.hx + (across ? 2.65 : 1.05) && Math.abs(z - c.z) < c.hz + (across ? 1.05 : 2.65));
        if (hit) { blocked.push({ x, z, label: hit.label }); break; }
      }
    }
    return { buildings: g.scene.userData.cyberpunkSkyline.length, retail: retail.length,
      maxRetailHeight: Math.max(...retail.map(c => c.maxY)), blocked, gaps };
  });
  assert.equal(collision.retail, collision.buildings, 'Every shop block has its own solid ground-floor collider');
  assert.ok(collision.maxRetailHeight < 4.2, 'The wider ground floor does not create upper-level invisible walls');
  assert.deepEqual(collision.gaps, [], 'Walking into any shop side or corner meets the building');
  assert.deepEqual(collision.blocked, [], 'All road lanes retain full vehicle clearance');

  const views = [];
  for (const [name, preset, camera, target] of [
    ['corner', 'medium', [20, 2.4, 17], [9, 1.9, 6]],
    ['front', 'medium', [19, 2.2, 6], [12.2, 1.9, 3]],
    ['roof', 'high', [28, 10, 29], [0, 2, 0]],
    ['corner-low', 'low', [20, 2.4, 17], [9, 1.9, 6]],
  ]) {
    const view = await page.evaluate(({ preset, camera, target }) => {
      const g = document.querySelector('canvas').__drive;
      g.setGraphicsQuality(preset);
      g.camera.position.set(...camera); g.camera.lookAt(...target);
      g.updateCityVisibility(g.camera.position, 0);
      g.renderer.shadowMap.needsUpdate = true;
      g.scene.updateMatrixWorld(true);
      g.composer.render();
      return { preset, contextLost: g.renderer.getContext().isContextLost(), calls: g.renderer.info.render.calls };
    }, { preset, camera, target });
    await page.screenshot({ path: `artifacts/shop-buildings-${name}.png` });
    assert.equal(view.contextLost, false);
    views.push({ name, ...view });
  }
  assert.deepEqual(errors, [], 'No browser or shader errors');
  const report = { collision, views, errors };
  await writeFile('artifacts/shop-buildings-scene.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
