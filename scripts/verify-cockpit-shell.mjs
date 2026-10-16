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
    const glass = g.carRig.body.children.find(o => o.userData.carPart === 'body' && o.material?.name === 'Bugatti cabin / clear inner laminated windows');
    const canvas = { width: g.renderer.domElement.width, height: g.renderer.domElement.height };
    // Read a retained GPU target; the default WebGL canvas can be discarded
    // between browser compositing and canvas readback (preserveDrawingBuffer=false).
    const target = new g.composer.renderTarget1.constructor(canvas.width, canvas.height);
    target.texture.colorSpace = g.renderer.outputColorSpace;
    const pixels = () => {
      const previousTarget = g.renderer.getRenderTarget(), data = new Uint8Array(canvas.width * canvas.height * 4);
      g.renderer.setRenderTarget(target); g.renderer.render(g.scene, g.camera);
      g.renderer.readRenderTargetPixels(target, 0, 0, canvas.width, canvas.height, data);
      g.renderer.setRenderTarget(previousTarget);
      // GPU readback starts at the bottom; comparisons use screen coordinates.
      const flipped = new Uint8Array(data.length), stride = canvas.width * 4;
      for (let y = 0; y < canvas.height; y++) flipped.set(data.subarray(y * stride, (y + 1) * stride), (canvas.height - y - 1) * stride);
      return flipped;
    };
    const changedPixels = (before, after, lower, upper, threshold = 4) => {
      let count = 0;
      for (let y = Math.floor(canvas.height * lower); y < canvas.height * upper; y++) for (let x = Math.floor(canvas.width * .25); x < canvas.width * .8; x++) {
        const i = (y * canvas.width + x) * 4;
        if (Math.max(...[0, 1, 2].map(channel => Math.abs(before[i + channel] - after[i + channel]))) > threshold) count++;
      }
      return count;
    };
    const withGlass = pixels(); glass.visible = false; const withoutGlass = pixels(); glass.visible = true;
    const windshieldPixels = changedPixels(withGlass, withoutGlass, .05, .60, 1);

    // Isolate actual bonnet triangles, then measure their contribution to the
    // driver image. A material/property check alone cannot catch an occluded hood.
    // The current two-tone bonnet includes carbon as well as painted panels.
    const sources = g.carRig.body.children.filter(o => o.isMesh &&
      (o.material?.userData.vehiclePaint && /gloss clearcoat$/.test(o.material.name) || o.material?.name === 'Car / resin-coated woven carbon'));
    const bonnetParts = []; let bonnetTriangles = 0;
    for (const source of sources) {
      const geometry = source.geometry.clone(), position = geometry.attributes.position, sourceIndex = geometry.index, indices = [];
      for (let i = 0; i < (sourceIndex?.count ?? position.count); i += 3) {
        const triangle = [0, 1, 2].map(j => sourceIndex ? sourceIndex.getX(i + j) : i + j);
        if (triangle.every(j => position.getZ(j) < -1.40 && position.getY(j) > .70 && Math.abs(position.getX(j)) < .67)) indices.push(...triangle);
      }
      if (!indices.length) { geometry.dispose(); continue; }
      bonnetTriangles += indices.length / 3; geometry.setIndex(indices);
      const material = source.material.clone(); material.color.setHex(0x00ff00); material.emissive.setHex(0x00ff00); material.emissiveIntensity = 4; material.toneMapped = false;
      const mesh = new source.constructor(geometry, material); source.parent.add(mesh);
      bonnetParts.push({ mesh, source, wasVisible: source.visible }); source.visible = false;
    }
    const withBonnet = pixels(); bonnetParts.forEach(({ mesh }) => { mesh.visible = false; }); const withoutBonnet = pixels();
    const bonnetPixels = changedPixels(withBonnet, withoutBonnet, .25, .75);
    for (const { mesh, source, wasVisible } of bonnetParts) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); source.visible = wasVisible; }
    mirror.visible = mirrorVisible;
    target.dispose();
    let invalidGeometry = 0;
    g.car.traverse(o => { if (o.isMesh) for (const name of ['position', 'normal', 'uv']) { const attribute = o.geometry.attributes[name]; if (attribute && !Array.from(attribute.array).every(Number.isFinite)) invalidGeometry++; } });
    const eye = g.camera.position.clone().sub(g.carPosition).toArray();
    const resourcesBefore = { ...g.renderer.info.memory };
    for (let i = 0; i < 12; i++) g.toggleCameraView();
    const resourcesAfter = { ...g.renderer.info.memory };
    g.composer.render();
    return { windshieldPixels, bonnetPixels, eye, invalidGeometry, resourcesBefore, resourcesAfter, draws: g.renderer.info.render.calls, passes: g.composer.passes.length, contextLost: g.renderer.getContext().isContextLost(),
      diagnostic: { meanPixel: withGlass.reduce((sum, value) => sum + value, 0) / withGlass.length,
        glassPart: glass.userData.carPart, glassMaterialVisible: glass.material.visible, glassOpacity: glass.material.opacity,
        bonnetTriangles, cameraFov: g.camera.fov, cameraTarget: g.cameraTarget.toArray() } };
  });
  console.log('Cockpit visibility:', JSON.stringify({ windshieldPixels: report.windshieldPixels, bonnetPixels: report.bonnetPixels, eye: report.eye, diagnostic: report.diagnostic }));
  assert.ok(report.windshieldPixels > 500, 'Windshield glass visibly renders from the driver seat');
  assert.ok(report.bonnetPixels > 500, 'Actual bonnet surface is visible beyond the dashboard');
  assert.equal(report.invalidGeometry, 0);
  assert.equal(report.contextLost, false);
  assert.equal(report.passes, 3, 'Cockpit uses the existing scene, bloom and output pipeline');
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
