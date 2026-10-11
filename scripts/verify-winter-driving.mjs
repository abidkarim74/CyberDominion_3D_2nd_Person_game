import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({
  ...(process.platform === 'win32'
    ? {
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      }
    : {}),
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(
    () => !!document.querySelector('canvas')?.__drive?.snowTracks,
  );
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  const result = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    const borderPoints = [
      [388, 0],
      [-388, 0],
      [0, 388],
      [0, -388],
      [388, 388],
      [-388, -388],
      [420, 22],
      [-410, -300],
    ];
    const borders = borderPoints.map(([x, z]) => ({
      ...g.roadSnow.sample(x, z),
    }));
    let blockedRoads = 0;
    for (let road = -374; road <= 374; road += 44)
      for (let along = -388; along <= 388; along += 11) {
        if (
          g.roadSnow.sample(road, along).coverage > 0.001 ||
          g.roadSnow.sample(along, road).coverage > 0.001
        )
          blockedRoads++;
      }
    const edge = [-15.6, -15.2, -14.7, -14.1, -13.7, -13.2].map((x) => ({
      ...g.roadSnow.sample(x, -44),
    }));
    return {
      borders,
      blockedRoads,
      edge,
      softBlend:
        g.snowbanks.material.transparent &&
        g.snowbanks.material.alphaTest < 0.01,
      initialTracks: g.snowTracks.stats.emitted,
    };
  });
  assert.ok(
    result.borders.every((c) => c.coverage > 0.99),
    'All four island edges and playable corners retain snow',
  );
  assert.equal(
    result.blockedRoads,
    0,
    'Road centers remain clear throughout the full playable city and boundary',
  );
  assert.ok(
    result.softBlend &&
      result.edge[1].coverage > 0 &&
      result.edge[1].coverage < 0.2 &&
      result.edge[3].coverage > 0.6,
    'The asphalt-to-snow transition is gradual',
  );
  await page.keyboard.down('w');
  await page.waitForTimeout(1300);
  await page.keyboard.up('w');
  result.dryTrackCount = await page.evaluate(
    () => document.querySelector('canvas').__drive.snowTracks.stats.emitted,
  );
  assert.equal(
    result.dryTrackCount,
    0,
    'Driving on the cleared asphalt emits no snow trails',
  );
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.velocity.set(0, 0, 0);
    g.carPosition.set(-22, 0.015, -43);
    g.car.position.copy(g.carPosition);
    g.yaw = 0;
    g.vehicleMotion.yawRate = 0;
    g.updateWheelContacts();
    g.updateCamera(1);
  });
  await page.screenshot({ path: 'artifacts/snow-soft-edges.png' });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.carPosition.set(387, 0.146, 5);
    g.car.position.copy(g.carPosition);
    g.yaw = 0;
    g.vehicleMotion.yawRate = 0;
    g.snowTracks.resetContinuity();
    g.updateWheelContacts();
    g.updateCamera(1);
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(2700);
  await page.keyboard.down('a');
  await page.waitForTimeout(450);
  await page.keyboard.up('a');
  await page.waitForTimeout(100);
  await page.keyboard.up('w');
  result.snowDrive = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return {
      position: g.carPosition.toArray(),
      height: g.carPosition.y,
      speed: g.velocity.length(),
      grip: g.vehicleMotion.grip,
      tracks: g.snowTracks.stats.emitted,
      powder: g.snowTracks.stats.powderEmitted,
    };
  });
  assert.ok(
    result.snowDrive.tracks > 40 && result.snowDrive.powder > 5,
    'Snow driving leaves continuous tire ruts and displaces powder',
  );
  assert.ok(
    result.snowDrive.height > 0.07 && result.snowDrive.grip < 0.55,
    'The car is supported by snow and has reduced traction',
  );
  await page.evaluate(() =>
    document.querySelector('canvas').__drive.velocity.set(0, 0, 0),
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/snow-border-trails.png' });
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'artifacts/snow-border-driver.png' });
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  result.visibleTrackPixels = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    const canvas = document.createElement('canvas');
    canvas.width = g.renderer.domElement.width;
    canvas.height = g.renderer.domElement.height;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    function pixels() {
      g.composer.render();
      c.drawImage(g.renderer.domElement, 0, 0);
      return c.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    g.snowTracks.mesh.visible = true;
    const withTracks = pixels();
    g.snowTracks.mesh.visible = false;
    const without = pixels();
    g.snowTracks.mesh.visible = true;
    g.composer.render();
    let changed = 0;
    for (let i = 0; i < withTracks.length; i += 4)
      if (
        Math.max(
          Math.abs(withTracks[i] - without[i]),
          Math.abs(withTracks[i + 1] - without[i + 1]),
          Math.abs(withTracks[i + 2] - without[i + 2]),
        ) > 5
      )
        changed++;
    g.animationFrame = requestAnimationFrame(g.frameHandler);
    return changed;
  });
  assert.ok(
    result.visibleTrackPixels > 100,
    'Tire ruts are visible pixels in the actual gameplay camera',
  );
  result.performance = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    g.qualityTimer = -1000;
    const objects = [g.snowTracks.mesh, g.snowTracks.powder];
    async function profile(visible) {
      objects.forEach((o) => (o.visible = visible));
      await new Promise((r) => setTimeout(r, 400));
      const frames = [],
        draws = [];
      let last = performance.now();
      await new Promise((done) => {
        function tick(now) {
          frames.push(now - last);
          draws.push(g.renderer.info.render.calls);
          last = now;
          if (frames.length < 120) requestAnimationFrame(tick);
          else done();
        }
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);
      draws.sort((a, b) => a - b);
      return { medianMs: frames[60], p95Ms: frames[114], calls: draws[60] };
    }
    return {
      withoutTracks: await profile(false),
      withTracks: await profile(true),
      pixelRatio: g.renderer.getPixelRatio(),
    };
  });
  assert.ok(
    result.performance.withTracks.medianMs <=
      result.performance.withoutTracks.medianMs + 5,
    'Trail rendering stays within the frame-time budget',
  );
  assert.ok(
    result.performance.withTracks.p95Ms <=
      result.performance.withoutTracks.p95Ms + 18,
    'Trail rendering does not add large frame spikes',
  );
  result.stress = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    const tracks = g.snowTracks,
      geometry = tracks.mesh.geometry,
      arrays = Object.values(geometry.attributes).map((a) => a.array);
    const contact = g.wheelContacts;
    const begin = performance.now();
    for (let i = 0; i < 6000; i++) {
      const phase = i * 0.04,
        cx = 387.5 + Math.sin(phase) * 0.6,
        cz = Math.cos(phase) * 8,
        yaw = Math.atan2(-Math.cos(phase) * 0.6, Math.sin(phase) * 8);
      const c = Math.cos(yaw),
        s = Math.sin(yaw),
        local = [
          [-0.895, -1.43],
          [-0.895, 1.43],
          [0.895, -1.43],
          [0.895, 1.43],
        ];
      for (let w = 0; w < 4; w++)
        g.roadSnow.sample(
          cx + c * local[w][0] + s * local[w][1],
          cz - s * local[w][0] + c * local[w][1],
          contact[w],
        );
      tracks.update(g.elapsed + i / 60, contact, yaw, 12, 0, 900, 1 / 60);
    }
    const cpuMs = (performance.now() - begin) / 6000;
    let outsideSnow = 0;
    const p = geometry.attributes.position,
      index = geometry.index;
    for (let i = 0; i < geometry.drawRange.count; i += 6) {
      const a = index.getX(i),
        b = index.getX(i + 2),
        c = index.getX(i + 1),
        d = index.getX(i + 5);
      const x = (p.getX(a) + p.getX(b) + p.getX(c) + p.getX(d)) / 4,
        z = (p.getZ(a) + p.getZ(b) + p.getZ(c) + p.getZ(d)) / 4;
      if (g.roadSnow.sample(x, z).coverage < 0.08) outsideSnow++;
    }
    return {
      emitted: tracks.stats.emitted,
      positionCapacity: p.count,
      segments: geometry.drawRange.count / 6,
      fixedBuffers:
        geometry === tracks.mesh.geometry &&
        Object.values(geometry.attributes).every(
          (a, i) => a.array === arrays[i],
        ),
      cpuMs,
      outsideSnow,
      compaction: tracks.compactionAt(contact[0].x, contact[0].z),
    };
  });
  assert.ok(
    result.stress.emitted > 8192,
    'A long drive exercises trail pool recycling',
  );
  assert.equal(result.stress.segments, 8192);
  assert.equal(result.stress.positionCapacity, 32768);
  assert.ok(
    result.stress.fixedBuffers,
    'Long drives reuse the same geometry buffers',
  );
  assert.ok(
    result.stress.cpuMs < 1.5,
    'Snow sampling and trail emission remain lightweight',
  );
  assert.equal(result.stress.outsideSnow, 0, 'Tire trails stay on snow');
  result.errors = errors;
  await writeFile(
    'artifacts/winter-driving-verification.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, 'No browser or shader errors');
} finally {
  await browser.close();
}
