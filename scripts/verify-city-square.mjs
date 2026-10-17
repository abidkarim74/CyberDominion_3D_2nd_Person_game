import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('.game-canvas')?.__drive, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => { const g = document.querySelector('.game-canvas').__drive; g.reset(); g.active = false; });
  await page.waitForTimeout(1200);
  const initial = await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    return { player: g.carPosition.toArray(), cars: g.traffic.cars.map(c => ({ x: c.motion.position.x, z: c.motion.position.z, yaw: c.motion.yaw })),
      centralTowers: g.scene.userData.cyberpunkSkyline.filter(p => Math.abs(p.x) < 57 && Math.abs(p.z) < 57).length,
      paving: [[-22,40],[-8,30],[8,8],[-44,28],[0,30]].map(([x,z]) => ({...g.roadSnow.sample(x,z)})),
      mapSquare: !!document.querySelector('[data-city-square]'), contextLost: g.renderer.getContext().isContextLost() };
  });
  assert.equal(initial.player[0], -22); assert.equal(initial.player[2], 40);
  assert.equal(initial.cars.length, 4);
  assert.ok(initial.cars.every(c => Math.abs(c.x) < 57 && Math.abs(c.z) < 57 && Math.abs(c.yaw) < .001));
  assert.equal(initial.centralTowers, 0);
  assert.ok(initial.paving.every(p => p.coverage === 0 && Math.abs(p.height - .016) < .001), 'Square has continuous cleared contact surface');
  assert.ok(initial.mapSquare, 'Minimap shows the plaza');
  await page.screenshot({ path: 'artifacts/city-square-spawn.png' });
  const simulation = await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    const clearance = [];
    for (const vertical of [true, false]) for (const road of [-22,22]) for (const lane of [-4.4,0,4.4]) {
      const from = vertical ? {x:road+lane,z:80} : {x:80,z:road+lane};
      const to = vertical ? {x:road+lane,z:-80} : {x:-80,z:road+lane};
      const hit = g.collisionWorld.sweep(from,to,vertical ? 0 : Math.PI/2);
      if (hit) clearance.push({vertical,road,lane,hit});
    }
    const driving = [];
    for (const [x,z,yaw] of [[-22,40,0],[22,40,0],[-40,-22,-Math.PI/2],[-40,22,-Math.PI/2]]) {
      g.reset(); g.carPosition.set(x,.022,z); g.yaw = g.vehicleMotion.yaw = yaw; g.pressed.add('w');
      for (let i=0;i<720;i++) g.updateDriving(1/120);
      driving.push({start:[x,z],end:g.carPosition.toArray(),speed:g.velocity.length()});
    }
    g.reset();
    const departed = g.traffic.cars.map(() => false);
    for (let i=0;i<60*120;i++) {
      g.traffic.step(1/120,g.vehicleMotion);
      g.traffic.cars.forEach((c,id) => { if (Math.abs(c.motion.position.x)>57 || Math.abs(c.motion.position.z)>57) departed[id]=true; });
    }
    const trafficAfter = g.traffic.cars.map(c=>({x:c.motion.position.x,z:c.motion.position.z,speed:c.motion.velocity.length()}));
    g.reset(); g.active = false;
    return { clearance, driving, departed, trafficAfter, resetCars:g.traffic.markers.map(m=>({...m})) };
  });
  assert.deepEqual(simulation.clearance, [], 'All twelve street lane approaches remain unobstructed');
  assert.ok(simulation.driving.every(d=>d.speed>10 && Math.max(Math.abs(d.end[0]),Math.abs(d.end[2]))>57), 'Cars can drive out through every approach');
  assert.ok(simulation.departed.every(Boolean), 'Every AI car drives out of the square');
  assert.ok(simulation.resetCars.every((c,i)=>Math.abs(c.x-initial.cars[i].x)<.001 && Math.abs(c.z-initial.cars[i].z)<.001), 'Reset restores the shared launch grid');
  await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.camera.position.set(42,100,53); g.camera.lookAt(0,0,0);
    g.camera.fov = 60; g.camera.updateProjectionMatrix();
    g.updateCityVisibility({x:0,z:0},0,1.5); g.renderer.shadowMap.needsUpdate = true; g.composer.render();
  });
  await page.screenshot({path:'artifacts/city-square-overview.png'});
  await page.evaluate(() => {
    const g = document.querySelector('.game-canvas').__drive;
    g.camera.position.set(-30,7,31);g.camera.lookAt(0,6,0);g.composer.render();
  });
  await page.screenshot({path:'artifacts/city-square-monument.png'});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => { const g=document.querySelector('.game-canvas').__drive;g.reset();g.resize();g.composer.render(); });
  await page.screenshot({path:'artifacts/city-square-mobile.png'});
  assert.deepEqual(errors, [], 'No browser or WebGL errors');
  assert.equal(initial.contextLost, false);
  const report={initial,simulation,errors};
  await writeFile('artifacts/city-square-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); }
