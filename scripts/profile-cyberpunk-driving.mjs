import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(12000);
  const result = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const gl = g.renderer.getContext(), timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pendingQueries = [], gpuTimes = [];
    const samples = {};
    function wrap(object, method, name = method) {
      const original = object[method];
      if (typeof original !== 'function') return;
      samples[name] = [];
      object[method] = function(...args) { const start = performance.now(); const value = original.apply(this, args); samples[name].push(performance.now() - start); return value; };
    }
    for (const method of ['updateDriving', 'updateSnow', 'updateParticles', 'updateBullets', 'updateSmoke', 'updateCityVisibility', 'updateCamera', 'updateWheelContacts', 'onMapPosition', 'onTelemetry']) wrap(g, method);
    wrap(g.island, 'update', 'island'); wrap(g.composer, 'render', 'render'); wrap(g.audio, 'update', 'audio'); wrap(g.collisionWorld, 'sweep', 'collisionSweep'); wrap(g.audio, 'fireGun', 'gunAudio');
    if (timerExtension) {
      const cpuRender = g.composer.render;
      g.composer.render = function(...args) {
        const query = gl.createQuery(); gl.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
        const value = cpuRender.apply(this, args);
        gl.endQuery(timerExtension.TIME_ELAPSED_EXT); pendingQueries.push(query);
        return value;
      };
    }
    const summarize = values => { values.sort((a, b) => a - b); return { p50: values[Math.floor(values.length / 2)] || 0, p95: values[Math.floor(values.length * .95)] || 0, max: values.at(-1) || 0, n: values.length, mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length) }; };
    async function measure(name, keys) {
      g.reset(); g.active = true; keys.forEach(key => g.pressed.add(key));
      await new Promise(resolve => setTimeout(resolve, 1700));
      for (const samplesForMethod of Object.values(samples)) samplesForMethod.length = 0;
      for (const query of pendingQueries) gl.deleteQuery(query); pendingQueries.length = 0; gpuTimes.length = 0;
      const frames = [], calls = [], triangles = [];
      let last = performance.now();
      await new Promise(resolve => { function tick(t) {
        frames.push(t - last); last = t; calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
        while (pendingQueries.length && gl.getQueryParameter(pendingQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
          const query = pendingQueries.shift();
          if (!gl.getParameter(timerExtension.GPU_DISJOINT_EXT)) gpuTimes.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(query);
        }
        if (frames.length < 75) requestAnimationFrame(tick); else resolve();
      } requestAnimationFrame(tick); });
      const cpu = Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, summarize([...value])]));
      return { name, framesMs: summarize(frames), calls: summarize(calls), triangles: summarize(triangles), gpuRenderMs: summarize([...gpuTimes]), cpu, speed: g.lastTelemetry.speed, qualityLevel: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), position: g.carPosition.toArray(), telemetry: { ...g.lastTelemetry } };
    }
    const scenarios = [];
    scenarios.push(await measure('W', ['w']));
    scenarios.push(await measure('W+Shift', ['w', 'shift']));
    scenarios.push(await measure('W+Shift+F', ['w', 'shift', 'f']));
    if (g.audio.context) await g.audio.context.suspend();
    scenarios.push(await measure('W+Shift+F / audio suspended', ['w', 'shift', 'f']));
    for (const { vehicle } of g.flying) vehicle.visible = false;
    const hidden = [];
    g.scene.traverse(o => { if (o.isPoints && o !== g.snowfall.flakes) { hidden.push([o, o.visible]); o.visible = false; } });
    // Speed blur now shares the final output pass; keep its color conversion active.
    const present = g.presentationPass.render;
    g.presentationPass.render = function(...args) {
      this.uniforms.strength.value = 0;
      return present.apply(this, args);
    };
    scenarios.push(await measure('W+Shift+F / no smoke particles steam flying', ['w', 'shift', 'f']));
    hidden.forEach(([o, visible]) => o.visible = visible);
    for (const { vehicle } of g.flying) vehicle.visible = true;
    for (const mesh of g.scene.children.filter(o => o.userData.cityBounds)) {
      if (mesh.userData.detailRange === 150) mesh.userData.detailRange = 90;
      if (mesh.userData.detailRange === 220) mesh.userData.detailRange = 140;
    }
    const originalVisibility = g.updateCityVisibility;
    const instances = g.scene.children.filter(o => o.isInstancedMesh && o.userData.cityInstanceCells);
    let cellX = Infinity, cellZ = Infinity;
    g.updateCityVisibility = function(position) {
      originalVisibility(position);
      const x = Math.floor(position.x / 44), z = Math.floor(position.z / 44);
      if (x === cellX && z === cellZ) return;
      cellX = x; cellZ = z;
      const focusX = x * 44 + 22, focusZ = z * 44 + 22;
      for (const mesh of instances) {
        let offset = 0; const target = mesh.instanceMatrix.array;
        for (const cell of mesh.userData.cityInstanceCells) {
          const dx = Math.max(Math.abs(cell.x - focusX) - 13, 0), dz = Math.max(Math.abs(cell.z - focusZ) - 13, 0), distance = dx * dx + dz * dz;
          if (distance < 90 * 90) { target.set(cell.street, offset); offset += cell.street.length; }
          if (distance < 300 * 300) { target.set(cell.roof, offset); offset += cell.roof.length; }
        }
        mesh.count = offset / 16; mesh.visible = mesh.count > 0; mesh.instanceMatrix.needsUpdate = true;
      }
    };
    scenarios.push(await measure('W+Shift+F / street radius90 roof300 no audio', ['w', 'shift', 'f']));
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL), scenarios };
  });
  await writeFile('artifacts/cyberpunk-driving-profile.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
