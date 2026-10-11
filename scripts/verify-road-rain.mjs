import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY' }).click();
  await page.waitForTimeout(6500);
  await page.screenshot({ path: 'artifacts/road-rain-driving.png' });
  const result = await page.evaluate(async () => {
    const game = document.querySelector('canvas').__drive;
    const mesh = game.scene.getObjectByName('Road rain / expanding water ripples');
    const spray = game.scene.getObjectByName('Road rain / tiny impact splashes');
    const positions = mesh.geometry.attributes.impact.array;
    const streaks = game.rain;
    const fixedPools = [streaks.geometry, mesh.geometry, spray.geometry];
    const capacities = { streaks: streaks.geometry.instanceCount, ripples: mesh.geometry.instanceCount, splashes: spray.geometry.attributes.impact.count };
    let live = 0, invalid = 0;
    for (let i = 0; i < positions.length; i += 4) {
      const [x, z, start] = positions.slice(i, i + 3);
      if (game.elapsed - start > 1.02) continue;
      live++;
      const roadDistance = Math.min(Math.abs(x - (Math.round((x - 22) / 44) * 44 + 22)), Math.abs(z - (Math.round((z - 22) / 44) * 44 + 22)));
      if (roadDistance > 8.65 || game.coveredRoads.some(r => Math.abs(x - r.x) < r.hx && Math.abs(z - r.z) < r.hz)) invalid++;
    }
    const before = Array.from(positions);
    for (const roof of game.coveredRoads) game.roadRain.impact(roof.x, roof.z, game.elapsed);
    game.roadRain.impact(0, 0, game.elapsed); // Building / sidewalk block.
    game.roadRain.impact(440, 22, game.elapsed); // Outside city.
    const rejectsShelteredImpacts = before.every((v, i) => v === positions[i]);
    game.roadRain.update(0, game.elapsed, game.carPosition.clone().addScalar(20), game.yaw, 900);
    const anchoredToRoad = before.every((v, i) => v === positions[i]);
    game.roadRain.update(0, game.elapsed, game.carPosition, game.yaw, 900);
    const head = streaks.geometry.attributes.dropHead;
    const tip = streaks.geometry.attributes.dropTip;
    game.updateRain(0);
    const initialX = head.getX(0), initialZ = head.getZ(0);
    game.car.position.x += .5;
    game.updateRain(0);
    const fallingRainAnchored = Math.abs(head.getX(0) - initialX) < 1e-5 && Math.abs(head.getZ(0) - initialZ) < 1e-5;
    game.car.position.x -= .5;
    game.updateRain(0);
    let shelteredStreaks = 0, visibleStreaks = 0, invalidStreaks = 0;
    for (let i = 0; i < head.count; i++) {
      if (head.getY(i) < 0) { shelteredStreaks++; continue; }
      visibleStreaks++;
      if (game.coveredRoads.some(roof => Math.abs(head.getX(i) - roof.x) < roof.hx && Math.abs(head.getZ(i) - roof.z) < roof.hz && tip.getY(i) < roof.ceiling)) invalidStreaks++;
    }
    const startTime = mesh.material.uniforms.time.value;
    await new Promise(resolve => setTimeout(resolve, 300));
    const animated = mesh.material.uniforms.time.value > startTime;
    game.qualityTimer = -1000; // Compare at the same pixel ratio.
    async function profile(visible) {
      streaks.visible = mesh.visible = spray.visible = visible;
      await new Promise(resolve => setTimeout(resolve, 500));
      const frames = [], draws = [];
      let last = performance.now();
      await new Promise(resolve => {
        function sample(now) {
          frames.push(now - last); draws.push(game.renderer.info.render.calls); last = now;
          if (frames.length < 150) requestAnimationFrame(sample); else resolve();
        }
        requestAnimationFrame(sample);
      });
      frames.sort((a, b) => a - b); draws.sort((a, b) => a - b);
      return { medianMs: frames[75], p95Ms: frames[142], fps: 1000 / frames[75], calls: draws[75] };
    }
    const without = await profile(false);
    const withRain = await profile(true);
    const poolStable = fixedPools[0] === streaks.geometry && fixedPools[1] === mesh.geometry && fixedPools[2] === spray.geometry;
    return { live, invalid, rejectsShelteredImpacts, anchoredToRoad, animated, fallingRainAnchored, shelteredStreaks, visibleStreaks, invalidStreaks, capacities, poolStable, pixelRatio: game.renderer.getPixelRatio(), without, withRain,
      contextLost: game.renderer.getContext().isContextLost() };
  });
  assert.ok(result.live > 80, 'Road receives a continuous shower of impacts');
  assert.equal(result.invalid, 0, 'Impacts stay on exposed road surfaces');
  assert.ok(result.rejectsShelteredImpacts, 'All tunnel roofs, sidewalks and city limits exclude impacts');
  assert.ok(result.anchoredToRoad, 'Existing ripples stay fixed to the road when the car moves');
  assert.ok(result.animated, 'Ripple lifetime advances');
  assert.equal(result.contextLost, false);
  assert.ok(result.fallingRainAnchored, 'Nearby falling rain does not slide sideways with the car');
  assert.equal(result.invalidStreaks, 0, 'Falling rain stays above covered-road ceilings');
  assert.ok(result.visibleStreaks > 800, 'Detailed falling drops render throughout the local volume');
  assert.ok(result.poolStable, 'Rain reuses fixed geometry pools while running');
  assert.deepEqual(result.capacities, {streaks:1050,ripples:768,splashes:2304}, 'Detail keeps the existing particle budget');
  assert.equal(result.withRain.calls - result.without.calls, 3, 'All rain detail adds just three draw calls');
  assert.ok(result.withRain.medianMs <= result.without.medianMs + 5, 'Detailed rain does not materially increase median frame time');
  assert.ok(result.withRain.p95Ms <= result.without.p95Ms + 17, 'Detailed rain stays within the existing frame-time budget');
  // Verify that the falling-drop shader produces visible pixels, not just draw calls.
  result.visibleRainPixels = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame);
    const canvas = document.createElement('canvas');
    canvas.width = game.renderer.domElement.width; canvas.height = game.renderer.domElement.height;
    const context = canvas.getContext('2d', {willReadFrequently:true});
    function pixels() { game.composer.render(); context.drawImage(game.renderer.domElement, 0, 0); return context.getImageData(0,0,canvas.width,canvas.height).data; }
    game.rain.visible = true; const withDrops = pixels();
    game.rain.visible = false; const withoutDrops = pixels();
    game.rain.visible = true;
    let visible = 0;
    for (let i=0;i<withDrops.length;i+=4) if (Math.max(Math.abs(withDrops[i]-withoutDrops[i]),Math.abs(withDrops[i+1]-withoutDrops[i+1]),Math.abs(withDrops[i+2]-withoutDrops[i+2])) > 3) visible++;
    game.composer.render();
    return visible;
  });
  assert.ok(result.visibleRainPixels > 80, 'Tapered falling drops are visible in the gameplay camera');
  await page.screenshot({path:'artifacts/detailed-falling-rain.png'});
  // Inspect the road closely in the same natural frame, without increasing effect density.
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.camera.position.set(-18, 1.7, -14);
    game.camera.lookAt(-18, .05, -27);
    game.composer.render();
  });
  await page.screenshot({ path: 'artifacts/road-rain-detail.png' });
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.scene.getObjectByName('Road rain / expanding water ripples').visible = false;
    game.scene.getObjectByName('Road rain / tiny impact splashes').visible = false;
    game.composer.render();
  });
  await page.screenshot({ path: 'artifacts/road-rain-detail-before.png' });
  result.rainCpuMs = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    const start = performance.now();
    for (let i=0;i<300;i++) { game.updateRain(1/60); game.roadRain.update(1/60,game.elapsed,game.carPosition,game.yaw,900); }
    return (performance.now()-start)/300;
  });
  assert.ok(result.rainCpuMs < .8, 'Rain updates stay below one millisecond');
  result.errors = errors;
  await writeFile('artifacts/road-rain-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, 'No console, shader or runtime errors');
} finally {
  await browser.close();
}
