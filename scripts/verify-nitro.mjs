import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const baselineOnly = process.env.NITRO_BASELINE === '1';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();

  const seed = async (kmh = 100, extra = {}) => page.evaluate(({ kmh, extra }) => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.reset(); g.active = true;
    if (g.cameraView !== 'chase') g.setCameraView('chase');
    // Pin each step to this straight road when isolating speed and input behavior.
    g.carPosition.set(-22, .015, -60); g.car.position.copy(g.carPosition);
    g.velocity.set(0, 0, -kmh / 3.6);
    g.forward.set(0, 0, -1); g.right.set(1, 0, 0);
    Object.assign(g, extra);
    g.updateCamera(0, true);
  }, { kmh, extra });
  const advance = async (seconds, fps = 60) => page.evaluate(({ seconds, fps }) => {
    const g = document.querySelector('canvas').__drive;
    let peak = g.velocity.length() * 3.6;
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      g.carPosition.set(-22, .015, -60); g.car.position.copy(g.carPosition);
      g.elapsed += 1 / fps;
      g.updateDriving(1 / fps); g.updateParticles(1 / fps);
      peak = Math.max(peak, g.velocity.length() * 3.6);
      if (![...g.velocity.toArray(), ...g.carPosition.toArray(), g.yaw, g.boostCharge].every(Number.isFinite)) throw new Error('Non-finite nitro state');
    }
    return {
      speed: g.velocity.length() * 3.6, peak,
      boosting: g.lastTelemetry.boosting, charge: g.boostCharge,
      remaining: g.nitroRemaining, target: g.nitroTargetSpeed * 3.6,
      particles: g.particles.length,
      effectStrength: g.carRig.nitroEffects?.mesh?.material.uniforms.uStrength.value,
      effectVisible: g.carRig.nitroEffects?.mesh?.visible,
      active: g.active, keys: [...g.pressed], reverse: g.reverseEngaged,
      geometryCount: g.renderer.info.memory.geometries,
      textureCount: g.renderer.info.memory.textures,
      contextLost: g.renderer.getContext().isContextLost(),
    };
  }, { seconds, fps });

  async function performanceSample(boosting) {
    await seed(100);
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      // Same camera, speed and tier isolate the effect's cost from nitro's FOV
      // change and the different city blocks visible during a moving drive.
      g.qualityLevel = 2; g.qualityWarmup = Infinity;
      g.reflections.setQuality(2); g.renderer.shadowMap.enabled = false; g.resize();
      g.active = false;
      g.updateSnow(0); g.updateCityVisibility(g.carPosition, 2);
      g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
    });
    const result = await page.evaluate(async boosting => {
      const g = document.querySelector('canvas').__drive;
      const frameMs = [], cpuMs = [], calls = [], triangles = [];
      let last = performance.now();
      g.previousTime = last;
      await new Promise(resolve => {
        let samples = 0;
        function sample(now) {
          g.carRig.nitroEffects.update(now / 1000, 1 / 60, boosting ? 1 : 0);
          const start = performance.now();
          g.renderer.info.reset(); g.composer.render();
          if (samples >= 12) {
            frameMs.push(now - last); cpuMs.push(performance.now() - start);
            calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles);
          }
          last = now; samples++;
          if (samples < 102) requestAnimationFrame(sample); else resolve();
        }
        requestAnimationFrame(sample);
      });
      for (const values of [frameMs, cpuMs, calls, triangles]) values.sort((a, b) => a - b);
      const at = (values, quantile) => values[Math.floor((values.length - 1) * quantile)];
      return {
        medianFrameMs: at(frameMs, .5), p95FrameMs: at(frameMs, .95),
        medianCpuMs: at(cpuMs, .5), p95CpuMs: at(cpuMs, .95),
        calls: at(calls, .5), triangles: at(triangles, .5),
        pixelRatio: g.renderer.getPixelRatio(), qualityLevel: g.qualityLevel,
        geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures,
        particles: g.particles.length,
        passes: g.composer.passes.length,
        contextLost: g.renderer.getContext().isContextLost(),
      };
    }, boosting);
    return result;
  }

  if (baselineOnly) {
    report.baseline = await performanceSample(false);
  } else {
    console.log('Checking speed targets and frame-rate response');
    report.speedTargets = [];
    for (const kmh of [1, 25, 100, 220]) {
      await seed(kmh);
      await page.keyboard.press('p');
      const state = await advance(.6);
      assert.equal(state.boosting, true, `P starts a burst at ${kmh} km/h without W`);
      assert.ok(Math.abs(state.speed - kmh * 1.6) < Math.max(.1, kmh * .018), `Nitro quickly reaches 160% of ${kmh} km/h: ${state.speed}`);
      assert.ok(state.peak <= 352.01, 'Nitro honors its extended speed limit');
      assert.ok(state.charge < 100 && state.charge > 75, 'One burst drains charge over time');
      report.speedTargets.push({ initial: kmh, ...state });
    }
    report.frameRates = [];
    for (const fps of [30, 60, 144]) {
      await seed(100); await page.keyboard.press('p');
      report.frameRates.push({ fps, ...await advance(.5, fps) });
    }
    for (const result of report.frameRates) assert.ok(Math.abs(result.speed - report.frameRates[0].speed) < .15, 'Nitro response stays consistent across render frame rates');

    await seed(0); await page.keyboard.down('w'); await page.keyboard.press('p');
    report.launch = await advance(.3);
    await page.keyboard.up('w');
    assert.ok(report.launch.boosting && report.launch.speed > 4, 'W plus P provides launch assistance from standstill');
    await seed(100); await page.keyboard.press('Shift');
    report.shiftAlias = await advance(.5);
    assert.ok(report.shiftAlias.boosting && report.shiftAlias.speed > 157, 'Shift retains the same one-press burst behavior');

    await seed(220); await page.keyboard.press('p');
    const beforeExpiry = await advance(2.95);
    report.expiryMomentum = await advance(.1);
    assert.equal(report.expiryMomentum.boosting, false, 'The high-speed burst expires normally');
    assert.ok(report.expiryMomentum.speed > 300 && report.expiryMomentum.speed <= beforeExpiry.speed && beforeExpiry.speed - report.expiryMomentum.speed < 10, 'Expiry retains overspeed momentum and slows smoothly');

    console.log('Checking burst expiry, repeat input and recharge');
    await seed(100); await page.keyboard.down('p');
    const initialBurst = await advance(.6);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', repeat: true })));
    report.heldKey = await advance(2.7);
    assert.ok(report.heldKey.peak <= 161 && report.heldKey.speed < initialBurst.speed + 1, 'Repeated keydown cannot multiply the ongoing burst');
    assert.equal(report.heldKey.boosting, false, 'A burst expires after three seconds even with P held');
    report.heldRecharged = await advance(10);
    assert.equal(report.heldRecharged.boosting, false, 'Holding P through recharge does not automatically reactivate');
    assert.equal(report.heldRecharged.charge, 100, 'Charge regenerates to full');
    await page.keyboard.up('p');
    await page.keyboard.press('p');
    report.rearmed = await advance(.2);
    assert.equal(report.rearmed.boosting, true, 'A fresh P press can activate after full recharge: ' + JSON.stringify(report.rearmed));
    const drained = report.rearmed.charge;
    await page.keyboard.down('s');
    await advance(.02);
    await page.keyboard.up('s');
    await page.keyboard.press('p');
    report.lowCharge = await advance(.05);
    assert.equal(report.lowCharge.boosting, false, 'A cancelled burst requires a full recharge before rearming');
    assert.ok(report.lowCharge.charge >= drained, 'An unsuccessful activation cannot spend charge');

    console.log('Checking cancellation and ineligible input');
    report.cancellations = [];
    for (const key of ['s', ' ']) {
      await seed(100); await page.keyboard.press('p'); await advance(.2);
      await page.keyboard.down(key);
      const state = await advance(.05);
      await page.keyboard.up(key);
      assert.equal(state.boosting, false, `${JSON.stringify(key)} cancels nitro immediately`);
      assert.ok(state.effectStrength < .001 && !state.effectVisible, 'Cancelling extinguishes the rear jets');
      report.cancellations.push({ key, ...state });
    }
    await seed(100); await page.keyboard.press('p'); await advance(.2);
    await page.keyboard.press('r');
    report.reset = await advance(.02);
    assert.equal(report.reset.boosting, false, 'Reset cancels the burst');
    assert.equal(report.reset.speed, 0, 'Reset clears velocity');
    assert.equal(report.reset.charge, 100, 'Reset restores charge');
    await seed(100); await page.keyboard.press('p'); await advance(.2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    report.blur = await advance(.02);
    assert.equal(report.blur.boosting, false, 'Window blur cancels the burst');

    await seed(100); await page.keyboard.press('p');
    report.collision = await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      const collider = g.colliders.find(box => Math.abs(box.x) < 100 && Math.abs(box.z) < 100 && box.hx > 3 && box.hz > 3);
      if (!collider) throw new Error('No nearby building collider for integration test');
      g.carPosition.set(collider.x, .015, collider.z + collider.hz + 2.65 + .08);
      g.car.position.copy(g.carPosition);
      g.updateDriving(1 / 60);
      return { collider, boosting: g.lastTelemetry.boosting, remaining: g.nitroRemaining, speed: g.velocity.length() * 3.6, effectVisible: g.carRig.nitroEffects.mesh.visible };
    });
    assert.ok(!report.collision.boosting && report.collision.remaining === 0 && !report.collision.effectVisible, 'A real swept building collision cancels nitro immediately');

    report.ineligible = [];
    for (const [label, speed, extra] of [['parked', 0, {}], ['reverse', -40, { reverseEngaged: true }], ['orbit', 100, { cameraView: 'orbit' }], ['inactive', 100, { active: false }]]) {
      await seed(speed, extra); await page.keyboard.press('p');
      const state = await advance(.05);
      assert.equal(state.boosting, false, `${label} state cannot activate nitro`);
      assert.equal(state.charge, 100, 'Rejected input preserves charge');
      report.ineligible.push({ label, ...state });
    }

    console.log('Capturing rear jet visuals');
    await seed(100); await page.keyboard.press('p');
    report.visuals = await advance(.25);
    report.outlets = await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      const mesh = g.carRig.nitroEffects.mesh;
      const origins = mesh.geometry.attributes.aOrigin;
      const jets = mesh.geometry.attributes.aJet;
      const distinct = new Set();
      for (let i = 0; i < origins.count; i++) if (jets.getZ(i) < 1.5) distinct.add(origins.getX(i).toFixed(3));
      return { x: [...distinct].map(Number).sort((a, b) => a - b), triangles: mesh.geometry.index.count / 3,
        material: mesh.material.name, castsShadow: mesh.castShadow, singlePass: mesh.material.forceSinglePass };
    });
    assert.deepEqual(report.outlets.x, [-.8, -.225, -.075, .075, .225, .8], 'Green fire exits both bumper ends and four center cans');
    assert.match(report.outlets.material, /emerald fire/, 'Nitro uses green fire');
    assert.equal(report.outlets.castsShadow, false);
    assert.equal(report.outlets.singlePass, true);
    assert.ok(report.outlets.triangles < 2500, 'Six jets retain a small geometry budget');
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.updateCamera(0, true); g.updateSnow(0); g.updateCityVisibility(g.carPosition);
      g.camera.position.copy(g.carPosition).add({ x: -4.6, y: 2, z: 6.9 });
      g.camera.fov = 45; g.camera.updateProjectionMatrix();
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: .65, z: 0 }));
      g.onTelemetry(g.lastTelemetry); g.onMapPosition(g.carPosition.x, g.carPosition.z, g.yaw);
      g.scene.updateMatrixWorld(true); g.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 3; i++) g.composer.render();
    });
    await page.screenshot({ path: 'artifacts/nitro-rear.png' });
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x: 0, y: 1.2, z: 7.6 });
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: .45, z: .5 }));
      for (let i = 0; i < 3; i++) g.composer.render();
    });
    await page.screenshot({ path: 'artifacts/nitro-rear-center.png' });
    assert.ok(report.visuals.effectStrength > .9, 'Active nitro illuminates its rear jets');
    if (report.visuals.effectVisible !== undefined) assert.equal(report.visuals.effectVisible, true, 'The pooled rear plume is visible during the burst');

    console.log('Measuring identical-scene frame cost with green jets off and on');
    report.performance = { off: await performanceSample(false), on: await performanceSample(true) };
    assert.equal(report.performance.on.contextLost, false, 'WebGL stays healthy during nitro');
    assert.equal(report.performance.off.passes, report.performance.on.passes, 'Nitro adds no render passes');
    assert.equal(report.performance.on.calls, report.performance.off.calls + 1, 'All six flames and reflections use exactly one added draw');
    assert.ok(report.performance.on.geometries <= report.performance.off.geometries + 2 && report.performance.on.textures <= report.performance.off.textures + 1, 'A burst reuses existing geometry and textures');
    assert.ok(report.performance.on.particles <= 180, 'The exhaust particle pool remains bounded');
  }
  report.errors = errors;
  await writeFile(`artifacts/nitro-${baselineOnly ? 'baseline' : 'verification'}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No runtime or shader errors');
} finally {
  await browser.close();
}
