import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts/car-realism', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true, timeout: 90000 });
  const model = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.reset(); g.active = false;
    g.person.root.visible = false; g.qualityWarmup = Infinity;
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0);
    const parts = [], materials = new Set();
    g.car.traverse(mesh => {
      if (!mesh.isMesh) return;
      for (let parent = mesh; parent; parent = parent.parent) if (parent === g.person.root) return;
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        assertFinite(attribute.array, mesh.name);
      }
      parts.push({ name: mesh.name, material: mesh.material.name,
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3 });
      materials.add(mesh.material.name);
    });
    function assertFinite(array, name) { for (const value of array) if (!Number.isFinite(value)) throw new Error(`Non-finite geometry in ${name}`); }
    return { parts, triangles: parts.reduce((sum, part) => sum + part.triangles, 0), meshes: parts.length,
      materials: [...materials], exterior: g.carRig.body.userData.exteriorDetails,
      contextLost: g.renderer.getContext().isContextLost() };
  });
  console.log('Assembled car:', JSON.stringify({ triangles: model.triangles, meshes: model.meshes, exterior: model.exterior }));
  // Includes the cabin, wheels, effects/weapons, and intact authored door/window
  // boundaries. Those thin frames retain their topology to prevent panel gaps.
  assert.ok(model.triangles <= 85000 && model.meshes <= 125, 'Complete car stays in a bounded rendering budget');
  assert.equal(model.exterior.enclosedWheelhouses, 4);
  assert.equal(model.contextLost, false);

  await page.addStyleTag({ content: '.drive-hud,.person-hud,.person-interaction,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident,.screen-grade,.scanlines{display:none!important}' });
  const capture = async (name, position, target, fov = 42) => {
    await page.evaluate(({ position, target, fov }) => {
      const g = document.querySelector('canvas').__drive, vector = g.carPosition.clone();
      g.camera.position.copy(g.carPosition).add(vector.set(...position));
      g.camera.lookAt(g.carPosition.clone().add(vector.set(...target)));
      g.camera.near = .025; g.camera.fov = fov; g.camera.updateProjectionMatrix();
      g.scene.updateMatrixWorld(true); g.renderer.shadowMap.needsUpdate = true;
      g.renderer.info.reset();
      for (let i = 0; i < 3; i++) g.composer.render();
    }, { position, target, fov });
    await page.screenshot({ path: `artifacts/car-realism/${name}.png`, timeout: 90000 });
  };
  await capture('city-front', [-4.4, 1.75, -4.8], [0, .65, -.1]);
  await capture('city-rear', [-4.4, 1.85, 4.8], [0, .65, .15]);
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.scene.fog = null; g.scene.background = g.keyLight.color.clone().setHex(0x65707e);
    g.bloomPass.enabled = false;
    g.renderer.setPixelRatio(1.5); g.composer.setPixelRatio(1.5);
    let index = 0;
    for (const object of g.scene.children) {
      if (object === g.car) continue;
      object.visible = !!(object.isHemisphereLight || object.isAmbientLight || object.isDirectionalLight);
      if (object.isHemisphereLight) { object.color.setHex(0xeaf1fa); object.groundColor.setHex(0x56616b); object.intensity = 2.1; }
      if (object.isAmbientLight) { object.color.setHex(0xffffff); object.intensity = .35; }
      if (object.isDirectionalLight) {
        object.color.setHex(0xffffff); object.intensity = index === 0 ? 2.6 : 1.8; object.castShadow = false;
        object.position.copy(g.carPosition).add({ x: index++ === 0 ? -4 : 4, y: 6, z: -3 });
        object.target.position.copy(g.carPosition); object.target.updateMatrixWorld();
      }
    }
    g.car.traverse(object => { if (object.isLight) object.visible = false; });
  });
  await capture('studio-front', [-4.3, 1.9, -4.9], [0, .67, -.1], 36);
  await capture('studio-rear', [-4.3, 1.9, 4.9], [0, .67, .1], 36);
  await capture('wheel', [-1.9, .70, -2.18], [-.87, .40, -1.43], 36);
  await capture('engine', [-1.9, 2.50, 2.3], [0, .88, 1.24], 39);
  console.log('Visual views captured');

  await page.reload({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true, timeout: 90000 });
  await page.keyboard.down('w');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.velocity.length() > 3, null, { timeout: 20000 });
  await page.keyboard.up('w');
  const motion = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { speed: g.velocity.length(), wheels: g.carRig.wheels.map(wheel => wheel.rotation.x),
      rotors: g.carRig.brakeDiscs.map(disc => ({ dynamic: disc.userData.dynamic, parent: g.carRig.wheels.includes(disc.parent) })) };
  });
  assert.ok(motion.wheels.every(angle => Math.abs(angle) > .1), 'All wheels rotate while driving');
  assert.ok(motion.rotors.every(rotor => rotor.dynamic && rotor.parent), 'Thermal discs remain on rotating wheels');
  await page.keyboard.press('r');
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'driver');
  await page.screenshot({ path: 'artifacts/car-realism/driver.png', timeout: 90000 });
  await page.keyboard.press('o');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'orbit');
  await page.waitForTimeout(8000);
  // Compare on the supported budget tier after camera/shader warmup; leave
  // automatic tier transitions out of the fixed-resolution sample.
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.qualityLevel = 4; g.qualityWarmup = Infinity;
    g.renderer.shadowMap.enabled = false;
    g.resize(); g.updateCityVisibility(g.carPosition, 4);
  });
  await page.waitForTimeout(3000);
  const performance = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive, times = [], draws = [];
    let last = window.performance.now();
    await new Promise(resolve => {
      function sample(now) {
        times.push(now - last); last = now; draws.push(g.renderer.info.render.calls);
        if (times.length < 90) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    times.sort((a, b) => a - b); draws.sort((a, b) => a - b);
    return { medianMs: times[45], p95Ms: times[85], drawCalls: draws[45], quality: g.qualityLevel,
      pixelRatio: g.renderer.getPixelRatio(), contextLost: g.renderer.getContext().isContextLost() };
  });
  assert.equal(performance.contextLost, false);
  assert.deepEqual(errors, [], 'No browser or shader errors');
  await writeFile('artifacts/car-realism/verification.json', JSON.stringify({ model, motion, performance, errors }, null, 2));
  console.log(JSON.stringify({ motion, performance, errors }, null, 2));
} finally { await browser.close(); }
