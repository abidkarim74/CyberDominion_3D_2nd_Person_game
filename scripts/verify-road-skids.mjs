import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.roadSkidMarks, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  const state = () => page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    return { speed: game.velocity.length() * 3.6, position: game.carPosition.toArray(), yaw: game.yaw,
      drifting: game.lastTelemetry.drifting, marks: game.roadSkidMarks.diagnostics(), audio: game.audioDiagnostics() };
  });
  await page.keyboard.down('w');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.velocity.length() * 3.6 >= 105, null, { timeout: 30000 });
  await page.keyboard.up('w');
  const beforeBrake = await state();
  assert.equal(beforeBrake.marks.emitted, 0, 'Straight acceleration creates no rubber trails');
  assert.equal(beforeBrake.audio.levels.tire, 0, 'Straight acceleration creates no tire squeal');
  await page.keyboard.down('s');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.roadSkidMarks.diagnostics().emitted > 20, null, { timeout: 10000 });
  const braking = await state();
  assert.ok(braking.speed < beforeBrake.speed, 'The service brake slows the car');
  assert.ok(braking.audio.levels.tire > .005 && braking.audio.frame.tireSqueal > .2, 'Straight hard braking produces audible tire scrub');
  assert.equal(braking.drifting, false, 'Straight braking squeals without reporting a sideways drift');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.velocity.length() < .01, null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('canvas').__drive.audioDiagnostics().levels.tire === 0, null, { timeout: 5000 });
  const stopped = await state();
  assert.equal(stopped.speed, 0, 'Holding the brake stops the car without engaging reverse');
  assert.ok(Math.abs(stopped.yaw) < 1e-6, 'Straight braking preserves the heading');
  assert.ok(stopped.marks.emitted > 80, 'Rubber marks persist through the hard stop');
  await page.keyboard.up('s');

  const visual = await page.evaluate((start) => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame);
    const mesh = game.roadSkidMarks.mesh;
    const positions = mesh.geometry.attributes.position.array;
    const anchored = Array.from(positions);
    const geometry = mesh.geometry;
    const car = game.carPosition.clone();
    const midpointZ = (start[2] + car.z) / 2;
    game.camera.position.set(car.x + 9, 22, midpointZ + 22);
    game.camera.lookAt(car.x, 0, midpointZ);
    game.camera.fov = 66; game.camera.updateProjectionMatrix();
    const canvas = document.createElement('canvas');
    canvas.width = game.renderer.domElement.width; canvas.height = game.renderer.domElement.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = () => { game.composer.render(); context.drawImage(game.renderer.domElement, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
    mesh.visible = false; const without = pixels();
    mesh.visible = true; const withMarks = pixels();
    let visiblePixels = 0;
    for (let i = 0; i < withMarks.length; i += 4) {
      if (Math.max(Math.abs(withMarks[i] - without[i]), Math.abs(withMarks[i+1] - without[i+1]), Math.abs(withMarks[i+2] - without[i+2])) > 3) visiblePixels++;
    }
    game.carPosition.z -= 5; game.updateWheelContacts();
    game.roadSkidMarks.update(game.elapsed, game.wheelContacts, [0, 0, 0, 0]);
    const worldAnchored = anchored.every((value, i) => value === positions[i]);
    game.carPosition.copy(car); game.updateWheelContacts();
    game.composer.render();
    return { visiblePixels, worldAnchored, geometryStable: mesh.geometry === geometry, contextLost: game.renderer.getContext().isContextLost() };
  }, beforeBrake.position);
  await page.screenshot({ path: 'artifacts/high-speed-braking-skid-marks.png' });
  assert.ok(visual.visiblePixels > 100, 'Rubber ribbons produce visible road pixels');
  assert.ok(visual.worldAnchored && visual.geometryStable, 'Marks stay on the road and reuse their geometry');
  assert.equal(visual.contextLost, false, 'WebGL remains healthy');

  // Exercise the actual Space brake, ordinary low-speed stops and reset continuity.
  const additional = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const baseline = game.roadSkidMarks.diagnostics().emitted;
    game.reset(); game.velocity.set(0, 0, -8); game.pressed.add('s');
    for (let i = 0; i < 90; i++) { game.elapsed += 1 / 60; game.updateDriving(1 / 60); }
    const lowStopMarks = game.roadSkidMarks.diagnostics().emitted - baseline;
    game.reset(); game.velocity.set(0, 0, -30); game.pressed.add(' ');
    for (let i = 0; i < 45; i++) { game.elapsed += 1 / 60; game.updateDriving(1 / 60); }
    const handbrakeMarks = game.roadSkidMarks.diagnostics().emitted - baseline;
    const handbrakeAudio = game.audioDiagnostics().levels.tire;
    game.reset(); game.pressed.add('s');
    for (let i = 0; i < 10; i++) { game.elapsed += 1 / 60; game.updateDriving(1 / 60); }
    return { lowStopMarks, handbrakeMarks, handbrakeAudio, stationaryTireAudio: game.audioDiagnostics().levels.tire };
  });
  assert.equal(additional.lowStopMarks, 0, 'A normal low-speed stop leaves no rubber');
  assert.ok(additional.handbrakeMarks > 20 && additional.handbrakeAudio > .005, 'The Space brake also produces marks and tire sound');
  assert.equal(additional.stationaryTireAudio, 0, 'Reset and standstill clear the tire sound');
  assert.deepEqual(errors, [], 'There are no runtime or shader errors');
  const report = { beforeBrake, braking, stopped, visual, additional, errors };
  await writeFile('artifacts/road-skid-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
