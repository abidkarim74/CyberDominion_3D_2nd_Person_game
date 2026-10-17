import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts/car-shadow', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [], startupMessages = [];
let activePage;
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  activePage = page;
  await page.addInitScript(() => localStorage.setItem('neon-nocturne.graphics.v1', JSON.stringify({ preset: 'low', automatic: false })));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') startupMessages.push(message.text()); });
  page.on('requestfailed', request => startupMessages.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  // Shadow scheduling only needs the car rig; character asset loading is independent.
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 90000 });
  const profileOnly = process.argv.includes('--profile-only');
  const result = profileOnly ? { groups: {}, contextLost: false } : await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.active = false; g.qualityWarmup = Infinity; g.reset();
    const render = g.composer.render, mirrors = g.drivingMirrors.update;
    const samples = [];
    g.drivingMirrors.update = () => {};
    g.composer.render = () => {
      samples.push({ capture: g.renderer.shadowMap.needsUpdate,
        position: g.car.position.toArray(), light: g.keyLight.position.toArray() });
      // Consume the invalidation exactly as Three's real shadow pass does.
      g.renderer.shadowMap.needsUpdate = false;
    };
    let time = 1000; g.previousTime = time;
    const step = () => { time += 1000 / 60; g.frame(time); cancelAnimationFrame(g.animationFrame); };
    try {
      const groups = {};
      for (const quality of ['low', 'medium', 'high', 'ultra']) {
        g.graphicsQuality = quality; g.qualityLevel = quality === 'low' ? 4 : 0;
        g.shadowPosition.set(Infinity, Infinity, Infinity);
        samples.length = 0;
        for (let i = 0; i < 34; i++) step();
        groups[quality] = { idle: samples.map(sample => sample.capture) };
        samples.length = 0;
        // Move the interpolated render pose by less than the old 25cm gate.
        for (let i = 0; i < 12; i++) {
          g.car.position.z -= .04; g.carPosition.z = g.car.position.z; step();
        }
        groups[quality].moving = samples.map(sample => sample.capture);
        samples.length = 0;
        for (let i = 0; i < 8; i++) { g.car.rotation.y += .002; g.yaw = g.car.rotation.y; step(); }
        groups[quality].turning = samples.map(sample => sample.capture);
        samples.length = 0;
        for (let i = 0; i < 8; i++) { g.carRig.body.position.y += .001; g.carRig.body.rotation.z += .001; step(); }
        groups[quality].bodyMotion = samples.map(sample => sample.capture);
        samples.length = 0;
        // A small uncaptured focus change must not move the cached light.
        const original = g.keyLight.position.toArray();
        g.carPosition.x += .01; step();
        groups[quality].cache = { original, sample: samples[0] };
        g.carPosition.x = g.car.position.x;
      }
      return { groups, contextLost: g.renderer.getContext().isContextLost() };
    } finally {
      g.composer.render = render; g.drivingMirrors.update = mirrors;
      cancelAnimationFrame(g.animationFrame);
    }
  });
  console.log(profileOnly ? 'Profiling shadow render cost' : 'Shadow schedule sampled at all tiers');
  if (profileOnly || process.argv.includes('--profile')) result.profile = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.active = false; g.qualityLevel = 0; g.setGraphicsQuality('medium');
    g.renderer.setPixelRatio(.65); g.composer.setPixelRatio(.65);
    g.setCameraView('chase'); g.reset(); g.updateCamera(0, true);
    const gl = g.renderer.getContext(), profiles = {};
    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)], maximum: sorted[sorted.length - 1] };
    };
    for (const interval of [4, 1]) {
      const times = [], calls = [], triangles = [];
      for (let frame = 0; frame < 16; frame++) {
        g.carPosition.z -= .15; g.car.position.copy(g.carPosition);
        g.updateCamera(1 / 60);
        if (frame % interval === 0) {
          g.keyLight.position.set(g.carPosition.x + 22, g.carPosition.y + 38, g.carPosition.z + 16);
          g.keyLight.target.position.copy(g.carPosition);
        }
        g.renderer.shadowMap.needsUpdate = frame % interval === 0;
        g.renderer.info.reset();
        const start = performance.now(); g.composer.render(); gl.finish();
        if (frame >= 4) {
          times.push(performance.now() - start); calls.push(g.renderer.info.render.calls);
          triangles.push(g.renderer.info.render.triangles);
        }
      }
      profiles[interval === 4 ? 'previousEveryFourFrames' : 'currentEveryMovingFrame'] = {
        renderMs: summary(times), calls: summary(calls), triangles: summary(triangles),
      };
    }
    return profiles;
  });
  await writeFile('artifacts/car-shadow/verification.json', JSON.stringify({ ...result, errors }, null, 2));
  for (const [quality, group] of Object.entries(result.groups)) {
    assert.equal(group.idle.filter(Boolean).length, 1, `${quality}: stationary car reuses its capture`);
    assert.ok(group.moving.every(Boolean), `${quality}: moving silhouette refreshes every changed render pose`);
    assert.ok(group.turning.every(Boolean), `${quality}: turning silhouette refreshes immediately`);
    assert.ok(group.bodyMotion.every(Boolean), `${quality}: stationary body animation refreshes immediately`);
    assert.equal(group.cache.sample.capture, false, `${quality}: unchanged car retains cached capture`);
    assert.deepEqual(group.cache.sample.light, group.cache.original, `${quality}: cached light stays anchored`);
  }
  assert.equal(result.contextLost, false); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ tiers: Object.keys(result.groups),
    movingCapturesPerTier: Object.values(result.groups).map(group => group.moving.filter(Boolean).length),
    idleCapturesPerTier: Object.values(result.groups).map(group => group.idle.filter(Boolean).length),
    profile: result.profile, errors }, null, 2));
} catch (error) {
  await writeFile('artifacts/car-shadow/failure.json', JSON.stringify({
    error: error.message, url: activePage?.url(), errors, startupMessages,
  }, null, 2));
  throw error;
} finally { await browser.close(); }
