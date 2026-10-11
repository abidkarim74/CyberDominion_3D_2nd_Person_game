import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const watchErrors = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watchErrors(page);
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(10000);
  const measure = label => page.evaluate(async label => {
    const game = document.querySelector('canvas').__drive;
    const frames = [], calls = [], triangles = [], cpu = [];
    const original = game.composer.render.bind(game.composer);
    game.composer.render = (...args) => {
      const start = performance.now();
      original(...args);
      cpu.push(performance.now() - start);
    };
    let last = performance.now();
    await new Promise(resolve => {
      function sample(now) {
        frames.push(now - last); last = now;
        calls.push(game.renderer.info.render.calls);
        triangles.push(game.renderer.info.render.triangles);
        if (frames.length < 120) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    game.composer.render = original;
    const summarize = values => {
      values.sort((a, b) => a - b);
      return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) };
    };
    return {
      label, source: game.carRig.body.userData.bodyModel, view: game.cameraView,
      framesMs: summarize(frames), renderCpuMs: summarize(cpu), drawCalls: summarize(calls), sceneTriangles: summarize(triangles),
      pixelRatio: game.renderer.getPixelRatio(), qualityLevel: game.qualityLevel, averageFrame: game.averageFrame,
      contextLost: game.renderer.getContext().isContextLost(),
    };
  }, label);
  const results = [await measure('chase-10s-warmup')];
  await page.screenshot({ path: 'artifacts/blender/bugatti-desktop-gameplay.png' });
  await page.getByRole('button', { name: 'Inspect car from all sides', exact: true }).click();
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.orbitAzimuth = -2.55; game.orbitElevation = .24; game.orbitDistance = 7.2;
  });
  await page.waitForTimeout(4000);
  results.push(await measure('orbit-front-quarter-4s-warmup'));
  await page.screenshot({ path: 'artifacts/blender/bugatti-desktop-inspect.png' });
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  watchErrors(mobile);
  await mobile.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await mobile.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await mobile.getByRole('button', { name: 'PLAY', exact: true }).click();
  await mobile.waitForTimeout(6000);
  await mobile.screenshot({ path: 'artifacts/blender/bugatti-mobile-gameplay.png' });
  await mobile.getByRole('button', { name: 'Inspect car from all sides', exact: true }).click();
  await mobile.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.orbitAzimuth = -2.55; game.orbitElevation = .2; game.orbitDistance = 5.4;
  });
  await mobile.waitForTimeout(1500);
  await mobile.screenshot({ path: 'artifacts/blender/bugatti-mobile-inspect.png' });
  const mobileState = await mobile.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    return {
      view: game.cameraView, width: window.innerWidth, height: window.innerHeight,
      pixelRatio: game.renderer.getPixelRatio(), qualityLevel: game.qualityLevel,
      contextLost: game.renderer.getContext().isContextLost(),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  assert.ok(results.every(result => !result.contextLost));
  assert.equal(mobileState.contextLost, false);
  assert.equal(mobileState.horizontalOverflow, false);
  assert.deepEqual(errors, []);
  const report = { viewport: { width: 1440, height: 900 }, warmupSeconds: 10, samples: 120, results, mobile: mobileState, errors };
  await writeFile('artifacts/blender/bugatti-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
