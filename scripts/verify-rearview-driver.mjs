import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const directory = 'artifacts/rearview-driver';
await mkdir(directory, { recursive: true });
const report = { errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  report.driver = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, person = g.person, system = g.drivingMirrors;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity; g.reset(); g.active = false;
    g.setCameraView('driver'); g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
    person.update(0, g.pressed, g.carPosition, g.yaw, 0, []); g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
    system.setPreset('high', 0);
    const mirror = system.mirrors.find(item => item.isRearview), renderer = g.renderer;
    const meshes = []; person.root.traverse(object => { if (object.isMesh) meshes.push(object); });
    const snapshot = () => ({ driverView: person.diagnostics.driverVisibility.driverView, rootVisible: person.root.visible,
      meshes: meshes.map(mesh => ({ uuid: mesh.uuid, geometry: mesh.geometry.uuid, visible: mesh.visible,
        material: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.uuid),
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3 })) });
    const state = () => ({ person: snapshot(), target: renderer.getRenderTarget()?.texture.uuid ?? null,
      viewport: renderer.getViewport(new THREE.Vector4()).toArray(), scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
      scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear, xr: renderer.xr.enabled,
      shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate, car: g.car.visible,
      geometry: system.rearviewOpening.swaps.map(swap => swap.mesh.geometry.uuid), mirrors: system.mirrors.map(item => item.surface.visible) });
    const read = () => {
      const half = new Uint16Array(mirror.target.width * mirror.target.height * 4);
      renderer.readRenderTargetPixels(mirror.target, 0, 0, mirror.target.width, mirror.target.height, half);
      return Uint8Array.from(half, value => Math.round(Math.min(1, Math.max(0, THREE.DataUtils.fromHalfFloat(value))) * 255));
    };
    const capture = () => {
      const before = mirror.captures; system.invalidate();
      for (let i = 0; i < 8 && mirror.captures === before; i++) { g.elapsed += .3; system.update(renderer, g.scene, g.camera, g.elapsed, true); }
      if (mirror.captures === before) throw new Error('Central mirror did not capture');
      return read();
    };
    const difference = (full, masked, whiteOnly = false) => {
      let pixels = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < full.length; i += 4) {
        if (whiteOnly && Math.min(full[i], full[i + 1], full[i + 2]) < 150) continue;
        if (Math.max(...[0, 1, 2].map(channel => Math.abs(full[i + channel] - masked[i + channel]))) < (whiteOnly ? 35 : 5)) continue;
        const x = i / 4 % mirror.target.width, y = Math.floor(i / 4 / mirror.target.width);
        pixels++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      return { pixels, bounds: pixels ? [minX, minY, maxX, maxY] : null };
    };
    const image = data => {
      const canvas = document.createElement('canvas'); canvas.width = mirror.target.width; canvas.height = mirror.target.height;
      const context = canvas.getContext('2d'), frame = context.createImageData(canvas.width, canvas.height), stride = canvas.width * 4;
      for (let y = 0; y < canvas.height; y++) frame.data.set(data.subarray(y * stride, (y + 1) * stride), (canvas.height - 1 - y) * stride);
      context.putImageData(frame, 0, 0); return canvas.toDataURL('image/png');
    };
    const originalSetter = person.setDriverView, originalRender = renderer.render;
    let forceMasked = false;
    const callbacks = [], during = [];
    person.setDriverView = function (enabled) { callbacks.push(enabled); return originalSetter.call(this, forceMasked || enabled); };
    renderer.render = function (scene, camera) {
      if (system.mirrors.some(item => item.camera === camera)) during.push({ central: camera === mirror.camera,
        driverView: person.diagnostics.driverVisibility.driverView, occupantVisible: person.root.visible });
      return originalRender.call(this, scene, camera);
    };
    let full, masked, whiteFull, whiteMasked, normalRestored;
    const before = snapshot(), materialStates = meshes.map(mesh => mesh.material);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false, side: THREE.DoubleSide });
    try {
      full = capture(); normalRestored = snapshot();
      forceMasked = true; masked = capture(); forceMasked = false;
      for (const mesh of meshes) mesh.material = white;
      whiteFull = capture(); forceMasked = true; whiteMasked = capture(); forceMasked = false;
    } finally {
      person.setDriverView = originalSetter; renderer.render = originalRender;
      for (const [index, mesh] of meshes.entries()) mesh.material = materialStates[index];
      person.setDriverView(true); white.dispose();
    }
    const textureHead = difference(full, masked), whiteHead = difference(whiteFull, whiteMasked, true);
    const normalDuring = during.slice(0, Math.max(1, during.findIndex(sample => sample.central) + 1));
    const beforeFailure = state();
    let failureCaught = false, fullHeadAtFailure = false;
    renderer.render = function (scene, camera) {
      if (camera === mirror.camera) { fullHeadAtFailure = !person.diagnostics.driverVisibility.driverView && person.root.visible; throw new Error('Intentional rearview render failure'); }
      return originalRender.call(this, scene, camera);
    };
    try { capture(); } catch (error) { if (error.message !== 'Intentional rearview render failure') throw error; failureCaught = true; }
    finally { renderer.render = originalRender; }
    const afterFailure = state();
    g.setCameraView('chase'); g.updateCamera(0, true); const thirdPerson = snapshot();
    g.setCameraView('driver'); g.updateCamera(0, true); const returned = snapshot();
    const meshCount = meshes.length, fullBodyTriangles = thirdPerson.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);
    capture(); g.composer.render();
    const headBone = person.root.getObjectByName('mixamorigHead') ?? person.root.getObjectByName('Head');
    return { textureHead, whiteHead, before, normalRestored, returned, thirdPerson,
      fullBodyTriangles, driverTriangles: before.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0),
      meshCount, callbacks, normalDuring, failure: { caught: failureCaught, fullHeadAtFailure, before: beforeFailure, after: afterFailure },
      size: [mirror.target.width, mirror.target.height], headLocal: headBone?.getWorldPosition(new THREE.Vector3()).applyMatrix4(g.carRig.body.matrixWorld.clone().invert()).toArray(),
      contextLost: renderer.getContext().isContextLost(), images: { full: image(full), masked: image(masked), white: image(whiteFull), whiteMasked: image(whiteMasked) } };
  });
  for (const [name, data] of Object.entries(report.driver.images)) await writeFile(`${directory}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  delete report.driver.images;
  await page.screenshot({ path: `${directory}/driver.png` });
  const result = report.driver;
  assert.ok(result.textureHead.pixels > 20, 'Actual textured head contributes visible rearview pixels');
  assert.ok(result.whiteHead.pixels > 30, 'GPU mask isolates actual head geometry from the same posed avatar');
  assert.deepEqual(result.normalRestored, result.before, 'Normal capture restores first-person geometry, visibility and materials');
  assert.ok(result.callbacks.includes(false) && result.callbacks.includes(true), 'Center capture unmasks then remasks the driver');
  assert.ok(result.normalDuring.some(sample => sample.central && !sample.driverView && sample.occupantVisible), 'Actual complete occupant is visible during central reflection');
  assert.ok(result.normalDuring.filter(sample => !sample.central).every(sample => !sample.occupantVisible), 'Side captures retain previous occupant exclusion');
  assert.ok(result.failure.caught && result.failure.fullHeadAtFailure, 'Failure test enters the full-head central render');
  assert.deepEqual(result.failure.after, result.failure.before, 'Failed capture restores masking, exterior geometry and renderer state');
  assert.equal(result.thirdPerson.driverView, false); assert.equal(result.returned.driverView, true);
  assert.ok(result.fullBodyTriangles > result.driverTriangles, 'Third-person view restores the complete body');
  assert.deepEqual(result.returned.meshes, result.before.meshes, 'Camera changes reuse the same meshes and cached mask buffers');
  assert.equal(result.contextLost, false); assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ headPixels: result.textureHead, gpuHeadPixels: result.whiteHead, size: result.size, callbacks: result.callbacks, errors: report.errors }));
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
