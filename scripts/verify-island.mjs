import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  ...(process.platform === 'win32'
    ? {
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      }
    : { channel: 'chrome' }),
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(
    () => !!document.querySelector('.game-canvas')?.__drive?.island,
    null,
    { timeout: 60000 },
  );
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive,
      env = g.island;
    const outside = [
      [450, 0],
      [-450, 0],
      [0, 450],
      [0, -450],
      [420, 420],
      [900, 0],
    ];
    return {
      stats: env.stats,
      far: g.camera.far,
      waterTime: env.water.material.uniforms.time.value,
      geometryId: env.water.geometry.uuid,
      geometries: g.renderer.info.memory.geometries,
      outsideSnow: outside.map(([x, z]) => ({ ...g.roadSnow.sample(x, z) })),
      insideSnow: [
        ...[
          [390, 0],
          [-390, 0],
          [0, 390],
          [0, -390],
          [390, 390],
        ],
      ].map(([x, z]) => ({ ...g.roadSnow.sample(x, z) })),
      coastlineOnMap: document.querySelector('.minimap-city').tagName,
      contextLost: g.renderer.getContext().isContextLost(),
    };
  });
  assert.ok(
    state.stats.towers > 200 && state.far > 4000,
    'Tall offshore city is within camera range',
  );
  assert.ok(
    state.outsideSnow.every((s) => s.coverage === 0 && s.height === -4.5),
    'Ocean is not covered by land or snow',
  );
  assert.ok(
    state.insideSnow.every((s) => s.coverage > 0.95),
    'Winter ground stays continuous at playable city edges',
  );
  assert.equal(
    state.coastlineOnMap,
    'path',
    'Live map uses the island shoreline',
  );
  await page.screenshot({ path: 'artifacts/island-city-street.png' });
  const views = [];
  for (const [label, x, z, yaw] of [
    ['north-waterfront', 22, -382, 0],
    ['east-waterfront', 382, 22, -Math.PI / 2],
    ['south-waterfront', 22, 382, Math.PI],
    ['west-waterfront', -382, 22, Math.PI / 2],
  ]) {
    await page.evaluate(
      ({ x, z, yaw }) => {
        const g = document.querySelector('.game-canvas').__drive;
        g.reset();
        g.carPosition.set(x, 0.15, z);
        g.car.position.copy(g.carPosition);
        g.yaw = g.vehicleMotion.yaw = yaw;
        g.car.rotation.y = yaw;
        g.updateCamera(0, true);
      },
      { x, z, yaw },
    );
    await page.waitForTimeout(250);
    await page.screenshot({ path: `artifacts/island-${label}.png` });
    const view = await page.evaluate(() => {
      const g = document.querySelector('.game-canvas').__drive;
      return {
        x: g.carPosition.x,
        z: g.carPosition.z,
        calls: g.renderer.info.render.calls,
        triangles: g.renderer.info.render.triangles,
        contextLost: g.renderer.getContext().isContextLost(),
      };
    });
    views.push({ label, ...view });
  }
  await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    g.reset();
    g.carPosition.set(22, 0.15, -382);
    g.car.position.copy(g.carPosition);
    g.updateCamera(0, true);
  });
  const warmedGeometries = await page.evaluate(
    () =>
      document.querySelector('.game-canvas').__drive.renderer.info.memory
        .geometries,
  );
  const visiblePixels = await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    const c = document.createElement('canvas');
    c.width = g.renderer.domElement.width;
    c.height = g.renderer.domElement.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    function pixels() {
      g.composer.render();
      ctx.drawImage(g.renderer.domElement, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    }
    function difference(a, b) {
      let n = 0;
      for (let i = 0; i < a.length; i += 4)
        if (
          Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          ) > 5
        )
          n++;
      return n;
    }
    const withAll = pixels();
    g.island.water.visible = false;
    const withoutWater = pixels();
    g.island.water.visible = true;
    g.island.skyline.visible = false;
    const withoutSkyline = pixels();
    g.island.skyline.visible = true;
    g.island.water.material.uniforms.time.value += 1.6;
    const nextWave = pixels();
    const result = {
      water: difference(withAll, withoutWater),
      skyline: difference(withAll, withoutSkyline),
      animatedWater: difference(withAll, nextWave),
    };
    g.previousTime = 0;
    g.animationFrame = requestAnimationFrame(g.frameHandler);
    return result;
  });
  assert.ok(
    visiblePixels.water > 10000,
    'Open water is visible from the driving camera',
  );
  assert.ok(
    visiblePixels.skyline > 1000,
    'The distant city renders visible buildings across the water',
  );
  assert.ok(
    visiblePixels.animatedWater > 500,
    'Water waves and reflections visibly animate',
  );
  await page.keyboard.press('c');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/island-waterfront-driver.png' });
  await page.keyboard.press('c');
  await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    g.qualityTimer = -1000;
  });
  const performance = await page.evaluate(async () => {
    const g = document.querySelector('.game-canvas').__drive;
    async function sample(visible) {
      g.island.group.visible = visible;
      await new Promise((r) => setTimeout(r, 300));
      const frames = [];
      let last = performance.now();
      await new Promise((resolve) => {
        function tick(now) {
          frames.push(now - last);
          last = now;
          if (frames.length < 60) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);
      return { medianMs: frames[30], p95Ms: frames[57] };
    }
    const without = await sample(false),
      withEnvironment = await sample(true);
    return { without, withEnvironment, pixelRatio: g.renderer.getPixelRatio() };
  });
  const stable = await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive,
      env = g.island;
    return {
      waterTime: env.water.material.uniforms.time.value,
      geometryId: env.water.geometry.uuid,
      geometries: g.renderer.info.memory.geometries,
      contextLost: g.renderer.getContext().isContextLost(),
    };
  });
  assert.ok(
    stable.waterTime > state.waterTime &&
      stable.geometryId === state.geometryId,
    'Animation reuses its ocean geometry',
  );
  assert.equal(
    stable.geometries,
    warmedGeometries,
    'No geometry allocations during waterfront driving',
  );
  assert.ok(
    performance.withEnvironment.medianMs < performance.without.medianMs + 12,
    'The detailed waterfront stays within a bounded frame cost',
  );
  assert.equal(stable.contextLost, false);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/island-waterfront-mobile.png' });
  // Overview verifies actual land and water layout without adding a camera mode to the game.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.scene.fog = null;
    for (const mesh of g.scene.children)
      if (mesh.userData.cityBounds) mesh.visible = true;
    g.camera.position.set(1050, 740, 1150);
    g.camera.lookAt(0, 70, -150);
    g.camera.fov = 55;
    g.camera.updateProjectionMatrix();
    function renderOverview() {
      g.composer.render();
      g.testOverviewFrame = requestAnimationFrame(renderOverview);
    }
    g.testOverviewFrame = requestAnimationFrame(renderOverview);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/island-overview.png' });
  const report = { state, views, visiblePixels, performance, stable, errors };
  await writeFile(
    'artifacts/island-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No browser or water shader errors');
} finally {
  await browser.close();
}
