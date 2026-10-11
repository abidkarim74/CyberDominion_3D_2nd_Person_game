import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.active = false;
    cancelAnimationFrame(g.animationFrame);
    g.reset();
    g.carRig.body.position.y = 0;
    g.carRig.body.rotation.set(0, 0, 0);
    g.car.updateWorldMatrix(true, true);
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(innerWidth, innerHeight);
    g.composer.setPixelRatio(1);
    g.composer.setSize(innerWidth, innerHeight);
    g.composer.passes[1].enabled = false;
    g.scene.fog = null;
    g.scene.background = g.keyLight.color.clone().setHex(0xa5b0ba);
    let directional = 0;
    for (const object of g.scene.children) {
      if (object === g.car) continue;
      object.visible = !!(object.isHemisphereLight || object.isAmbientLight || object.isDirectionalLight);
      if (object.isHemisphereLight) {
        object.color.setHex(0xf1f4ff); object.groundColor.setHex(0x56616c); object.intensity = 2.3;
      }
      if (object.isAmbientLight) { object.color.setHex(0xffffff); object.intensity = .4; }
      if (object.isDirectionalLight) {
        object.color.setHex(0xffffff); object.intensity = directional === 0 ? 3.2 : 2;
        object.castShadow = false;
        object.position.copy(g.carPosition).add({ x: directional === 0 ? -4 : 4, y: 6, z: directional === 0 ? -5 : 4 });
        object.target.position.copy(g.carPosition); object.target.updateMatrixWorld(); directional++;
      }
    }
    g.car.traverse(object => { if (object.isLight) object.visible = false; });
  });
  await page.addStyleTag({ content: '.drive-hud,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident,.screen-grade,.scanlines{display:none !important}' });
  for (const [label, x, y, z] of [['left', -7.2, 1.25, 0], ['right', 7.2, 1.25, 0], ['front-quarter', -5.8, 2.4, -6.2], ['rear-quarter', -5.8, 2.4, 6.2]]) {
    await page.evaluate(({ x, y, z }) => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x, y, z });
      g.camera.fov = 45; g.camera.updateProjectionMatrix();
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: .70, z: 0 }));
      for (let frame = 0; frame < 3; frame++) g.composer.render();
    }, { x, y, z });
    await page.screenshot({ path: `artifacts/car-side-shell-studio-${label}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('Captured both sides and quarter views of the actual car with neutral QA lighting; no browser errors.');
} finally { await browser.close(); }
