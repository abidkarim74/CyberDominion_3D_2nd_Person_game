import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text() + ' ' + m.location().url); });
await page.goto('http://localhost:3001/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, { timeout: 60000 });
await page.waitForTimeout(2500);
const state = () => page.evaluate(() => {
  const g = document.querySelector('canvas').__drive;
  return { position: g.carPosition.toArray(), velocity: g.velocity.toArray(), yaw: g.yaw,
    camera: g.camera.position.toArray(), fov: g.camera.fov, active: g.active,
    ...g.lastTelemetry, particles: g.particles.length,
    calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
    geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures,
    pixelRatio: g.renderer.getPixelRatio(), contextLost: g.renderer.getContext().isContextLost() };
});
const results = { before: await state() };
await page.screenshot({ path: 'artifacts/title.png' });
await page.getByRole('button', { name: 'PLAY' }).click();
await page.waitForTimeout(1000);
assert.equal((await state()).active, true, 'PLAY enables driving');
await page.waitForFunction(() => document.querySelector('canvas').__audio()?.state === 'running', null, { timeout: 5000 });
const soundState = () => page.evaluate(() => document.querySelector('canvas').__audio());
results.idleAudio = await soundState();
assert.ok(results.idleAudio.levels.snow > 0 && results.idleAudio.levels.city > 0 && results.idleAudio.levels.engine > 0, 'Winter ambience, city ambience and idle engine audio start on PLAY');
await page.screenshot({ path: 'artifacts/city.png' });
await page.keyboard.down('w'); await page.waitForTimeout(1200); await page.keyboard.up('w');
results.accelerating = await state();
assert.ok(results.accelerating.speed > 25 && results.accelerating.position[2] < -3, 'Car accelerates forward');
results.engineAudio = await soundState();
assert.ok(results.engineAudio.engineFrequency > results.idleAudio.engineFrequency + 10 && results.engineAudio.levels.wind > results.idleAudio.levels.wind, 'Engine pitch and wind rise with speed');
await page.keyboard.down('a'); await page.waitForTimeout(300); await page.keyboard.up('a');
results.steering = await state();
assert.ok(results.steering.yaw > .1, 'Left steering changes heading');
await page.keyboard.down('Space'); await page.keyboard.down('d'); await page.waitForTimeout(220);
results.drift = await state();
assert.ok(results.drift.drifting && results.drift.particles > 0, 'Drift produces slip and particles');
results.driftAudio = await soundState();
assert.ok(results.driftAudio.levels.tire > 0, 'Drift adds tire sound');
await page.screenshot({ path: 'artifacts/drift.png' });
await page.keyboard.up('Space'); await page.keyboard.up('d');
await page.keyboard.press('r'); await page.waitForTimeout(100);
results.reset = await state();
assert.ok(results.reset.speed < 1 && Math.abs(results.reset.position[0]) < .01 && Math.abs(results.reset.position[2]) < .01 && results.reset.yaw === 0, 'Reset restores spawn and heading');
await page.keyboard.down('w'); await page.keyboard.down('Shift'); await page.waitForTimeout(1600);
results.boost = await state();
assert.ok(results.boost.boosting && results.boost.boost < .9 && results.boost.speed > 50 && results.boost.particles > 0, 'Boost accelerates, drains charge and emits particles');
results.boostAudio = await soundState();
assert.ok(results.boostAudio.levels.boost > 0, 'Boost adds its own audio layer');
assert.ok(results.boost.camera[2] > results.boost.position[2] && results.boost.camera[2] - results.boost.position[2] < 30, 'Camera follows car');
assert.ok(results.boost.fov > results.before.fov, 'Speed increases camera FOV');
await page.screenshot({ path: 'artifacts/boost.png' });
await page.keyboard.up('Shift'); await page.keyboard.up('w');
await page.keyboard.press('r'); await page.waitForTimeout(100);
await page.keyboard.down('s'); await page.waitForTimeout(700); await page.keyboard.up('s');
results.reverse = await state(); assert.ok(results.reverse.position[2] > 1, 'Reverse works');
await page.keyboard.press('r');
results.performance = await page.evaluate(async () => {
  const times = []; let last = performance.now();
  await new Promise(resolve => { function sample(now) { times.push(now - last); last = now; if (times.length < 120) requestAnimationFrame(sample); else resolve(); } requestAnimationFrame(sample); });
  times.sort((a,b) => a-b);
  return { medianFrameMs: times[60], p95FrameMs: times[114], approximateFps: 1000 / times[60] };
});
// Exercise arrow controls, braking, both city limits and the tunnel using actual keyboard input.
await page.keyboard.down('ArrowUp'); await page.waitForTimeout(700); await page.keyboard.up('ArrowUp');
const beforeBraking = await state();
await page.keyboard.down('ArrowDown'); await page.waitForTimeout(260); await page.keyboard.up('ArrowDown');
results.braking = await state();
assert.ok(results.braking.speed < beforeBraking.speed, 'Brake reduces forward speed');
await page.keyboard.down('ArrowRight'); await page.waitForTimeout(250); await page.keyboard.up('ArrowRight');
assert.ok((await state()).yaw < -.05, 'Right arrow steering works');
await page.keyboard.press('r');
await page.keyboard.down('s');
await page.waitForFunction(() => document.querySelector('canvas').__drive.carPosition.z > 60, { timeout: 12000 });
await page.keyboard.up('s');
await page.screenshot({ path: 'artifacts/tunnel.png' });
results.tunnel = await state();
await page.keyboard.press('r');
await page.keyboard.down('w'); await page.keyboard.down('Shift');
await page.waitForFunction(() => document.querySelector('canvas').__drive.carPosition.z < -190, { timeout: 15000 });
await page.waitForTimeout(500);
await page.keyboard.up('w'); await page.keyboard.up('Shift');
results.boundary = await state();
assert.ok(Math.abs(results.boundary.position[2]) <= 193, 'World boundary contains the car');
await page.keyboard.press('r');
// Drive into the corner building and confirm the existing AABB collision is respected.
await page.keyboard.down('w'); await page.waitForTimeout(350); await page.keyboard.down('a'); await page.waitForTimeout(750); await page.keyboard.up('a');
await page.waitForTimeout(1500); await page.keyboard.up('w');
results.collision = await state();
const insideBuilding = await page.evaluate(() => {const g=document.querySelector('canvas').__drive;return g.colliders.some(b=>Math.abs(g.carPosition.x-b.x)<b.hx+.88 && Math.abs(g.carPosition.z-b.z)<b.hz+2.06);});
assert.equal(insideBuilding, false, 'Car remains outside building colliders');
await page.keyboard.press('r');
await page.setViewportSize({width: 1000, height: 700});await page.waitForTimeout(300);
assert.ok(await page.locator('.drive-hud').isVisible(), 'HUD survives resize');
await page.screenshot({path:'artifacts/resized.png'});
results.final = await state(); results.errors = errors;
await writeFile('artifacts/verification.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
assert.equal(errors.length, 0, 'No browser runtime or console errors');
assert.equal(results.final.contextLost, false, 'WebGL context remains healthy');
await browser.close();
