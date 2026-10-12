import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const errors = [];
const label = process.argv[2] || '';
console.log('Starting one clean browser for sustained adaptive driving');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.text().startsWith('SUSTAINED ')) console.log(message.text().slice(10));
  });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive && !document.querySelector('canvas').__drive.destroyed, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  const report = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = true; g.yaw = 0; g.car.rotation.y = 0;
    g.carPosition.set(-22, .015, 176); g.car.position.copy(g.carPosition);
    g.velocity.set(0, 0, -28);
    for (const key of ['w', 'shift', 'f']) g.pressed.add(key);
    g.updateCamera(0, true);
    const qualityTimeline = [];
    const wraps = [];
    const testStart = performance.now();
    let priorQuality = -1;
    const maintainRoute = () => {
      if (g !== document.querySelector('canvas').__drive || g.destroyed) throw new Error('Game replaced during sustained test');
      if (g.qualityLevel !== priorQuality) {
        priorQuality = g.qualityLevel;
        const change = { seconds: (performance.now() - testStart) / 1000, quality: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), adaptiveAverageMs: g.averageFrame };
        qualityTimeline.push(change);
        console.log(`SUSTAINED Quality ${change.quality} at ${change.seconds.toFixed(1)}s; adaptive mean=${change.adaptiveAverageMs.toFixed(1)}ms`);
      }
      if (g.carPosition.z < -176) {
        const shift = 352;
        g.carPosition.z += shift; g.car.position.copy(g.carPosition);
        g.previousPosition.z += shift; g.camera.position.z += shift;
        g.boostCharge = 100;
        wraps.push((performance.now() - testStart) / 1000);
      }
    };
    console.log('SUSTAINED Warming driving and natural adaptive quality for 22 seconds');
    await new Promise((resolve, reject) => {
      const tick = () => {
        try { maintainRoute(); } catch (error) { reject(error); return; }
        if (performance.now() - testStart < 22000) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    const gl = g.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [], gpuMs = [], cpuRenderMs = [], cpuDrivingMs = [];
    const originalRender = g.composer.render;
    const originalDriving = g.updateDriving;
    g.composer.render = function(...args) {
      const query = timer && gl.createQuery();
      if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      const start = performance.now();
      try { return originalRender.apply(this, args); }
      finally {
        cpuRenderMs.push(performance.now() - start);
        if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push(query); }
      }
    };
    g.updateDriving = function(...args) {
      const start = performance.now();
      try { return originalDriving.apply(this, args); }
      finally { cpuDrivingMs.push(performance.now() - start); }
    };
    const summarize = values => {
      const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
      return { p50: sorted[Math.floor(n * .5)] || 0, p95: sorted[Math.floor(n * .95)] || 0, p99: sorted[Math.floor(n * .99)] || 0, max: sorted.at(-1) || 0, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : 0, n };
    };
    const samples = [];
    const sampleStart = performance.now();
    let previousTime;
    console.log(`SUSTAINED Sampling 10 seconds through dense central avenue, initial quality ${g.qualityLevel}`);
    try {
      await new Promise((resolve, reject) => {
        const tick = time => {
          try { maintainRoute(); } catch (error) { reject(error); return; }
          if (previousTime !== undefined) samples.push({ frameMs: time - previousTime, quality: g.qualityLevel, calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles, speedKmh: g.velocity.length() * 3.6, boosting: g.lastTelemetry.boosting, seconds: (performance.now() - sampleStart) / 1000 });
          previousTime = time;
          while (timer && pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
            const query = pending.shift();
            if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(query);
          }
          if (performance.now() - sampleStart < 10000) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      const frames = samples.map(s => s.frameMs);
      return { gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), qualityTimeline, warmupSeconds: (sampleStart - testStart) / 1000, durationSeconds: (performance.now() - sampleStart) / 1000, finalQuality: g.qualityLevel, finalPixelRatio: g.renderer.getPixelRatio(), frameMs: summarize(frames), frameRatios: Object.fromEntries([20, 25, 33, 50].map(limit => [`over${limit}Ms`, frames.filter(v => v > limit).length / Math.max(1, frames.length)])), perTier: Object.fromEntries([...new Set(samples.map(s => s.quality))].map(tier => [tier, summarize(samples.filter(s => s.quality === tier).map(s => s.frameMs))])), calls: summarize(samples.map(s => s.calls)), triangles: summarize(samples.map(s => s.triangles)), speedKmh: summarize(samples.map(s => s.speedKmh)), boostingFraction: samples.filter(s => s.boosting).length / Math.max(1, samples.length), gpuRenderMs: summarize(gpuMs), cpuRenderMs: summarize(cpuRenderMs), cpuDrivingMs: summarize(cpuDrivingMs), routeWrapTimesSeconds: wraps, contextLost: gl.isContextLost(), samples };
    } finally {
      g.composer.render = originalRender; g.updateDriving = originalDriving;
      g.active = false; g.pressed.clear();
      for (const query of pending) gl.deleteQuery(query);
    }
  });
  if (label === 'fixed') {
    console.log('Capturing the naturally selected quality at the dense center');
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.pressed.clear(); g.reset(); g.active = true;
      g.carPosition.set(-22, .015, -22); g.car.position.copy(g.carPosition);
      g.yaw = 0; g.car.rotation.y = 0; g.updateCamera(0, true);
    });
    await page.waitForTimeout(1300);
    await page.screenshot({ path: 'artifacts/night-city-final-adaptive.png' });
    report.adaptiveScreenshotQuality = await page.evaluate(() => document.querySelector('canvas').__drive.qualityLevel);
  }
  report.errors = errors;
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/night-city-sustained-driving${label ? '-' + label : ''}.json`, JSON.stringify(report, null, 2));
  const { samples, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(errors.length, 0, 'No browser or shader errors during sustained driving');
  assert.equal(report.contextLost, false, 'WebGL remains healthy during sustained driving');
  assert.ok(report.durationSeconds >= 10 && report.frameMs.n > 100, 'The running game is sampled for 10 seconds');
  if (label === 'fixed') assert.ok(report.frameMs.p95 < 25, 'At least 95% of sustained driving frames stay within the smooth frame budget');
} finally { await browser.close(); }
