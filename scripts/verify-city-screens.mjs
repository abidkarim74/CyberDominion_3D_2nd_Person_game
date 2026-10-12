import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.scene.userData.cityScreenClock?.value > 0, null, { timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.reset(); game.active = false; game.qualityWarmup = 1e9;
    game.updateCamera(0, true);
  });

  const parked = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    return { clock: game.scene.userData.cityScreenClock.value, position: game.carPosition.toArray() };
  });
  await page.waitForTimeout(700);
  const parkedAfter = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    return { clock: game.scene.userData.cityScreenClock.value, position: game.carPosition.toArray() };
  });
  assert.ok(parkedAfter.clock > parked.clock + .1, 'Screen broadcasts continue while the car is parked');
  assert.deepEqual(parkedAfter.position, parked.position, 'Broadcast animation does not move the parked car');
  await page.locator('canvas').screenshot({ path: 'artifacts/city-screens-street.png' });

  // Freeze weather, traffic, camera and reflection captures. Subsequent images differ
  // only when the shared screen clock changes, making the animation check visible.
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame);
    game.active = false;
  });

  const scene = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const materials = new Map();
    const candidates = {};
    const classify = material => material.userData.cityScreenKind ||
      /City screen\s*\/\s*(tower|district|marquee)/i.exec(material.name)?.[1]?.toLowerCase();
    game.scene.updateMatrixWorld(true);
    game.scene.traverse(object => {
      if (!object.isMesh) return;
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) {
        const kind = classify(material);
        if (!kind) continue;
        const record = materials.get(material.uuid) || {
          kind, name: material.name, uuid: material.uuid, meshes: 0, visibleMeshes: 0,
          batchedMeshes: 0, textured: !!material.map, opaque: !material.transparent,
          noCastShadow: !!material.userData.noCastShadow,
          programKey: material.customProgramCacheKey(),
        };
        record.meshes++;
        if (object.visible) record.visibleMeshes++;
        if (object.isBatchedMesh || object.userData.cityBounds) record.batchedMeshes++;
        materials.set(material.uuid, record);
        if (list.length !== 1) continue;
        const positions = object.geometry.getAttribute('position');
        const normals = object.geometry.getAttribute('normal');
        if (!positions || !normals) continue;
        // Screen geometry consists of four indexed corners per physical panel,
        // including after the normal city merge and multi-draw batching passes.
        for (let offset = 0; offset + 3 < positions.count; offset += 4) {
          const points = Array.from({ length: 4 }, (_, i) => game.camera.position.clone()
            .set(positions.getX(offset + i), positions.getY(offset + i), positions.getZ(offset + i))
            .applyMatrix4(object.matrixWorld));
          const center = points[0].clone().add(points[1]).add(points[2]).add(points[3]).multiplyScalar(.25);
          const width = points[0].distanceTo(points[1]);
          const height = points[0].distanceTo(points[2]);
          if (width < .1 || height < .1 || !Number.isFinite(width + height)) continue;
          const normal = game.camera.position.clone().set(normals.getX(offset), normals.getY(offset), normals.getZ(offset))
            .transformDirection(object.matrixWorld);
          const distance = Math.hypot(center.x + 22, center.z + 22);
          // Vending displays verify the small screens without nearby elevated
          // road bridges hiding an upper district panel's center.
          const score = distance + (kind === 'district' ? Math.abs(height - 1.48) * 12 : center.y * .05);
          if (!candidates[kind] || score < candidates[kind].score) candidates[kind] = {
            center: center.toArray(), normal: normal.toArray(), width, height, score,
          };
        }
      }
    });
    const billboards = game.scene.userData.cityBillboards || [];
    return {
      materials: [...materials.values()], candidates,
      billboards: {
        count: billboards.length, majorCount: billboards.filter(panel => panel.major).length,
        lowerMajorCount: billboards.filter(panel => panel.major && panel.bottom <= 15).length,
        substantialMajorCount: billboards.filter(panel => panel.major && panel.width >= 8 && panel.height >= 18).length,
        examples: billboards.filter(panel => panel.major).slice(0, 8),
      },
      contextLost: game.renderer.getContext().isContextLost(),
    };
  });
  for (const kind of ['tower', 'district', 'marquee']) {
    const records = scene.materials.filter(material => material.kind === kind);
    assert.ok(records.length > 0, `${kind} screen material survives architecture batching`);
    assert.ok(records.every(material => material.textured && material.opaque && material.noCastShadow), `${kind} screens keep opaque textured rendering without extra shadow work`);
    assert.ok(records.some(material => material.batchedMeshes > 0), `${kind} screens use the existing city batches`);
    assert.ok(scene.candidates[kind], `${kind} screens retain usable UV-mapped panel geometry`);
  }
  assert.ok(scene.billboards.count >= 100, 'Advertisements cover a substantial set of city buildings');
  assert.ok(scene.billboards.majorCount >= 20, 'The city has a clear set of major advertisement screens');
  assert.ok(scene.billboards.lowerMajorCount >= 20, 'Major advertisements mount low enough to read from the avenues');
  assert.ok(scene.billboards.substantialMajorCount >= 20, 'Major screens have a substantially larger physical scale');
  assert.equal(scene.contextLost, false, 'WebGL remains available');

  const animation = [];
  for (const kind of ['tower', 'district', 'marquee']) {
    await page.evaluate(({ candidate }) => {
      const game = document.querySelector('canvas').__drive;
      const [x, y, z] = candidate.center;
      const [nx, ny, nz] = candidate.normal;
      // The avenue has about 18m of clearance between facade planes. A distant
      // camera for a tall campaign can enter the opposite building and occlude it.
      const distance = Math.min(9, Math.max(candidate.height * 1.15, candidate.width * .9, 3));
      game.camera.position.set(x + nx * distance, y + ny * distance, z + nz * distance);
      game.camera.lookAt(x, y, z);
      game.camera.fov = 54; game.camera.updateProjectionMatrix();
      game.carPosition.set(game.camera.position.x, .015, game.camera.position.z);
      game.updateCityVisibility(game.carPosition);
      game.renderer.shadowMap.needsUpdate = false;
      game.reflections.invalidate();
      game.composer.render(); game.composer.render();
    }, { candidate: scene.candidates[kind] });
    const clockBefore = await page.evaluate(() => document.querySelector('canvas').__drive.scene.userData.cityScreenClock.value);
    await page.locator('canvas').screenshot({ path: `artifacts/city-screens-${kind}-before.png` });
    const candidate = scene.candidates[kind];
    const distance = Math.min(9, Math.max(candidate.height * 1.15, candidate.width * .9, 3));
    const projectionScale = 450 / Math.tan(54 * Math.PI / 360) / distance;
    const clipWidth = Math.floor(Math.min(200, candidate.width * projectionScale * .8));
    const clipHeight = Math.floor(kind === 'marquee' ? Math.min(24, candidate.height * projectionScale * .075) : Math.min(80, candidate.height * projectionScale * .8));
    const screenClip = {
      x: Math.floor(720 - clipWidth / 2),
      y: Math.floor(kind === 'marquee' ? 450 + candidate.height * projectionScale * .36 : 450 - clipHeight / 2),
      width: clipWidth, height: clipHeight,
    };
    const still = await page.screenshot({ clip: screenClip });
    await page.evaluate(() => document.querySelector('canvas').__drive.composer.render());
    const sameClock = await page.screenshot({ clip: screenClip });
    assert.ok(still.equals(sameClock), `${kind} view is stable when the screen clock is frozen`);
    await page.evaluate(() => {
      const game = document.querySelector('canvas').__drive;
      game.scene.userData.cityScreenClock.value += 3.4;
      game.composer.render();
    });
    await page.locator('canvas').screenshot({ path: `artifacts/city-screens-${kind}-after.png` });
    const moving = await page.screenshot({ clip: screenClip });
    const changed = !still.equals(moving);
    assert.ok(changed, `${kind} advertisement visibly animates when broadcast time advances`);
    animation.push({ kind, clockBefore, clockAfter: clockBefore + 3.4, changed, candidate: scene.candidates[kind] });
  }

  const gpu = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const gl = game.renderer.getContext();
    return {
      programCount: game.renderer.info.programs.length,
      failedPrograms: game.renderer.info.programs.filter(program => program.diagnostics?.runnable === false)
        .map(program => program.diagnostics),
      glError: gl.getError(), contextLost: gl.isContextLost(),
      drawCalls: game.renderer.info.render.calls,
    };
  });
  assert.ok(gpu.programCount > 0, 'The browser compiled and rendered WebGL programs');
  assert.deepEqual(gpu.failedPrograms, [], 'No screen shader fails GPU compilation');
  assert.equal(gpu.glError, 0, 'No WebGL errors after screen rendering');
  assert.equal(gpu.contextLost, false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.scene.userData.cityScreenClock?.value > 0, null, { timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ timeout: 60000 });
  await page.evaluate(() => { const game = document.querySelector('canvas').__drive; game.reset(); game.active = false; });
  const mobileBefore = await page.evaluate(() => document.querySelector('canvas').__drive.scene.userData.cityScreenClock.value);
  await page.waitForTimeout(600);
  const mobile = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const gl = game.renderer.getContext();
    return {
      viewport: [innerWidth, innerHeight], contentWidth: document.documentElement.scrollWidth,
      clock: game.scene.userData.cityScreenClock.value, position: game.carPosition.toArray(),
      contextLost: gl.isContextLost(), glError: gl.getError(),
      failedPrograms: game.renderer.info.programs.filter(program => program.diagnostics?.runnable === false).length,
    };
  });
  assert.ok(mobile.clock > mobileBefore + .1, 'Mobile screens continue broadcasting while parked');
  assert.deepEqual(mobile.position, [-22, .015, -22]);
  assert.ok(mobile.contentWidth <= 390, 'Mobile scene has no horizontal page overflow');
  assert.equal(mobile.contextLost, false);
  assert.equal(mobile.glError, 0);
  assert.equal(mobile.failedPrograms, 0, 'Mobile screen shaders render without GPU errors');
  await page.screenshot({ path: 'artifacts/city-screens-mobile.png' });
  const report = { parked, parkedAfter, scene, animation, gpu, mobileBefore, mobile, errors };
  await writeFile('artifacts/city-screens-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No browser or shader errors');
} finally {
  await browser.close();
}
