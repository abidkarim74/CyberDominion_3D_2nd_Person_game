import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(12000);
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, gl = g.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    window.__orbitProfile = { gpu: [], cpu: [], pending: [], ext, gl };
    const original = g.composer.render.bind(g.composer);
    g.composer.render = (...args) => {
      const p = window.__orbitProfile;
      let query = null;
      if (ext && p.pending.length < 6) { query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query); }
      const start = performance.now();
      original(...args);
      p.cpu.push(performance.now() - start);
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); p.pending.push(query); }
    };
  });
  const measure = async label => page.evaluate(async label => {
    const g = document.querySelector('canvas').__drive, p = window.__orbitProfile;
    const frames = [], calls = [], triangles = [];
    p.cpu.length = 0; p.gpu.length = 0;
    let last = performance.now();
    const initialQuality = g.qualityLevel;
    await new Promise(resolve => { function tick(now) {
      frames.push(now - last); last = now;
      calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
      if (p.ext) {
        while (p.pending.length && p.gl.getQueryParameter(p.pending[0], p.gl.QUERY_RESULT_AVAILABLE)) {
          const query = p.pending.shift();
          if (!p.gl.getParameter(p.ext.GPU_DISJOINT_EXT)) p.gpu.push(p.gl.getQueryParameter(query, p.gl.QUERY_RESULT) / 1e6);
          p.gl.deleteQuery(query);
        }
      }
      if (frames.length < 100) requestAnimationFrame(tick); else resolve();
    } requestAnimationFrame(tick); });
    const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null }; };
    return { label, view: g.cameraView, framesMs: summarize(frames), renderCpuMs: summarize(p.cpu), gpuMs: summarize(p.gpu), gpuTimerSupported: !!p.ext, calls: summarize(calls), triangles: summarize(triangles), initialQuality, qualityLevel: g.qualityLevel, averageFrame: g.averageFrame, pixelRatio: g.renderer.getPixelRatio(), camera: g.camera.position.toArray(), reflectionVisible: g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, bloomEnabled: g.composer.passes[1].enabled, contextLost: g.renderer.getContext().isContextLost() };
  }, label);
  const results = [await measure('chase-active')];
  await page.getByRole('button', { name: 'Inspect car from all sides', exact: true }).click();
  await page.waitForTimeout(12000);
  results.push(await measure('orbit-rear-quarter-settled'));
  await page.screenshot({ path: 'artifacts/cyber-car-orbit-rear-quarter.png' });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.orbitAzimuth = -Math.PI / 2; g.orbitElevation = .22; g.orbitDistance = 5.8; });
  await page.waitForTimeout(4000);
  results.push(await measure('orbit-side-zoom'));
  await page.screenshot({ path: 'artifacts/cyber-car-orbit-side-zoom.png' });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.orbitAzimuth = -1.52; g.orbitElevation = .44; g.orbitDistance = 6.48; });
  await page.waitForTimeout(12000);
  results.push(await measure('orbit-drag-pinch-angle-settled'));
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.composer.passes[1].enabled = false; });
  await page.waitForTimeout(700);
  results.push(await measure('orbit-bloom-off'));
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.composer.passes[1].enabled = true; });
  await page.waitForTimeout(700);
  results.push(await measure('orbit-restored'));
  await mkdir('artifacts', { recursive: true });
  const report = { results, errors };
  await writeFile('artifacts/cyber-car-orbit-profile.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
