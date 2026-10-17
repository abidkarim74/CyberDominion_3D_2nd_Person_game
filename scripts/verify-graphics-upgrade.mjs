import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// The same fixed camera and straight city route make preset upgrades comparable.
// FRAME_SAMPLE_MS may be increased for a longer machine-specific performance run.
const label = process.argv[2] || 'after';
assert.match(label, /^[a-z0-9-]+$/);
const presets = (process.env.GRAPHICS_PRESETS || 'low,medium,high,ultra').split(',');
assert.ok(presets.length && presets.every(preset => ['low', 'medium', 'high', 'ultra'].includes(preset)));
const captureDriver = process.env.CAPTURE_DRIVER !== '0';
const directory = 'artifacts/graphics-upgrade';
await mkdir(directory, { recursive: true });
const report = { label, viewport: [1280, 800], sampleMs: Number(process.env.FRAME_SAMPLE_MS || 6000), presets: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('neon-nocturne.graphics.v1', JSON.stringify({ preset: 'low', automatic: false })));
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  for (const preset of presets) {
    console.log(`${label}: ${preset} fixed-camera capture`);
    const configuration = await page.evaluate(async preset => {
      const g = document.querySelector('canvas').__drive;
      const { GRAPHICS_PRESETS } = await import('/lib/graphics-quality.ts');
      cancelAnimationFrame(g.animationFrame); g.active = false; g.reset();
      g.setGraphicsQuality(preset); g.qualityWarmup = Infinity;
      g.elapsed = 40; g.setCameraView('chase'); g.updateCamera(0, true);
      g.updateCityVisibility(g.carPosition, 0, GRAPHICS_PRESETS[preset].detailScale);
      g.scene.updateMatrixWorld(true);
      g.renderer.shadowMap.needsUpdate = true; g.composer.render();
      const colliders = g.colliders;
      const colliderFingerprint = colliders.reduce((hash, c) => (Math.imul(hash, 31) + Math.round(c.x * 100) + Math.round(c.z * 100) + Math.round(c.hx * 1000) + Math.round(c.hz * 1000)) | 0, 17);
      return { ...g.getGraphicsStatus(), profile: GRAPHICS_PRESETS[preset],
        scene: [g.composer.readBuffer.width, g.composer.readBuffer.height],
        shadow: g.keyLight.shadow.mapSize.x, roadReflection: g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false,
        bloom: [g.bloomPass.bloomTexture.image.width, g.bloomPass.bloomTexture.image.height],
        edgeQuality: g.presentationPass.uniforms.resolveQuality.value,
        snow: g.snowfall.flakes.geometry.drawRange.count,
        localLights: g.scene.children.filter(o => o.isPointLight && o.visible && o.intensity > 0).length,
        colliders: colliders.length, colliderFingerprint,
        mainRoadClear: !g.collisionWorld.sweep({ x: -22, z: 176 }, { x: -22, z: -176 }, 0),
        contextLost: g.renderer.getContext().isContextLost() };
    }, preset);
    await page.screenshot({ path: `${directory}/${label}-${preset}-chase.png` });
    // Include a driver view to exercise all three live mirrors and state restoration.
    if (captureDriver) await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.setCameraView('driver'); g.updateCamera(0, true);
      for (let i = 0; i < 3; i++) { g.elapsed += .3; g.drivingMirrors.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
      g.composer.render();
    });
    if (captureDriver) await page.screenshot({ path: `${directory}/${label}-${preset}-driver.png` });
    console.log(`${label}: ${preset} sustained driving sample`);
    const performance = await page.evaluate(async ({ sampleMs }) => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.setCameraView('chase');
      g.carPosition.set(-22, .015, 176); g.previousPosition.copy(g.carPosition);
      g.car.position.copy(g.carPosition); g.velocity.set(0, 0, -48); g.yaw = 0; g.car.rotation.y = 0;
      g.pressed.add('w'); g.pressed.add('f'); g.activateNitro(); g.updateCamera(0, true);
      const gl = g.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const summarize = values => {
        const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
        return { mean: n ? sorted.reduce((a, b) => a + b, 0) / n : 0,
          p50: sorted[Math.floor(n * .5)] || 0, p95: sorted[Math.floor(n * .95)] || 0, max: sorted.at(-1) || 0, n };
      };
      const frames = [], cpu = [], gpu = [], draws = [], triangles = [], speeds = [], queries = [];
      const original = g.frame;
      let collecting = false, last;
      g.frame = function(...args) {
        const query = collecting && timer ? gl.createQuery() : null;
        if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { if (collecting) cpu.push(performance.now() - start); if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push(query); } }
      };
      const started = performance.now(); g.active = true; g.previousTime = 0;
      g.animationFrame = requestAnimationFrame(g.frameHandler);
      try {
        await new Promise((resolve, reject) => {
          const tick = time => {
            if (g.destroyed || g !== document.querySelector('canvas').__drive) { reject(new Error('Game replaced during comparison')); return; }
            if (g.carPosition.z < -176) {
              g.carPosition.z += 352; g.previousPosition.z += 352; g.camera.position.z += 352;
              g.car.position.copy(g.carPosition); g.boostCharge = 100; g.activateNitro();
            }
            const age = performance.now() - started;
            if (age > 2500) {
              collecting = true;
              if (last !== undefined) frames.push(time - last);
              last = time; draws.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles); speeds.push(g.lastTelemetry.speed);
            }
            while (timer && queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
              const query = queries.shift();
              if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
              gl.deleteQuery(query);
            }
            if (age < 2500 + sampleMs) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        return { gpuName: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), frameMs: summarize(frames),
          cpuFrameMs: summarize(cpu), gpuFrameMs: summarize(gpu), draws: summarize(draws), triangles: summarize(triangles),
          speed: summarize(speeds), contextLost: gl.isContextLost(), qualityPressure: g.qualityLevel };
      } finally {
        cancelAnimationFrame(g.animationFrame); g.frame = original; g.pressed.clear(); g.active = false; queries.forEach(query => gl.deleteQuery(query));
      }
    }, { sampleMs: report.sampleMs });
    const result = { ...configuration, performance };
    report.presets.push(result);
    await writeFile(`${directory}/${label}.json`, JSON.stringify(report, null, 2));
    assert.equal(result.automatic, false); assert.equal(result.contextLost, false); assert.equal(performance.contextLost, false);
    assert.equal(performance.qualityPressure, 0, 'Manual presets remain fixed while benchmarking');
    assert.ok(performance.frameMs.n > 10 && performance.speed.mean > 100, 'Real moving frames were sampled');
    assert.equal(result.shadow, result.profile.shadowSize);
    assert.equal(result.roadReflection, false, 'Matte roads have no wet-road mirror at every graphics preset');
    assert.equal(result.snow, Math.floor(3200 * result.profile.snowDensity));
    assert.equal(result.mainRoadClear, true, 'Main driving lane stays clear');
    if (report.presets.length > 1) {
      const previous = report.presets.at(-2);
      assert.ok(result.scene[0] * result.scene[1] > previous.scene[0] * previous.scene[1], 'Scene detail increases each tier');
      assert.ok(result.shadow >= previous.shadow, 'Shadow detail never decreases');
      assert.equal(result.colliders, previous.colliders); assert.equal(result.colliderFingerprint, previous.colliderFingerprint);
    }
    console.log(`${preset}: ${performance.frameMs.mean.toFixed(1)}ms mean / ${performance.frameMs.p95.toFixed(1)}ms p95, CPU ${performance.cpuFrameMs.mean.toFixed(1)}ms, GPU ${performance.gpuFrameMs.mean.toFixed(1)}ms`);
  }
  assert.deepEqual(report.errors, [], 'No shader or browser errors');
} finally {
  await writeFile(`${directory}/${label}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
