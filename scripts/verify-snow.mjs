import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}),
  headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.snowfall);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.qualityTimer = -1000;
    game.renderer.setPixelRatio(Math.sqrt(1_100_000 / (1440 * 900)));
    game.resize();
  });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(async () => {
    const game = document.querySelector('canvas').__drive;
    const banks = game.snowbanks, flakes = game.snowfall.flakes;
    const positions = banks.geometry.attributes.position;
    let laneViolations = 0, shelteredTriangles = 0;
    const distanceToRoad = value => Math.abs(value - (Math.round((value - 22) / 44) * 44 + 22));
    const index = { array: game.roadSnow.allIndices, count: game.roadSnow.allIndices.length, getX(i) { return this.array[i]; } };
    const vertices = new Set(index.array);
    for (const i of vertices) {
      if (Math.min(distanceToRoad(positions.getX(i)), distanceToRoad(positions.getZ(i))) < 6.3) laneViolations++;
    }
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const x = (positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3;
      const z = (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3;
      if (game.coveredRoads.some(r => Math.abs(x - r.x) < r.hx && Math.abs(z - r.z) < r.hz)) shelteredTriangles++;
    }
    const pool = flakes.geometry.attributes.position.array;
    const before = new Float32Array(pool);
    const geometry = flakes.geometry;
    const start = performance.now();
    for (let i = 0; i < 10000; i++) game.snowfall.update(i / 60, game.carPosition, game.yaw, 900);
    const snowCpuMs = (performance.now() - start) / 10000;
    const buffersUnchanged = before.every((v, i) => v === pool[i]) && flakes.geometry === geometry;
    game.updateSnow();
    const time = flakes.material.uniforms.time.value;
    await new Promise(resolve => setTimeout(resolve, 250));
    const animated = flakes.material.uniforms.time.value > time;
    async function profile(visible) {
      banks.visible = flakes.visible = game.roadSnow.border.visible = visible;
      await new Promise(resolve => setTimeout(resolve, 500));
      const frames = [], draws = [];
      let previous = performance.now();
      await new Promise(resolve => {
        function tick(now) {
          frames.push(now - previous); draws.push(game.renderer.info.render.calls); previous = now;
          if (frames.length < 150) requestAnimationFrame(tick); else resolve();
        }
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b); draws.sort((a, b) => a - b);
      return { medianMs: frames[75], p95Ms: frames[142], fps: 1000 / frames[75], calls: draws[75] };
    }
    const withoutSnow = await profile(false), withSnow = await profile(true);
    const gl = game.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { laneViolations, shelteredTriangles, clearLaneWidth: 12.6, snowCpuMs, buffersUnchanged, animated,
      flakeCount: pool.length / 3, bankTriangles: index.count / 3, visibleBankTriangles: banks.geometry.drawRange.count / 3, withoutSnow, withSnow,
      pixelRatio: game.renderer.getPixelRatio(), gpu: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      contextLost: gl.isContextLost(), rainAbsent: !game.scene.getObjectByName('Rain / tapered falling droplets') && !game.scene.getObjectByName('Road rain / expanding water ripples'),
      audio: game.audioDiagnostics().levels };
  });
  assert.equal(result.laneViolations, 0, 'The middle 12.6 metres of every road remain clear');
  assert.equal(result.shelteredTriangles, 0, 'Snowbanks do not occupy covered-road interiors');
  assert.ok(result.buffersUnchanged, 'Snow animations reuse immutable geometry with no per-frame particle uploads');
  assert.ok(result.animated, 'Snowfall animation advances');
  assert.equal(result.flakeCount, 3200);
  assert.equal(result.rainAbsent, true);
  assert.equal(result.contextLost, false);
  assert.ok(result.snowCpuMs < .2, 'Uniform-only snow update costs less than .2 ms');
  assert.equal(result.withSnow.calls - result.withoutSnow.calls, 3, 'Snowfall, roadside banks, and outer ground add three draws');
  assert.ok(result.withSnow.medianMs <= result.withoutSnow.medianMs + 5, 'Snow keeps the median frame-time budget');
  assert.ok(result.withSnow.p95Ms <= result.withoutSnow.p95Ms + 18, 'Snow keeps the p95 frame-time budget');
  assert.ok(result.audio.snow > 0 && !result.audio.rain, 'Winter ambience replaces rain audio');

  const beforeDriving = await page.evaluate(() => document.querySelector('canvas').__drive.carPosition.z);
  await page.keyboard.down('w'); await page.waitForTimeout(1300); await page.keyboard.up('w');
  result.driving = await page.evaluate(before => {
    const game = document.querySelector('canvas').__drive;
    return { moved: Math.abs(game.carPosition.z - before), speed: game.velocity.length() };
  }, beforeDriving);
  assert.ok(result.driving.moved > 3 && result.driving.speed > 3, 'The car still accelerates and drives through snowy streets');
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.velocity.set(0, 0, 0); game.carPosition.set(-22, .015, -43); game.car.position.copy(game.carPosition); game.updateCamera(1);
  });
  await page.screenshot({ path: 'artifacts/snow-chase.png' });
  await page.keyboard.press('c'); await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/snow-driver.png' });
  result.driverView = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
  assert.equal(result.driverView, 'driver');

  result.gpuPixels = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame);
    const { renderer } = game;
    const flakes = game.snowfall.flakes, uniforms = flakes.material.uniforms;
    const oldPosition = uniforms.carPosition.value.clone(), oldTime = uniforms.time.value, oldResolution = uniforms.resolution.value;
    const attribute = flakes.geometry.attributes.position;
    const oldParticle = [attribute.getX(0), attribute.getY(0), attribute.getZ(0)];
    const variation = flakes.geometry.attributes.variation, oldVariation = variation.getX(0);
    variation.setX(0, .98); variation.needsUpdate = true;
    const oldDrawRange = { ...flakes.geometry.drawRange }, oldTarget = renderer.getRenderTarget();
    const isolated = new game.scene.constructor();
    const camera = new game.camera.constructor(66, 1, .1, 100);
    const target = new (game.reflections.mirror.getRenderTarget().constructor)(256, 256);
    const pixelBuffer = new Uint8Array(256 * 256 * 4);
    const oldShelters = uniforms.shelters.value;
    const roof = game.coveredRoads[0];
    isolated.add(flakes); flakes.geometry.setDrawRange(0, 1);
    uniforms.time.value = 0; uniforms.resolution.value = 256;
    uniforms.carPosition.value.set(roof.x, 0, roof.z);
    renderer.setRenderTarget(target);
    function count(y) {
      attribute.setXYZ(0, roof.x, y, roof.z); attribute.needsUpdate = true;
      camera.position.set(roof.x, y, roof.z + 6); camera.lookAt(roof.x, y, roof.z);
      renderer.render(isolated, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixelBuffer);
      let visible = 0;
      for (let i = 0; i < pixelBuffer.length; i += 4) if (Math.max(pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]) > 10) visible++;
      return visible;
    }
    const underRoof = count(4);
    uniforms.shelters.value = oldShelters.map(r => r.clone().set(1e6, 1e6, 0, 0));
    const exposed = count(4);
    uniforms.shelters.value = oldShelters;
    const aboveRoof = count(roof.ceiling + 2);
    attribute.setXYZ(0, ...oldParticle); attribute.needsUpdate = true;
    variation.setX(0, oldVariation); variation.needsUpdate = true;
    flakes.geometry.setDrawRange(oldDrawRange.start, oldDrawRange.count);
    uniforms.time.value = oldTime; uniforms.resolution.value = oldResolution; uniforms.carPosition.value.copy(oldPosition);
    game.scene.add(flakes); renderer.setRenderTarget(oldTarget); target.dispose(); game.composer.render();
    return { underRoof, exposed, aboveRoof };
  });
  console.log('GPU shelter probe:', JSON.stringify(result.gpuPixels));
  assert.equal(result.gpuPixels.underRoof, 0, 'The actual GPU shader suppresses flakes underneath tunnel roofs');
  assert.ok(result.gpuPixels.exposed > 2 && result.gpuPixels.aboveRoof > 2, 'The actual GPU shader renders flakes outdoors and above roofs');
  result.errors = errors;
  await writeFile('artifacts/snow-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, 'No browser, shader, or runtime errors');
} finally { await browser.close(); }
