import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.island?.aurora, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  const views = [];
  for (const [label, x, z, yaw] of [
    ['north', 22, -382, 0], ['east', 382, 22, -Math.PI / 2],
    ['south', 22, 382, Math.PI], ['west', -382, 22, Math.PI / 2],
  ]) {
    await page.evaluate(({ x, z, yaw }) => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.carPosition.set(x, .15, z); g.car.position.copy(g.carPosition);
      g.yaw = g.vehicleMotion.yaw = yaw; g.car.rotation.y = yaw;
      g.updateCamera(0, true); g.qualityTimer = -1000;
    }, { x, z, yaw });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `artifacts/aurora-${label}.png` });
    views.push({ label, time: await page.evaluate(() => document.querySelector('canvas').__drive.island.aurora.uniforms.auroraTime.value) });
  }
  const pixels = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, env = g.island, aurora = env.aurora;
    cancelAnimationFrame(g.animationFrame);
    const sky = g.scene.getObjectByName('Island / blue hour sky and marine haze');
    const isolated = new g.scene.constructor();
    const target = new (g.reflections.mirror.getRenderTarget().constructor)(512, 256);
    const camera = new g.camera.constructor(66, 2, .1, 6500);
    camera.position.set(22, 5, 390); camera.lookAt(22, 175, 1390);
    const oldTime = aurora.uniforms.auroraTime.value, oldDetail = aurora.uniforms.auroraDetail.value;
    const oldTarget = g.renderer.getRenderTarget();
    const capture = () => {
      g.renderer.setRenderTarget(target); g.renderer.render(isolated, camera);
      const values = new Uint8Array(512 * 256 * 4);
      g.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, values);
      return values;
    };
    const difference = (a, b) => {
      let changed = 0, max = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]));
        if (d > 5) changed++;
        max = Math.max(max, d);
      }
      return { changed, max };
    };
    isolated.add(sky);
    aurora.update(0); aurora.uniforms.auroraStrength.value = 0;
    const off = capture();
    aurora.uniforms.auroraStrength.value = 1;
    const on = capture(); aurora.update(15); const animated = capture();
    aurora.update(0); camera.position.x += 750; camera.position.z -= 600;
    const translated = capture();
    aurora.setQuality(3); const reduced = capture();
    env.group.add(sky); isolated.add(env.water);
    camera.position.set(22, 5, 390); camera.lookAt(22, -70, 1390);
    aurora.uniforms.auroraStrength.value = 0; const waterOff = capture();
    aurora.uniforms.auroraStrength.value = 1; const waterOn = capture();
    env.group.add(env.water);
    aurora.uniforms.auroraDetail.value = oldDetail; aurora.update(oldTime);
    g.renderer.setRenderTarget(oldTarget); target.dispose();
    g.previousTime = 0; g.animationFrame = requestAnimationFrame(g.frameHandler);
    return { sky: difference(off, on), motion: difference(on, animated), translation: difference(on, translated),
      reduced: difference(off, reduced), water: difference(waterOff, waterOn) };
  });
  console.log('Aurora GPU pixel probes:', JSON.stringify(pixels));
  assert.ok(pixels.sky.changed > 5000, 'Aurora visibly lights the horizon');
  assert.ok(pixels.motion.changed > 1000, 'GPU pixels change as the aurora flows');
  assert.equal(pixels.translation.changed, 0, 'Distant curtains stay fixed in world direction while driving');
  assert.ok(pixels.reduced.changed > 3000, 'Reduced quality retains the aurora');
  assert.ok(pixels.water.changed > 100, 'Ocean reflects the aurora');

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.carPosition.set(22, .15, 382); g.car.position.copy(g.carPosition);
    g.yaw = g.vehicleMotion.yaw = Math.PI; g.car.rotation.y = Math.PI; g.updateCamera(0, true);
    g.qualityTimer = -1000;
    const gl = g.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const p = window.__auroraProfile = { gl, ext, pending: [], cpu: [], gpu: [] };
    const render = g.composer.render.bind(g.composer);
    g.composer.render = (...args) => {
      const query = ext && p.pending.length < 6 ? gl.createQuery() : null;
      if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const start = performance.now(), result = render(...args);
      p.cpu.push(performance.now() - start);
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); p.pending.push(query); }
      return result;
    };
  });
  await page.waitForTimeout(1500);
  const profile = async (strength, quality) => {
    await page.evaluate(({ strength, quality }) => {
      const a = document.querySelector('canvas').__drive.island.aurora;
      a.uniforms.auroraStrength.value = strength; a.setQuality(quality);
    }, { strength, quality });
    await page.waitForTimeout(400);
    return page.evaluate(async () => {
      const g = document.querySelector('canvas').__drive, p = window.__auroraProfile;
      for (const query of p.pending) p.gl.deleteQuery(query);
      p.pending.length = p.cpu.length = p.gpu.length = 0;
      const frames = [], draws = [], triangles = [];
      let previous = performance.now();
      await new Promise(resolve => {
        function tick(now) {
          frames.push(now - previous); previous = now;
          draws.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
          while (p.pending.length && p.gl.getQueryParameter(p.pending[0], p.gl.QUERY_RESULT_AVAILABLE)) {
            const query = p.pending.shift();
            if (!p.gl.getParameter(p.ext.GPU_DISJOINT_EXT)) p.gpu.push(p.gl.getQueryParameter(query, p.gl.QUERY_RESULT) / 1e6);
            p.gl.deleteQuery(query);
          }
          if (frames.length < 120) requestAnimationFrame(tick); else resolve();
        }
        requestAnimationFrame(tick);
      });
      const summarize = values => {
        const sorted = [...values].sort((a, b) => a-b);
        return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null };
      };
      return { framesMs: summarize(frames), renderCpuMs: summarize(p.cpu), gpuMs: summarize(p.gpu),
        calls: summarize(draws), triangles: summarize(triangles), memory: { ...g.renderer.info.memory }, pixelRatio: g.renderer.getPixelRatio() };
    });
  };
  const without = await profile(0, 0), withAurora = await profile(1, 0), reduced = await profile(1, 3), withoutAgain = await profile(0, 0);
  const baselineMedian = (without.framesMs.median + withoutAgain.framesMs.median) / 2;
  assert.equal(withAurora.calls.median, without.calls.median, 'Aurora adds no draw calls');
  assert.equal(withAurora.triangles.median, without.triangles.median, 'Aurora adds no triangles');
  assert.deepEqual(withAurora.memory, without.memory, 'Animation allocates no geometry or textures');
  assert.ok(withAurora.framesMs.median < baselineMedian + 3, 'Aurora keeps median frames within 3 ms of baseline');
  assert.ok(withAurora.framesMs.p95 < Math.max(without.framesMs.p95, withoutAgain.framesMs.p95) + 8, 'Aurora keeps p95 frames within 8 ms of baseline');
  const updates = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, a = g.island.aurora;
    const pixels = a.texture.image.data.slice(), textureVersion = a.texture.version;
    const geometry = g.island.water.geometry, start = performance.now();
    for (let i = 0; i < 10000; i++) a.update(i / 60);
    const cpuMs = (performance.now() - start) / 10000;
    a.uniforms.auroraStrength.value = 1; a.setQuality(g.qualityLevel); a.update(g.elapsed);
    const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { cpuMs, immutable: pixels.every((p, i) => p === a.texture.image.data[i]) && a.texture.version === textureVersion && geometry === g.island.water.geometry,
      contextLost: gl.isContextLost(), gpu: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), textureBytes: a.texture.image.data.byteLength };
  });
  assert.ok(updates.cpuMs < .05 && updates.immutable, 'Aurora updates only a uniform, without CPU geometry or texture uploads');
  assert.equal(updates.contextLost, false);
  await page.keyboard.press('c'); await page.waitForTimeout(350);
  await page.screenshot({ path: 'artifacts/aurora-driver.png' });
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'driver');
  await page.keyboard.press('c'); await page.keyboard.press('o'); await page.waitForTimeout(350);
  await page.screenshot({ path: 'artifacts/aurora-inspect.png' });
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'orbit');
  await page.keyboard.press('o'); await page.keyboard.press('r');
  const beforeDriving = await page.evaluate(() => document.querySelector('canvas').__drive.carPosition.z);
  await page.keyboard.down('w'); await page.keyboard.down('Shift'); await page.waitForTimeout(1400);
  await page.keyboard.up('w'); await page.keyboard.up('Shift');
  const driving = await page.evaluate(before => { const g = document.querySelector('canvas').__drive;
    return { moved: Math.abs(g.carPosition.z - before), speed: g.velocity.length() }; }, beforeDriving);
  assert.ok(driving.moved > 5 && driving.speed > 5, 'Driving and boosting continue with the aurora');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive;
    g.reset(); g.carPosition.set(22, .15, 382); g.car.position.copy(g.carPosition);
    g.yaw = g.vehicleMotion.yaw = Math.PI; g.car.rotation.y = Math.PI; g.updateCamera(0, true); g.island.aurora.setQuality(3); });
  await page.waitForTimeout(350); await page.screenshot({ path: 'artifacts/aurora-mobile.png' });
  const report = { pixels, views, performance: { without, withAurora, reduced, withoutAgain }, updates, driving, errors };
  await writeFile('artifacts/aurora-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No browser, shader, or runtime errors');
} finally { await browser.close(); }
