import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Use the same route, resolution and quality tiers for before/after comparisons.
const label = process.argv[2] || 'after';
assert.match(label, /^[a-z0-9-]+$/);
const directory = 'artifacts/quality-upgrade';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive &&
    !document.querySelector('canvas').__drive.destroyed, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => { document.querySelector('canvas').__drive.qualityWarmup = 1e9; });
  await page.waitForTimeout(4000);
  const setTier = tier => page.evaluate(tier => {
    const g = document.querySelector('canvas').__drive;
    g.qualityLevel = tier; g.reflections.setQuality(tier);
    // Older versions did not connect this quality control; don't change their behavior.
    if (g.presentationPass) g.island.aurora.setQuality(tier);
    g.renderer.shadowMap.enabled = tier < 3;
    g.renderer.shadowMap.needsUpdate = tier < 3;
    g.resize(); g.updateCityVisibility(g.carPosition, tier);
  }, tier);
  await setTier(0);
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false; g.elapsed = 40;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${directory}/${label}-central.png` });
  await page.evaluate(() => { document.querySelector('canvas').__drive.toggleOrbitView(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${directory}/${label}-car.png` });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.toggleOrbitView(); g.toggleCameraView();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${directory}/${label}-driver.png` });
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), 'driver');
  await page.evaluate(() => { document.querySelector('canvas').__drive.toggleCameraView(); });
  await setTier(4);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${directory}/${label}-budget.png` });
  console.log(`${label}: visual captures saved; sampling fixed quality 4`);
  const report = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = true;
    g.carPosition.set(-22, .015, 176); g.car.position.copy(g.carPosition);
    g.velocity.set(0, 0, -48); g.yaw = 0; g.car.rotation.y = 0;
    g.pressed.add('w'); g.pressed.add('f'); g.activateNitro(); g.updateCamera(0, true);
    const gl = g.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const summarize = values => {
      const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
      return { mean: n ? sorted.reduce((a, b) => a + b, 0) / n : 0,
        p50: sorted[Math.floor(n * .5)] || 0, p95: sorted[Math.floor(n * .95)] || 0,
        max: sorted.at(-1) || 0, n };
    };
    const samples = [], cpu = [], gpu = [], queries = [];
    const original = g.composer.render;
    let collecting = false;
    g.composer.render = function(...args) {
      const query = collecting && timer ? gl.createQuery() : null;
      if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        if (collecting) cpu.push(performance.now() - start);
        if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push(query); }
      }
    };
    const start = performance.now();
    let last;
    try {
      await new Promise((resolve, reject) => {
        const tick = time => {
          if (g.destroyed || g !== document.querySelector('canvas').__drive) {
            reject(new Error('Game replaced during comparison')); return;
          }
          if (g.carPosition.z < -176) {
            g.carPosition.z += 352; g.previousPosition.z += 352; g.camera.position.z += 352;
            g.car.position.copy(g.carPosition); g.boostCharge = 100; g.activateNitro();
          }
          const age = performance.now() - start;
          if (age > 6000) {
            collecting = true;
            if (last !== undefined) samples.push({ ms: time - last,
              calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
              speed: g.lastTelemetry.speed, boosting: g.lastTelemetry.boosting, firing: g.lastTelemetry.firing });
            last = time;
          }
          while (timer && queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
            const query = queries.shift();
            if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(query);
          }
          if (age < 22000) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      return { gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), quality: g.qualityLevel,
        canvasPixelRatio: g.renderer.getPixelRatio(), scenePixelRatio: g.composer.readBuffer.width / innerWidth,
        frameMs: summarize(samples.map(s => s.ms)), cpuRenderMs: summarize(cpu), gpuRenderMs: summarize(gpu),
        draws: summarize(samples.map(s => s.calls)), triangles: summarize(samples.map(s => s.triangles)),
        speed: summarize(samples.map(s => s.speed)), boostingFrames: samples.filter(s => s.boosting).length,
        firingFrames: samples.filter(s => s.firing).length, contextLost: gl.isContextLost(),
        passes: g.composer.passes.map(p => p.constructor.name),
        city: g.scene.children.filter(o => o.userData.cityBatchEntries).map(o => ({
          vertices: o.geometry.getAttribute('position').count, indices: o.geometry.index?.count || 0,
          visible: o.visible })), samples };
    } finally {
      g.composer.render = original; g.pressed.clear(); g.active = false;
      queries.forEach(q => gl.deleteQuery(q));
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${directory}/${label}-mobile.png` });
  report.mobile = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { width: innerWidth, contentWidth: document.documentElement.scrollWidth,
      contextLost: g.renderer.getContext().isContextLost(),
      canvas: [g.renderer.domElement.width, g.renderer.domElement.height],
      scene: [g.composer.readBuffer.width, g.composer.readBuffer.height],
      texel: g.presentationPass?.uniforms.sourceTexel?.value.toArray() };
  });
  report.errors = errors;
  await writeFile(`${directory}/${label}.json`, JSON.stringify(report, null, 2));
  const { samples, city, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(errors.length, 0, 'No browser/shader errors');
  assert.equal(report.contextLost, false, 'WebGL stays healthy');
  assert.equal(report.mobile.contextLost, false);
  assert.ok(report.mobile.contentWidth <= report.mobile.width, 'Mobile layout stays within viewport');
  assert.ok(report.frameMs.n > 150 && report.speed.mean > 150, 'Sustained real driving is measured');
  assert.ok(report.boostingFrames > 20 && report.firingFrames > 100, 'Nitro and miniguns run during the comparison');
} finally { await browser.close(); }
