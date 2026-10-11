import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts/blender', { recursive: true });
const asset = JSON.parse(await readFile('lib/blender-car-model.json', 'utf8'));
for (const mesh of asset.meshes) {
  assert.equal(Buffer.from(mesh.position, 'base64').length, mesh.vertices * 6);
  assert.equal(Buffer.from(mesh.normal, 'base64').length, mesh.vertices * 6);
  assert.equal(Buffer.from(mesh.uv, 'base64').length, mesh.vertices * 4);
  const indices = Buffer.from(mesh.index, 'base64');
  assert.equal(indices.length, mesh.triangles * 6);
  for (let i = 0; i < indices.length; i += 2) assert.ok(indices.readUInt16LE(i) < mesh.vertices);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const response = await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(1500);
  const model = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false;
    cancelAnimationFrame(g.animationFrame);
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0);
    g.car.updateWorldMatrix(true, true);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let meshes = 0, triangles = 0, totalMeshes = 0, totalTriangles = 0;
    const p = g.carPosition.clone();
    g.car.traverse(o => {
      if (o.isMesh) {
        totalMeshes++;
        totalTriangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      }
      if (!o.isMesh || !o.visible) return;
      for (let parent = o.parent; parent; parent = parent.parent) if (!parent.visible) return;
      meshes++; triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      if (o.material.transparent) return;
      const position = o.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        p.fromBufferAttribute(position, i); o.localToWorld(p); p.sub(g.carPosition);
        for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], p.getComponent(j)); max[j] = Math.max(max[j], p.getComponent(j)); }
      }
    });
    return { source: g.carRig.body.userData.bodyModel, min, max, width: max[0] - min[0], length: max[2] - min[2], height: max[1], meshes, triangles, totalMeshes, totalTriangles, passes: g.composer.passes.length };
  });
  assert.equal(model.source, 'Blender / Bugatti Chiron');
  console.log('Model budget:', JSON.stringify(model));
  assert.ok(model.width <= 2.14 && model.length <= 5.4 && model.height < 1.6, 'Fits the existing collision clearance');
  // The sculpted Bugatti cabin adds about 3k triangles while retaining material batching.
  assert.ok(model.totalTriangles <= 34000 && model.totalMeshes <= 110, 'Detailed car and cabin stay inside game rendering budgets, including hidden effects and weapons');

  const capture = async (name, x, y, z, fov = 45, targetY = .76) => {
    await page.evaluate(({ x, y, z, fov, targetY }) => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x, y, z });
      g.camera.fov = fov; g.camera.updateProjectionMatrix();
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: targetY, z: 0 }));
      g.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 3; i++) g.composer.render();
    }, { x, y, z, fov, targetY });
    await page.screenshot({ path: `artifacts/blender/${name}.png` });
  };
  await page.addStyleTag({ content: '.drive-hud,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident,.screen-grade,.scanlines{display:none !important}' });
  await capture('bugatti-city-front', -4.6, 2.1, -6.0);
  await capture('bugatti-city-rear', -4.6, 2.1, 6.0);

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.scene.fog = null; g.scene.background = g.keyLight.color.clone().setHex(0x9faeb9);
    g.composer.passes[1].enabled = false;
    g.renderer.setPixelRatio(1.5); g.composer.setPixelRatio(1.5);
    let directional = 0;
    for (const o of g.scene.children) {
      if (o === g.car) continue;
      o.visible = !!(o.isHemisphereLight || o.isAmbientLight || o.isDirectionalLight);
      if (o.isHemisphereLight) { o.color.setHex(0xf1f4ff); o.groundColor.setHex(0x56616c); o.intensity = 2.3; }
      if (o.isAmbientLight) { o.color.setHex(0xffffff); o.intensity = .4; }
      if (o.isDirectionalLight) {
        o.color.setHex(0xffffff); o.intensity = directional === 0 ? 3.2 : 2; o.castShadow = false;
        o.position.copy(g.carPosition).add({ x: directional === 0 ? -4 : 4, y: 6, z: directional === 0 ? -5 : 4 });
        o.target.position.copy(g.carPosition); o.target.updateMatrixWorld(); directional++;
      }
    }
    g.car.traverse(o => { if (o.isLight) o.visible = false; });
  });
  for (const [name, x, y, z] of [['bugatti-studio-front', -5.4, 2.45, -6.0], ['bugatti-studio-rear', -5.4, 2.45, 6.0], ['bugatti-studio-left', -6.9, 1.35, 0], ['bugatti-studio-right', 6.9, 1.35, 0]]) await capture(name, x, y, z);
  await capture('bugatti-hero', -4.3, 1.9, -5.2, 35, .65);

  // Fresh scene verifies animated parts, keyboard input and driver camera integration.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.keyboard.down('w');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.velocity.length() > 2, null, { timeout: 15000 });
  await page.keyboard.up('w');
  const motion = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { speed: g.velocity.length(), position: g.carPosition.toArray(), wheels: g.carRig.wheels.map(w => w.rotation.x) };
  });
  assert.ok(motion.speed > 2 && motion.position[2] < -.5 && motion.wheels.every(angle => Math.abs(angle) > .1));
  await page.keyboard.press('r');
  const idleWeaponsHidden = await page.evaluate(() => document.querySelector('canvas').__drive.carRig.gunBarrels.every(gun => !gun.parent.visible));
  assert.equal(idleWeaponsHidden, true, 'Weapons retract for the reference car appearance while idle');
  await page.keyboard.down('f');
  const weapons = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const observedFlashes = g.carRig.muzzleFlashes.map(() => false);
    const start = performance.now();
    await new Promise(resolve => {
      function observe(now) {
        g.carRig.muzzleFlashes.forEach((flash, i) => {
          let visible = flash.visible;
          for (let p = flash.parent; p; p = p.parent) visible &&= p.visible;
          observedFlashes[i] ||= visible;
        });
        if (now - start < 600) requestAnimationFrame(observe); else resolve();
      }
      requestAnimationFrame(observe);
    });
    return { spinning: g.carRig.gunBarrels.every(o => Math.abs(o.rotation.z) > .1), flashes: observedFlashes.every(Boolean), mountsVisible: g.carRig.gunBarrels.every(gun => gun.parent.visible) };
  });
  await page.keyboard.up('f');
  assert.ok(weapons.spinning && weapons.flashes && weapons.mountsVisible);
  await page.waitForFunction(() => document.querySelector('canvas').__drive.carRig.gunBarrels.every(gun => !gun.parent.visible));
  weapons.idleHidden = idleWeaponsHidden;
  weapons.retractedAfterFiring = true;
  await page.keyboard.press('c'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'driver');
  await page.screenshot({ path: 'artifacts/blender/bugatti-driver.png' });
  await page.keyboard.press('o'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'orbit');
  await page.keyboard.press('o');

  const performance = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive, times = []; let last = window.performance.now();
    await new Promise(resolve => { function sample(now) { times.push(now-last); last=now; if(times.length<90) requestAnimationFrame(sample); else resolve(); } requestAnimationFrame(sample); });
    times.sort((a,b) => a-b);
    return { medianMs: times[45], p95Ms: times[85], contextLost: g.renderer.getContext().isContextLost(), passes: g.composer.passes.length };
  });
  assert.equal(performance.contextLost, false); assert.equal(performance.passes, 4);
  assert.deepEqual(errors, []);
  const report = { model, motion, weapons, performance, errors };
  await writeFile('artifacts/blender/bugatti-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
