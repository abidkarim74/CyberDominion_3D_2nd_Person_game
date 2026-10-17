import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] || 'diagnostic';
const gameUrl = process.env.GAME_URL || 'http://localhost:3000/';
const errors = [];
await mkdir('artifacts', { recursive: true });
console.log('Launching one headless Chrome page');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.text().startsWith('PROFILE ')) console.log(message.text().slice(8));
  });
  console.log('Loading settled game source');
  await page.goto(gameUrl, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive && !document.querySelector('canvas').__drive.destroyed, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  console.log('Settling shaders and adaptive quality for 10 seconds');
  await page.waitForTimeout(10000);
  const result = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    if (!g || g.destroyed) throw new Error('Game was replaced or destroyed before profiling');
    const gl = g.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const ready = { quality: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), elapsed: g.elapsed, gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
    const cpuSamples = {};
    const wrapped = [];
    const gpuPending = [];
    const gpuTimes = [];
    let collecting = false;
    let hidden = [];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const summarize = values => {
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      return { p50: sorted[Math.floor(n * .5)] || 0, p95: sorted[Math.floor(n * .95)] || 0, max: sorted.at(-1) || 0, mean: n ? sorted.reduce((sum, v) => sum + v, 0) / n : 0, n };
    };
    const wrap = (object, method, name = method) => {
      const original = object?.[method];
      if (typeof original !== 'function') return;
      cpuSamples[name] = [];
      object[method] = function(...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { if (collecting) cpuSamples[name].push(performance.now() - start); }
      };
      wrapped.push(() => { object[method] = original; });
    };
    for (const method of ['updateDriving', 'updateSnow', 'updateParticles', 'updateBullets', 'updateSmoke', 'updateCityVisibility', 'updateStreetLights', 'updateCamera', 'onMapPosition', 'onTelemetry']) wrap(g, method);
    wrap(g.scene, 'updateMatrixWorld', 'worldMatrices');
    wrap(g.audio, 'update', 'audioUpdate');
    wrap(g.audio, 'fireGun', 'gunAudio');
    wrap(g.composer, 'render', 'composerRender');
    const cpuRender = g.composer.render;
    g.composer.render = function(...args) {
      for (const object of hidden) object.visible = false;
      const query = collecting && timer ? gl.createQuery() : null;
      if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      try { return cpuRender.apply(this, args); }
      finally {
        if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); gpuPending.push(query); }
      }
    };
    const originalQualityUpdate = g.updateRenderQuality;
    g.updateRenderQuality = () => {};
    const originalBloom = g.bloomPass.enabled;
    const setQuality = quality => {
      g.qualityLevel = quality;
      g.renderer.shadowMap.enabled = quality < 3;
      g.renderer.shadowMap.needsUpdate = quality < 3;
      g.resize();
    };
    const objects = [];
    g.scene.traverse(object => objects.push(object));
    const hardware = objects.filter(o => o.isInstancedMesh && o.userData.cityInstanceCells);
    const ocean = objects.filter(o => o.name === 'Island / animated ocean');
    const shore = objects.filter(o => o.name === 'Island / breakwater boulders' || o.name === 'Island / raised ground and stone seawall');
    const car = [];
    g.car.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) car.push(o); });
    const roadObjects = objects.filter(o => o.isMesh && !Array.isArray(o.material) && o.material.customProgramCacheKey().includes('night-city-matte-asphalt'));
    const defaultRoadMaterials = new Map();
    const defaultRoad = original => {
      let material = defaultRoadMaterials.get(original);
      if (material) return material;
      material = original.clone();
      // Keep the existing batching optimization while removing only the custom asphalt shading.
      const staticBatch = original.customProgramCacheKey().includes('static-city-batch');
      material.onBeforeCompile = shader => {
        if (staticBatch) shader.vertexShader = shader.vertexShader.replace('#include <batching_vertex>', '#ifdef USE_BATCHING\nmat4 batchingMatrix = mat4(1.0);\n#endif');
      };
      material.customProgramCacheKey = () => `profile-default-matte-road|${staticBatch}`;
      material.needsUpdate = true;
      defaultRoadMaterials.set(original, material);
      return material;
    };
    const clearGpuQueries = () => {
      for (const query of gpuPending) gl.deleteQuery(query);
      gpuPending.length = 0; gpuTimes.length = 0;
    };
    const pollGpu = () => {
      while (gpuPending.length && gl.getQueryParameter(gpuPending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const query = gpuPending.shift();
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuTimes.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(query);
      }
    };
    const visibleHierarchy = object => {
      for (let current = object; current; current = current.parent) if (!current.visible) return false;
      return true;
    };
    const inventory = objects.filter(o => o.isMesh).map(o => ({
      name: o.name || o.material?.name || '(unnamed)', type: o.type,
      approximateTriangles: ((o.geometry.index?.count || o.geometry.attributes.position?.count || 0) / 3) * (o.isInstancedMesh ? o.count : 1),
      hierarchyVisible: visibleHierarchy(o), car: car.includes(o),
    })).sort((a, b) => b.approximateTriangles - a.approximateTriangles).slice(0, 24);
    async function measure({ name, quality = 3, moving = true, hide = [], road = false, bloom = true }) {
      console.log(`PROFILE Starting ${name}`);
      collecting = false; clearGpuQueries();
      g.pressed.clear(); g.reset(); setQuality(quality);
      g.active = moving; g.yaw = 0; g.car.rotation.y = 0;
      g.carPosition.set(-22, .015, 160); g.car.position.copy(g.carPosition);
      // Fixed open avenue, reset speed/charge and inputs for each isolated comparison.
      if (moving) { g.velocity.set(0, 0, -28); for (const key of ['w', 'shift', 'f']) g.pressed.add(key); }
      g.updateCityVisibility(g.carPosition, quality); g.updateCamera(0, true);
      const savedVisibility = hide.map(object => [object, object.visible]);
      const savedRoad = road ? roadObjects.map(object => [object, object.material]) : [];
      hidden = hide;
      for (const [object, material] of savedRoad) object.material = defaultRoad(material);
      g.bloomPass.enabled = bloom;
      try {
        // Shader swaps and shadow captures complete before the measurement begins.
        await pause(1500);
        if (g !== document.querySelector('canvas').__drive || g.destroyed) throw new Error('Source changed during benchmark');
        for (const samples of Object.values(cpuSamples)) samples.length = 0;
        collecting = true;
        const frames = [], calls = [], triangles = [];
        let last;
        const positionStart = g.carPosition.toArray();
        const elapsedStart = g.elapsed;
        await new Promise(resolve => {
          const sample = time => {
            if (last !== undefined) { frames.push(time - last); calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles); }
            last = time;
            if (timer) pollGpu();
            if (frames.length < 90) requestAnimationFrame(sample); else resolve();
          };
          requestAnimationFrame(sample);
        });
        collecting = false;
        const cpu = Object.fromEntries(Object.entries(cpuSamples).map(([key, values]) => [key, summarize(values)]));
        const report = { name, framesMs: summarize(frames), calls: summarize(calls), triangles: summarize(triangles), cpu, gpuRenderMs: summarize(gpuTimes), quality: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), reflection: g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, shadows: g.renderer.shadowMap.enabled, bloom: g.bloomPass.enabled, hiddenObjects: hide.length, replacedRoadObjects: savedRoad.length, positionStart, positionEnd: g.carPosition.toArray(), elapsedSeconds: g.elapsed - elapsedStart, speedKmh: g.velocity.length() * 3.6, contextLost: gl.isContextLost() };
        console.log(`PROFILE Finished ${name}: frame p50=${report.framesMs.p50.toFixed(1)}ms p95=${report.framesMs.p95.toFixed(1)}ms; CPU render=${report.cpu.composerRender.p50.toFixed(1)}ms; calls=${report.calls.p50}; triangles=${report.triangles.p50}`);
        return report;
      } finally {
        collecting = false; hidden = [];
        for (const [object, visible] of savedVisibility) object.visible = visible;
        for (const [object, material] of savedRoad) object.material = material;
        g.bloomPass.enabled = originalBloom;
        g.active = false; g.pressed.clear();
      }
    }
    const scenarios = [];
    try {
      scenarios.push(await measure({ name: 'low / driving baseline' }));
      scenarios.push(await measure({ name: 'low / driving without facade hardware', hide: hardware }));
      scenarios.push(await measure({ name: 'low / driving with default asphalt shader', road: true }));
      scenarios.push(await measure({ name: 'low / driving without ocean', hide: ocean }));
      scenarios.push(await measure({ name: 'low / driving without shore geometry', hide: shore }));
      scenarios.push(await measure({ name: 'low / driving without bloom', bloom: false }));
      scenarios.push(await measure({ name: 'low / driving without car geometry', hide: car }));
      scenarios.push(await measure({ name: 'high / driving baseline', quality: 0 }));
      scenarios.push(await measure({ name: 'low / driving baseline repeat' }));
      return { ready, timerQueriesAvailable: !!timer, groupCounts: { hardware: hardware.length, road: roadObjects.length, ocean: ocean.length, shore: shore.length, car: car.length }, inventory, scenarios };
    } finally {
      collecting = false; hidden = []; clearGpuQueries();
      g.active = false; g.pressed.clear();
      g.composer.render = cpuRender;
      for (const restore of wrapped.reverse()) restore();
      g.updateRenderQuality = originalQualityUpdate;
      g.bloomPass.enabled = originalBloom;
      for (const material of defaultRoadMaterials.values()) material.dispose();
    }
  });
  console.log('Capturing central avenue at high quality');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.__profileWarmup = g.qualityWarmup; g.qualityWarmup = 1e9;
    g.reset(); g.active = false; g.qualityLevel = 0;
    g.renderer.shadowMap.enabled = true;
    g.renderer.shadowMap.needsUpdate = true;
    g.resize(); g.updateCityVisibility(g.carPosition, 0); g.updateCamera(0, true);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'artifacts/night-city-final-central.png' });
  console.log('Capturing midtower overview at high quality');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.__profileCameraUpdate = g.updateCamera; g.updateCamera = () => {};
    g.active = false; g.camera.position.set(-120, 155, 245);
    g.camera.lookAt(20, 90, -75); g.camera.far = 6000; g.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'artifacts/night-city-final-skyline.png' });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.updateCamera = g.__profileCameraUpdate; g.qualityWarmup = g.__profileWarmup;
    delete g.__profileCameraUpdate; delete g.__profileWarmup;
  });
  result.errors = errors;
  const output = `artifacts/night-city-profile-${label}.json`;
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Saved ${output}`);
  console.log(JSON.stringify({ ready: result.ready, groupCounts: result.groupCounts, errors }, null, 2));
} finally { await browser.close(); }
