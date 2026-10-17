import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
if (process.env.CHECK_AUTOMATIC_GRAPHICS === '1') await mkdir('artifacts/graphics-upgrade', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  console.log('Loading traffic scene');
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.traffic, null, { timeout: 90000 });
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  report.models = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const playerGeometries = new Set();
    game.car.traverse(mesh => { if (mesh.geometry) playerGeometries.add(mesh.geometry); });
    return game.traffic.cars.map(car => {
      let shared = 0, meshes = 0, paint;
      car.rig.car.traverse(mesh => {
        if (mesh.geometry && !mesh.userData.trafficLod) { meshes++; if (playerGeometries.has(mesh.geometry)) shared++; }
        if (mesh.material?.userData.vehiclePaint) paint = mesh.material.color.getHexString();
      });
      return { shared, meshes, paint, wheels: car.rig.wheels.length,
        brakeIndependent: car.rig.brakeLights[0].material !== game.brakeLights[0].material };
    });
  });
  assert.equal(report.models.length, 4);
  assert.ok(report.models.every(car => car.shared === car.meshes && car.wheels === 4 && car.brakeIndependent), 'NPCs share player geometry and have independent animated lights');
  assert.equal(new Set(report.models.map(car => car.paint)).size, 4);

  report.lod = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, traffic = g.traffic;
    const snapshot = () => traffic.cars.map(car => {
      let meshes = 0, triangles = 0;
      car.rig.car.traverseVisible(mesh => {
        if (!mesh.isMesh) return;
        meshes++; triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
      });
      return { meshes, triangles, proxy: car.rig.lod.root.visible };
    });
    traffic.reset(); traffic.updateVisuals(0, g.carPosition);
    const near = snapshot(), before = traffic.cars.map(car => car.motion.position.toArray());
    const observer = traffic.cars[0].motion.position.clone(); observer.x -= 100;
    traffic.updateVisuals(0, observer);
    const far = snapshot(), after = traffic.cars.map(car => car.motion.position.toArray());
    const proxies = traffic.cars.map(car => car.rig.lod.root.children.map(mesh => mesh.geometry.uuid));
    const car = traffic.cars[1];
    car.rig.lod.update(80 ** 2, false, 0, 0, false, false);
    const holdsFar = car.rig.lod.root.visible;
    car.rig.lod.update(71 ** 2, false, 0, 0, false, false);
    const restoresNear = !car.rig.lod.root.visible;
    car.rig.lod.update(80 ** 2, false, 0, 0, false, false);
    const holdsNear = !car.rig.lod.root.visible;
    traffic.reset();
    return { near, far, before, after, proxies, holdsFar, restoresNear, holdsNear };
  });
  assert.equal(report.lod.near.filter(car => car.proxy).length, 0, 'Launch grid keeps full authored cars');
  assert.equal(report.lod.far.filter(car => car.proxy).length, 3, 'The nearest car stays complete and distant cars remain visible');
  assert.ok(report.lod.far.filter(car => car.proxy).every(car => car.meshes <= 6), 'Distant exterior costs at most six draws');
  // Preserve panel-normal seams while reducing vertices. Draw submission is
  // the primary budget; avoid buying fewer triangles with broken shading.
  assert.ok(report.lod.far.filter(car => car.proxy).every(car => car.triangles < report.lod.near[0].triangles * .65), 'Distant geometry retains smooth panels within its triangle budget');
  assert.deepEqual(report.lod.before, report.lod.after, 'Visual LOD does not move traffic');
  assert.ok(report.lod.proxies.every(ids => JSON.stringify(ids) === JSON.stringify(report.lod.proxies[0])), 'Traffic shares one proxy geometry cache');
  assert.ok(report.lod.holdsFar && report.lod.restoresNear && report.lod.holdsNear, 'LOD has a stable distance margin');

  report.mirrors = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    const original = g.getGraphicsStatus().preset;
    const results = ['low', 'medium', 'high', 'ultra'].map(preset => {
      g.drivingMirrors.setPreset(preset);
      return { preset, targets: g.drivingMirrors.mirrors.map(mirror => ({
        rearview: mirror.isRearview, width: mirror.target.width, height: mirror.target.height })) };
    });
    g.drivingMirrors.setPreset(original);
    return results;
  });
  for (const [index, preset] of report.mirrors.entries()) {
    const width = [128, 256, 320, 384][index];
    assert.ok(preset.targets.every(target => target.width === (target.rearview ? Math.round(width * 1.75 / 32) * 32 : width)), 'Mirror detail follows the upgraded preset');
  }

  if (process.env.CHECK_AUTOMATIC_GRAPHICS === '1') {
    console.log('Measuring real automatic Ultra rendering for 35 seconds');
    await page.waitForFunction(() => document.querySelector('canvas').__drive.person.ready, null, { timeout: 90000 });
    report.automaticGraphics = await page.evaluate(async () => {
      const g = document.querySelector('canvas').__drive;
      g.reset(); g.setCameraView('chase'); g.setAutomaticGraphics(true); g.setGraphicsQuality('ultra');
      const automaticAfterSelection = g.getGraphicsStatus().automatic;
      g.qualityWarmup = 0; g.qualityResumeTime = 0; g.elapsed = 40;
      g.carPosition.set(-22, .015, 176); g.previousPosition.copy(g.carPosition); g.car.position.copy(g.carPosition);
      g.velocity.set(0, 0, -48); g.yaw = 0; g.car.rotation.y = 0; g.pressed.add('w');
      g.active = true; g.previousTime = 0; g.updateCamera(0, true);
      const initial = g.getGraphicsStatus(), frames = [], timeline = [];
      let started, previous, lastSecond = -1;
      g.animationFrame = requestAnimationFrame(g.frameHandler);
      try {
        await new Promise((resolve, reject) => {
          const tick = () => {
            if (g.destroyed || g !== document.querySelector('canvas').__drive) { reject(new Error('Game replaced during automatic rendering check')); return; }
            const now = performance.now();
            // Exclude the initial Ultra shader compile, then observe a complete
            // 35 seconds of rendered driving through the real adaptive sampler.
            if (started === undefined) { started = now; g.previousTime = 0; }
            const age = now - started;
            if (g.carPosition.z < -176) {
              g.carPosition.z += 352; g.previousPosition.z += 352; g.camera.position.z += 352; g.car.position.copy(g.carPosition);
            }
            if (previous !== undefined) frames.push({ age, ms: now - previous });
            previous = now;
            const second = Math.floor(age / 1000);
            if (second !== lastSecond) {
              lastSecond = second; timeline.push({ second, ...g.getGraphicsStatus(), pressure: g.qualityLevel, speed: g.lastTelemetry.speed });
            }
            if (age < 35000) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        const summarize = samples => {
          const values = samples.map(frame => frame.ms).sort((a, b) => a - b), n = values.length;
          return { n, mean: values.reduce((sum, ms) => sum + ms, 0) / Math.max(1, n),
            p50: values[Math.floor(n * .5)] || 0, p95: values[Math.floor(n * .95)] || 0 };
        };
        return { initial, automaticAfterSelection, final: g.getGraphicsStatus(), finalPressure: g.qualityLevel, timeline,
          firstFiveSeconds: summarize(frames.filter(frame => frame.age < 5000)),
          lastFiveSeconds: summarize(frames.filter(frame => frame.age >= 30000)),
          contextLost: g.renderer.getContext().isContextLost() };
      } finally {
        cancelAnimationFrame(g.animationFrame); g.active = false; g.pressed.clear(); g.setGraphicsQuality('low'); g.reset();
      }
    });
    await writeFile('artifacts/graphics-upgrade/automatic-ultra.json', JSON.stringify(report.automaticGraphics, null, 2));
    console.log(JSON.stringify(report.automaticGraphics, null, 2));
    assert.equal(report.automaticGraphics.automaticAfterSelection, true, 'Preset changes preserve the chosen automatic mode');
    assert.ok(report.automaticGraphics.finalPressure > 0, 'Actual slow frames trigger automatic rendering pressure');
    assert.ok(report.automaticGraphics.final.resolutionScale < report.automaticGraphics.initial.resolutionScale, 'Automatic rendering reduces actual scene work');
    assert.ok(report.automaticGraphics.lastFiveSeconds.n > 10);
    assert.equal(report.automaticGraphics.final.preset, 'ultra', 'The selected visual target is retained');
    assert.equal(report.automaticGraphics.contextLost, false);
  }

  if (process.env.VISUAL_CHECKS_ONLY !== '1') {
  console.log('Simulating three minutes of traffic through the real city and snow physics');
  report.patrol = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive, traffic = game.traffic;
    const travel = traffic.cars.map(() => 0), maximumError = traffic.cars.map(() => 0), stopped = traffic.cars.map(() => 0);
    const previous = traffic.cars.map(car => car.motion.position.clone());
    let nonFinite = false, buildingOverlaps = 0;
    const player = game.vehicleMotion;
    player.position.set(-22, .015, -22); player.velocity.set(0, 0, 0); player.yaw = 0;
    for (let tick = 0; tick < 180 * 120; tick++) {
      traffic.step(1 / 120, player);
      for (let i = 0; i < traffic.cars.length; i++) {
        const car = traffic.cars[i], motion = car.motion;
        travel[i] += motion.position.distanceTo(previous[i]); previous[i].copy(motion.position);
        if (motion.velocity.length() < .5) stopped[i]++;
        if (![...motion.position.toArray(), ...motion.velocity.toArray(), motion.yaw].every(Number.isFinite)) nonFinite = true;
        if (tick % 120 !== 0) continue;
        const routeError = Math.min(...car.route.points.map(point => Math.hypot(point.x - motion.position.x, point.z - motion.position.z)));
        maximumError[i] = Math.max(maximumError[i], routeError);
        const c = Math.abs(Math.cos(motion.yaw)), s = Math.abs(Math.sin(motion.yaw));
        const hx = c * 1.05 + s * 2.65, hz = s * 1.05 + c * 2.65;
        if (game.collisionWorld.query(motion.position).some(box => Math.abs(box.x - motion.position.x) < box.hx + hx - .02 && Math.abs(box.z - motion.position.z) < box.hz + hz - .02)) buildingOverlaps++;
      }
    }
    traffic.updateVisuals(0, player.position);
    return { nonFinite, buildingOverlaps, collisions: traffic.collisions, cars: traffic.cars.map((car, i) => ({
      position: car.motion.position.toArray(), speed: car.motion.velocity.length() * 3.6, travel: travel[i], laps: car.laps,
      maximumError: maximumError[i], stoppedSeconds: stopped[i] / 120, input: car.input,
      nearby: game.collisionWorld.query(car.motion.position).filter(box => Math.abs(box.x - car.motion.position.x) < box.hx + 3 && Math.abs(box.z - car.motion.position.z) < box.hz + 3),
    })) };
  });
  console.log(JSON.stringify(report.patrol, null, 2));
  await writeFile('artifacts/ai-traffic-verification.json', JSON.stringify(report, null, 2));
  assert.equal(report.patrol.nonFinite, false);
  assert.equal(report.patrol.buildingOverlaps, 0, 'All NPCs remain outside scenery colliders');
  assert.ok(report.patrol.cars.every(car => car.travel > 700 && car.laps >= 1 && car.maximumError < 4), 'Every car completes its circuit and stays in its lane');

  report.braking = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive, traffic = game.traffic, car = traffic.cars[0];
    for (const [i, other] of traffic.cars.entries()) { other.motion.position.set(105.6, .015, 50 + i * 20); other.motion.velocity.set(0, 0, 0); }
    car.motion.position.set(-17.6, .015, -40); car.motion.velocity.set(0, 0, -10); car.motion.yaw = 0;
    game.carPosition.set(-17.6, .015, -57); game.velocity.set(0, 0, 0); game.vehicleMotion.yaw = 0;
    let nearest = Infinity, brakeSeen = false;
    for (let i = 0; i < 6 * 120; i++) {
      traffic.step(1 / 120, game.vehicleMotion);
      nearest = Math.min(nearest, car.motion.position.distanceTo(game.carPosition));
      brakeSeen ||= car.input.brake > .1;
    }
    traffic.updateVisuals(1 / 60, game.carPosition);
    const stop = { speed: car.motion.velocity.length(), nearest, brakeSeen,
      brakeIntensity: car.rig.brakeLights[0].material.emissiveIntensity };
    game.carPosition.set(-22, .015, -22);
    for (let i = 0; i < 2 * 120; i++) traffic.step(1 / 120, game.vehicleMotion);
    return { ...stop, resumedSpeed: car.motion.velocity.length() };
  });
  console.log('Braking:', JSON.stringify(report.braking));
  await writeFile('artifacts/ai-traffic-verification.json', JSON.stringify(report, null, 2));
  assert.ok(report.braking.brakeSeen && report.braking.speed < .5 && report.braking.nearest > 5.3, 'NPC brakes and stops behind a parked player');
  assert.ok(report.braking.brakeIntensity > 4 && report.braking.resumedSpeed > 2, 'Brake lights illuminate, and traffic resumes when clear');

  report.collision = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive, traffic = game.traffic, car = traffic.cars[0];
    game.reset();
    game.carPosition.set(-17.6, .015, -35); game.velocity.set(0, 0, -90); game.yaw = 0;
    game.vehicleMotion.yaw = 0;
    car.motion.position.set(-17.6, .015, -48); car.motion.velocity.set(0, 0, 0); car.motion.yaw = 0;
    const before = traffic.collisions;
    game.nitroRemaining = 3; game.nitroTargetSpeed = 90; game.boostCharge = 100;
    for (let i = 0; i < 12; i++) game.updateDriving(1 / 120);
    return { collisions: traffic.collisions - before, playerSpeed: game.velocity.length(), npcSpeed: car.motion.velocity.length(), nitroRemaining: game.nitroRemaining,
      distance: game.carPosition.distanceTo(car.motion.position) };
  });
  console.log('Collision:', JSON.stringify(report.collision));
  assert.ok(report.collision.collisions > 0 && report.collision.playerSpeed < 70 && report.collision.npcSpeed > 10, 'High-speed player impact transfers momentum to NPC');
  assert.equal(report.collision.nitroRemaining, 0, 'Collision cancels nitro');
  assert.ok(report.collision.distance > 5.2, 'Cars do not tunnel through each other');

  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.traffic, null, { timeout: 90000 });
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => { const game = document.querySelector('canvas').__drive; game.previousTime = 0; game.animationFrame = requestAnimationFrame(game.frameHandler); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'artifacts/ai-traffic-driving.png' });
  assert.equal(await page.locator('[data-traffic-marker][visibility="visible"]').count(), 4, 'Minimap tracks all four NPCs');
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.camera.position.set(-48, 14, -12); game.camera.lookAt(-14, 1, -65); game.updateCamera = () => {};
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'artifacts/ai-traffic-overview.png' });
  report.render = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    return { calls: game.renderer.info.render.calls, triangles: game.renderer.info.render.triangles, geometries: game.renderer.info.memory.geometries,
      contextLost: game.renderer.getContext().isContextLost() };
  });
  report.errors = errors;
  await writeFile('artifacts/ai-traffic-verification.json', JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0, 'No runtime or shader errors');
  assert.equal(report.render.contextLost, false);
  console.log(JSON.stringify(report, null, 2));
  } else {
    report.errors = errors;
    await writeFile('artifacts/ai-traffic-visual-verification.json', JSON.stringify(report, null, 2));
    assert.deepEqual(errors, [], 'No runtime or shader errors');
    console.log('Traffic LOD, mirror targets and real automatic rendering verified');
  }
} finally { await browser.close(); }
