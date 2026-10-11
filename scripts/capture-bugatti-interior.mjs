import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  await page.waitForTimeout(800);
  const model = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false; cancelAnimationFrame(g.animationFrame);
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true);
    let triangles = 0, meshes = 0, cabinTriangles = 0;
    const materials = new Set();
    g.car.traverse(o => {
      if (!o.isMesh) return;
      const count = (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      meshes++; triangles += count;
      if (o.userData.cockpitDetail) { cabinTriangles += count; materials.add(o.material.name); }
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = o.geometry.attributes[name];
        if (attribute && !Array.from(attribute.array).every(Number.isFinite)) throw new Error(`Invalid ${name} in ${o.name}`);
      }
    });
    g.renderer.shadowMap.needsUpdate = true; g.composer.render();
    return { triangles, meshes, cabinTriangles, materials: [...materials], interior: g.carRig.body.userData.interior, contextLost: g.renderer.getContext().isContextLost() };
  });
  console.log(JSON.stringify(model, null, 2));
  assert.equal(model.contextLost, false);
  assert.ok(model.materials.some(name => name.includes('diamond stitched')));
  assert.ok(model.materials.some(name => name.includes('live analog')));
  await page.screenshot({ path: 'artifacts/bugatti-interior-driver.png' });
  await page.addStyleTag({ content: '.drive-hud,.city-minimap,.camera-toggle,.car-inspect-toggle,.car-inspect-help,.city-ident,.screen-grade,.scanlines{display:none!important}' });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.scene.fog = null; g.scene.background = g.keyLight.color.clone().setHex(0x77838e);
    g.composer.passes[1].enabled = false;
    g.renderer.setPixelRatio(1.5); g.composer.setPixelRatio(1.5);
    let index = 0;
    for (const o of g.scene.children) {
      if (o === g.car) continue;
      o.visible = !!(o.isHemisphereLight || o.isAmbientLight || o.isDirectionalLight);
      if (o.isHemisphereLight) { o.color.setHex(0xe5edf5); o.groundColor.setHex(0x72777e); o.intensity = 2; }
      if (o.isAmbientLight) { o.color.setHex(0xffffff); o.intensity = .65; }
      if (o.isDirectionalLight) {
        o.color.setHex(0xffffff); o.intensity = index === 0 ? 2.2 : 1.5; o.castShadow = false;
        o.position.copy(g.carPosition).add({ x: index++ === 0 ? -2 : 3, y: 4, z: 2 });
        o.target.position.copy(g.carPosition); o.target.updateMatrixWorld();
      }
    }
    // A cutaway exposes the actual cabin meshes for seat, stitching and fit QA.
    g.car.traverse(o => { if (o.isMesh && !o.userData.cockpitDetail) o.visible = false; if (o.isLight) o.visible = false; });
  });
  async function capture(name, position, target, fov) {
    await page.evaluate(({ position, target, fov }) => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x: position[0], y: position[1], z: position[2] });
      g.camera.lookAt(g.carPosition.clone().add({ x: target[0], y: target[1], z: target[2] }));
      g.camera.fov = fov; g.camera.updateProjectionMatrix();
      for (let i = 0; i < 3; i++) g.composer.render();
    }, { position, target, fov });
    await page.screenshot({ path: `artifacts/${name}.png` });
  }
  await capture('bugatti-interior-overview', [0, 1.20, .57], [0, .66, -.32], 78);
  await capture('bugatti-interior-cutaway', [1.85, 1.9, 1.56], [0, .77, -.03], 42);
  await capture('bugatti-interior-seats', [.03, 1.08, -.57], [.05, .71, .34], 79);
  assert.deepEqual(errors, []);
  await writeFile('artifacts/bugatti-interior-visual-qa.json', JSON.stringify({ model, errors }, null, 2));
} finally { await browser.close(); }
