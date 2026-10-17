import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('.game-canvas')?.__drive, null, { timeout: 60000 });
  assert.equal(await page.locator('.city-minimap').count(), 0, 'Map appears when driving starts');
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.locator('[data-car-marker]').waitFor();

  const snapshot = () => page.evaluate(() => {
    const game = document.querySelector('.game-canvas').__drive;
    const marker = document.querySelector('[data-car-marker]');
    const matrix = marker.transform.baseVal.consolidate().matrix;
    return {
      x: game.carPosition.x, z: game.carPosition.z, yaw: game.yaw,
      mapX: matrix.e, mapZ: matrix.f,
      arrowX: -matrix.c, arrowZ: -matrix.d,
      forwardX: game.forward.x, forwardZ: game.forward.z,
    };
  });
  function checkSync(state) {
    assert.ok(Math.abs(state.mapX - state.x - 396) < .0001, 'Map X matches actual world position');
    assert.ok(Math.abs(state.mapZ - state.z - 396) < .0001, 'Map Z matches actual world position');
    assert.ok(Math.abs(state.arrowX - state.forwardX) < .0001, 'Arrow points along the actual car heading on X');
    assert.ok(Math.abs(state.arrowZ - state.forwardZ) < .0001, 'Arrow points along the actual car heading on Z');
  }
  const start = await snapshot();
  checkSync(start);
  await page.screenshot({ path: 'artifacts/city-map-parked.png' });

  await page.keyboard.down('w');
  const frames = await page.evaluate(async () => {
    const game = document.querySelector('.game-canvas').__drive;
    const marker = document.querySelector('[data-car-marker]');
    const frames = [];
    await new Promise(resolve => {
      function sample() {
        const matrix = marker.transform.baseVal.consolidate().matrix;
        frames.push({ x: game.carPosition.x, z: game.carPosition.z, mapX: matrix.e, mapZ: matrix.f });
        if (frames.length < 40) requestAnimationFrame(sample);
        else resolve();
      }
      requestAnimationFrame(sample);
    });
    return frames;
  });
  assert.ok(frames.at(-1).z < frames[0].z - 3, 'Driving moves north through the actual city');
  assert.ok(frames.every(f => Math.abs(f.mapX - f.x - 396) < .0001 && Math.abs(f.mapZ - f.z - 396) < .0001), 'Marker stays synchronized on every sampled animation frame');
  assert.ok(frames.slice(1).every((f, i) => f.mapZ !== frames[i].mapZ), 'Map updates every moving frame, independently of slower speed telemetry');

  await page.keyboard.down('a');
  await page.waitForFunction(() => Math.abs(document.querySelector('.game-canvas').__drive.yaw) > .1);
  await page.keyboard.up('a');
  await page.keyboard.up('w');
  const turned = await snapshot();
  checkSync(turned);
  await page.screenshot({ path: 'artifacts/city-map-driving.png' });

  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  assert.ok(await page.getByRole('region', { name: 'City map', exact: true }).isVisible(), 'Map stays visible in cockpit view');
  checkSync(await snapshot());
  await page.screenshot({ path: 'artifacts/city-map-cockpit.png' });
  await page.keyboard.press('r');
  const reset = await snapshot();
  assert.equal(reset.x, -22);
  assert.equal(reset.z, 40);
  assert.equal(reset.yaw, 0);
  checkSync(reset);
  await page.keyboard.down('s');
  await page.waitForFunction(() => document.querySelector('.game-canvas').__drive.carPosition.z > 43);
  await page.keyboard.up('s');
  const reversed = await snapshot();
  checkSync(reversed);
  assert.ok(reversed.z > reset.z, 'Reverse movement is reflected on the map');
  assert.equal(reversed.yaw, 0, 'Arrow keeps the car heading while reversing');

  await page.keyboard.press('r');
  const corners = [];
  for (const [x, z, yaw] of [[-390, -390, 0], [390, -390, Math.PI / 2], [390, 390, Math.PI], [-390, 390, -Math.PI / 2]]) {
    await page.evaluate(({ x, z, yaw }) => {
      const game = document.querySelector('.game-canvas').__drive;
      game.reset();
      game.carPosition.set(x, .015, z);
      game.car.position.copy(game.carPosition);
      game.yaw = game.vehicleMotion.yaw = yaw;
      game.car.rotation.y = yaw;
    }, { x, z, yaw });
    await page.waitForFunction(() => {
      const game = document.querySelector('.game-canvas').__drive;
      const matrix = document.querySelector('[data-car-marker]').transform.baseVal.consolidate().matrix;
      return Math.abs(matrix.e - game.carPosition.x - 396) < .0001 && Math.abs(matrix.f - game.carPosition.z - 396) < .0001;
    });
    const state = await snapshot();
    checkSync(state);
    const inside = await page.evaluate(() => {
      const box = document.querySelector('.minimap-svg').getBoundingClientRect();
      const marker = document.querySelector('[data-car-marker]').getBoundingClientRect();
      return marker.left >= box.left && marker.top >= box.top && marker.right <= box.right && marker.bottom <= box.bottom;
    });
    assert.ok(inside, 'Car marker remains entirely visible at city corners');
    corners.push(state);
  }
  await page.keyboard.press('r');
  await page.getByRole('button', { name: 'Switch to chase view' }).click();
  const layouts = [];
  for (const [width, height] of [[1440, 900], [375, 812], [320, 640], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const map = document.querySelector('.city-minimap').getBoundingClientRect();
      const hud = document.querySelector('.drive-hud').getBoundingClientRect();
      return { map: { x: map.x, y: map.y, right: map.right, bottom: map.bottom }, hudLeft: hud.left, width: innerWidth, height: innerHeight };
    });
    assert.ok(layout.map.x >= 0 && layout.map.y >= 0 && layout.map.right <= width && layout.map.bottom <= height, 'Map fits the viewport');
    assert.ok(layout.map.right < layout.hudLeft, 'Map does not overlap the speed and boost HUD');
    checkSync(await snapshot());
    await page.screenshot({ path: `artifacts/city-map-${width}x${height}.png` });
    layouts.push(layout);
  }
  assert.deepEqual(errors, [], 'No runtime errors');
  const report = { start, movingFrames: frames.length, turned, reset, reversed, corners, layouts, errors };
  await writeFile('artifacts/city-map-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
