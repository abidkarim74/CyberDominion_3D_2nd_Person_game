import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Diagnostic capture: compare expensive effects while retaining sharp scene buffers.
const label = process.argv[2] || 'candidates';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', e => { if (e.type() === 'error') { errors.push(e.text()); console.error(e.text()); } });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({noWaitAfter:true});
  await page.waitForFunction(() => document.querySelector('main')?.classList.contains('is-driving'));
  await page.evaluate(() => { document.querySelector('canvas').__drive.qualityWarmup = 1e9; });
  const scenarios = label === 'final' ? [
    { name: 'adaptive', live: true },
    { name: 'tier-4-nitro', tier: 4, pixels: 1_000_000, cityTier: 0, boost: true },
  ] : label === 'balanced' ? [
    {name:'1000k',tier:4,pixels:1_000_000,cityTier:0,presentationPixels:1_000_000},
    {name:'750k',tier:4,pixels:750_000,cityTier:0,presentationPixels:1_000_000},
    {name:'650k',tier:4,pixels:650_000,cityTier:0,presentationPixels:1_000_000},
  ] : [
    { name: 'initial', tier: 0, pixels: 1_000_000, cityTier: 0 },
    { name: 'sharp-effects-3', tier: 3, pixels: 1_000_000, cityTier: 0, bloomScale: .3 },
    { name: 'sharp-effects-4', tier: 4, pixels: 1_000_000, cityTier: 0, bloomScale: .22 },
    { name: 'sharp-effects-4-750k', tier: 4, pixels: 750_000, cityTier: 0, bloomScale: .22 },
  ];
  const reports = [];
  await mkdir('artifacts/driving-clarity', { recursive: true });
  for (const scenario of scenarios) {
    console.log(`Profiling ${scenario.name}`);
    await page.evaluate(s => {
      const g = document.querySelector('canvas').__drive;
      if (!g.originalClarityPixelRatio) {
        g.originalClarityPixelRatio = g.renderPixelRatio;
        g.originalClarityVisibility = g.updateCityVisibility;
      }
      if (s.live) {
        g.qualityWarmup = 8;
      } else {
        g.qualityWarmup = 1e9;
        g.renderPixelRatio = () => Math.min(devicePixelRatio || 1, 1.25, Math.sqrt(s.pixels / (innerWidth * innerHeight)));
        g.updateCityVisibility = p => g.originalClarityVisibility(p, s.cityTier);
        g.qualityLevel = s.tier;
        g.renderer.shadowMap.enabled = s.tier < 3;
        g.renderer.shadowMap.needsUpdate = s.tier < 3;
        g.resize();
        if (s.presentationPixels) {
          const ratio=Math.min(devicePixelRatio||1,1.25,Math.max(g.scenePixelRatio,Math.sqrt(s.presentationPixels/(innerWidth*innerHeight))));
          g.renderer.setPixelRatio(ratio);g.renderer.setSize(innerWidth,innerHeight,false);
          for(const point of g.scenePointMaterials) point.material.size=point.size*g.scenePixelRatio/ratio;
        }
        if (s.bloomScale !== undefined) {
          g.bloomPass.enabled = true;
          g.bloomPass.setSize(Math.round(innerWidth * g.scenePixelRatio * s.bloomScale),
            Math.round(innerHeight * g.scenePixelRatio * s.bloomScale));
        }
      }
      g.reset(); g.active = true; g.yaw = 0; g.car.rotation.y = 0;
      g.carPosition.set(-22, .015, 176); g.car.position.copy(g.carPosition);
      g.velocity.set(0, 0, -48); g.pressed.add('w'); g.updateCamera(0, true);
      if (s.boost) { g.pressed.add('f'); g.activateNitro(); }
    }, scenario);
    const report = await page.evaluate(async scenario => {
      const g = document.querySelector('canvas').__drive;
      const gl = g.renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const frames = [], cpu = [], gpu = [], queries = [], draws = [], tiers = [], sourcePixels = [], timeline = [];
      let previousTier = -1, boostingFrames = 0, firingFrames = 0;
      let collecting = false;
      const original = g.composer.render;
      g.composer.render = function(...args) {
        const q = collecting && timer ? gl.createQuery() : null;
        if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
        const start = performance.now();
        try { return original.apply(this, args); }
        finally {
          if (collecting) cpu.push(performance.now() - start);
          if (q) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push(q); }
        }
      };
      const summarize = a => {
        const s = [...a].sort((x, y) => x - y);
        return { mean: s.reduce((x,y) => x+y, 0)/Math.max(1,s.length), p50:s[Math.floor(s.length*.5)], p95:s[Math.floor(s.length*.95)], max:s.at(-1), n:s.length };
      };
      const start = performance.now(), warmup = scenario.live ? 25000 : 2500, duration = scenario.live ? 12000 : 6000;
      let prior;
      try {
        await new Promise((resolve, reject) => {
          const tick = time => {
            if (g.destroyed || g !== document.querySelector('canvas')?.__drive) {
              reject(new Error('Preview reloaded during the capture')); return;
            }
            if (g.carPosition.z < -176) {
              g.carPosition.z += 352; g.previousPosition.z += 352; g.camera.position.z += 352;
              g.car.position.copy(g.carPosition);
              if (scenario.boost) { g.boostCharge = 100; g.activateNitro(); }
            }
            const age = performance.now() - start;
            sourcePixels.push(g.composer.readBuffer.width * g.composer.readBuffer.height);
            if (previousTier !== g.qualityLevel) {
              previousTier = g.qualityLevel;
              timeline.push({ seconds:age/1000, tier:g.qualityLevel, sourcePixels:sourcePixels.at(-1),
                bloom:g.bloomPass.enabled, reflection:g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, shadows:g.renderer.shadowMap.enabled });
            }
            if (age > warmup) {
              collecting = true;
              if (prior !== undefined) frames.push(time-prior);
              prior = time; draws.push(g.renderer.info.render.calls); tiers.push(g.qualityLevel);
              if (g.lastTelemetry.boosting) boostingFrames++;
              if (g.lastTelemetry.firing) firingFrames++;
            }
            while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
              const q = queries.shift();
              if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT)/1e6);
              gl.deleteQuery(q);
            }
            if (age < warmup+duration) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        return { frameMs:summarize(frames), cpuRenderMs:summarize(cpu), gpuRenderMs:summarize(gpu), draws:summarize(draws),
          tier:g.qualityLevel, sampledTiers:[...new Set(tiers)], source:[g.composer.readBuffer.width,g.composer.readBuffer.height],
          canvas:[g.renderer.domElement.width,g.renderer.domElement.height], bloom:g.bloomPass.enabled,
          bloomType:g.bloomPass.constructor.name, reflection:g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false,
          shadows:g.renderer.shadowMap.enabled, blurStrength:g.presentationPass.uniforms.strength.value,
          sourcePixelRange:[Math.min(...sourcePixels),Math.max(...sourcePixels)], timeline,
          boostingFrames, firingFrames, contextLost:gl.isContextLost() };
      } finally {
        g.composer.render = original; g.pressed.clear(); g.active=false;
        queries.forEach(q => gl.deleteQuery(q));
      }
    }, scenario);
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.active=false; g.elapsed=40;
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path:`artifacts/driving-clarity/${label}-${scenario.name}.png` });
    reports.push({ scenario, ...report });
    console.log(JSON.stringify(reports.at(-1), null, 2));
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(400);
  await page.screenshot({path:`artifacts/driving-clarity/${label}-mobile.png`});
  const mobile = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { viewport:[innerWidth,innerHeight], source:[g.composer.readBuffer.width,g.composer.readBuffer.height],
      canvas:[g.renderer.domElement.width,g.renderer.domElement.height], overflow:document.documentElement.scrollWidth>innerWidth,
      reflection:g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, contextLost:g.renderer.getContext().isContextLost() };
  });
  console.log(JSON.stringify({mobile,errors},null,2));
  await writeFile(`artifacts/driving-clarity/${label}.json`, JSON.stringify({ reports, mobile, errors }, null, 2));
} finally {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (!page.isClosed()) await page.evaluate(() => document.querySelector('canvas')?.__drive?.destroy()).catch(() => {});
  }
  await browser.close();
}
