import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
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
        if (mesh.geometry) { meshes++; if (playerGeometries.has(mesh.geometry)) shared++; }
        if (mesh.material?.userData.vehiclePaint) paint = mesh.material.color.getHexString();
      });
      return { shared, meshes, paint, wheels: car.rig.wheels.length,
        brakeIndependent: car.rig.brakeLights[0].material !== game.brakeLights[0].material };
    });
  });
  assert.equal(report.models.length, 4);
  assert.ok(report.models.every(car => car.shared === car.meshes && car.wheels === 4 && car.brakeIndependent), 'NPCs share player geometry and have independent animated lights');
  assert.equal(new Set(report.models.map(car => car.paint)).size, 4);

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
} finally { await browser.close(); }
