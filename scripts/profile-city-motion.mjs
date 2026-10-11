import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] || 'after';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; if ('qualityWarmup' in g) g.qualityWarmup = -1e6; });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(1800);
  const result = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const gl = g.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    const samples = {};
    const wrap = (object, method, name = method) => {
      const original = object[method];
      if (typeof original !== 'function') return;
      samples[name] = [];
      object[method] = function(...args) {
        const start = performance.now();
        const value = original.apply(this, args);
        samples[name].push(performance.now() - start);
        return value;
      };
    };
    for (const method of ['updateDriving', 'updateSnow', 'updateCityVisibility', 'updateCamera']) wrap(g, method);
    wrap(g.composer, 'render');
    wrap(g.scene, 'updateMatrixWorld', 'worldMatrices');
    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p50: sorted[Math.floor(sorted.length * .5)] || 0, p95: sorted[Math.floor(sorted.length * .95)] || 0, mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length) };
    };
    async function measure(name, moving) {
      g.reset();
      g.active = moving;
      g.carPosition.set(-22, .015, 160);
      g.car.position.copy(g.carPosition);
      if (moving) { g.velocity.set(0, 0, -28); g.pressed.add('w'); }
      await new Promise(resolve => setTimeout(resolve, 1200));
      Object.values(samples).forEach(s => s.length = 0);
      const frames = [], calls = [], triangles = [];
      let last = performance.now();
      await new Promise(resolve => {
        function tick(t) {
          frames.push(t - last); last = t;
          calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
          if (frames.length < 90) requestAnimationFrame(tick); else resolve();
        }
        requestAnimationFrame(tick);
      });
      return { name, framesMs: summary(frames.slice(1)), calls: summary(calls), triangles: summary(triangles), cpu: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summary(v)])), pixelRatio: g.renderer.getPixelRatio(), shadows: g.renderer.shadowMap.enabled, reflection: g.reflections.mirror.visible, quality: g.qualityLevel, speedKmh: g.velocity.length() * 3.6 };
    }
    const parked = await measure('parked', false);
    const driving = await measure('driving', true);
    g.active = false;
    return { gpu: extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL), parked, driving };
  });
  await page.screenshot({ path: `artifacts/city-motion-${label}.png` });
  result.errors = errors;
  await writeFile(`artifacts/city-motion-${label}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
