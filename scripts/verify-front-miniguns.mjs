import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts/miniguns', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  assert.equal((await page.goto(process.env.GAME_URL || 'http://localhost:3000/')).status(), 200);
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.waitForTimeout(1400);
  const setup = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, rig = g.carRig.miniguns;
    g.reset(); g.active = false; cancelAnimationFrame(g.animationFrame);
    const visible = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const metal = rig.barrels.map(rotor => rotor.children.filter(o => o.isMesh && !o.material.transparent));
    return { mounts: rig.mounts.length, visible: rig.mounts.every(visible), concealed: rig.mounts.every(mount => !mount.visible), rotorMeshes: metal.map(parts => parts.length),
      rotorTriangles: metal.map(parts => parts.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0)) };
  });
  assert.equal(setup.mounts, 2); assert.equal(setup.visible, false); assert.ok(setup.concealed, 'Idle weapons stay concealed behind the reference bumper');
  assert.ok(setup.rotorMeshes.every(count => count >= 2) && setup.rotorTriangles.every(count => count > 1000), 'Rigid barrel geometry stays inside rotating groups');
  const capture = async name => {
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x: -3.6, y: 1.5, z: -5.1 });
      g.camera.fov = 40; g.camera.updateProjectionMatrix();
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: .48, z: -1.1 }));
      g.renderer.shadowMap.needsUpdate = true; g.composer.render();
    });
    await page.screenshot({ path: `artifacts/miniguns/${name}.png` });
  };
  await capture('idle-front');
  const rates = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, rig = g.carRig.miniguns, velocity = g.velocity.clone().set(0,0,0);
    return [30, 60, 120].map(fps => {
      rig.reset(); let events = 0, deployedOnFirstUpdate = false;
      const resetConcealed = rig.mounts.every(mount => !mount.visible);
      for (let frame = 0; frame < fps * 2; frame++) {
        events += rig.update(1/fps, true, frame/fps, velocity).length;
        if (frame === 0) deployedOnFirstUpdate = rig.mounts.every(mount => mount.visible);
      }
      const running = { fps, events, spin: rig.spin, recoil: [...rig.recoil], casings: rig.casings.length, bounced: rig.casings.some(c => c.bounced),
        resetConcealed, deployedOnFirstUpdate, firingVisible: rig.mounts.every(mount => mount.visible) };
      rig.update(.1, false, 2.1, velocity);
      running.coasting = rig.spin; running.coastingVisible = rig.mounts.every(mount => mount.visible);
      for (let frame = 0; frame < fps; frame++) rig.update(1/fps, false, 2.1+frame/fps, velocity);
      running.stopped = rig.spin; running.settled = [...rig.recoil];
      running.stoppedConcealed = rig.mounts.every(mount => !mount.visible);
      rig.update(.25, true, 3.2, velocity); rig.reset();
      running.resetWhileFiringConcealed = rig.mounts.every(mount => !mount.visible);
      return running;
    });
  });
  assert.ok(Math.max(...rates.map(r => r.events)) - Math.min(...rates.map(r => r.events)) <= 2, 'Shot cadence is independent of render FPS');
  assert.ok(rates.every(r => r.events > 175 && r.events < 185 && r.coasting > 0 && r.stopped === 0 && r.settled.every(v => v < .0001) && r.bounced), 'Motor coasts down, springs settle, and cases bounce');
  assert.ok(rates.every(r => r.resetConcealed && r.deployedOnFirstUpdate && r.firingVisible && r.coastingVisible && r.stoppedConcealed && r.resetWhileFiringConcealed), 'Weapons deploy for firing, remain visible during spin-down, and conceal when stopped or reset at every frame rate');
  const alignment = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, rig = g.carRig.miniguns;
    rig.reset(); g.car.rotation.y = 1.1; g.carRig.body.rotation.set(.12, 0, -.09);
    const shots = rig.update(.1, true, 0, g.velocity);
    const result = shots.map(shot => ({ gun: shot.gun, position: shot.position.toArray(), direction: shot.direction.toArray(),
      distanceFromMount: shot.position.distanceTo(rig.mounts[shot.gun].getWorldPosition(g.forward.clone())) }));
    g.reset(); return result;
  });
  assert.ok(alignment.length > 0 && alignment.every(s => s.distanceFromMount > .38 && s.distanceFromMount < .40 && Math.abs(s.direction[0]) > .8 && Math.abs(s.direction[1]) > .08), 'Compact muzzles and trajectories follow yaw, pitch and roll');
  const ballistics = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, originalWorld = g.collisionWorld;
    const origin = g.carPosition.clone().add({x:0,y:1,z:0});
    const wall = {x:origin.x,z:origin.z-10,hx:2,hz:.025,minY:0,maxY:3};
    g.collisionWorld = {query: () => [wall]};
    const addRound = () => {
      const bullet = g.freeBullets.pop(); bullet.position.copy(origin); bullet.velocity.set(0,0,-820);
      bullet.life=.65; bullet.age=0; bullet.tracer=true; g.bullets.push(bullet);
    };
    addRound();
    g.updateBullets(.1);
    const hit = g.smokeParticles.at(-1)?.position.toArray();
    const caught = g.bullets.length === 0;
    g.resetWeapons(); g.collisionWorld = {query:()=>[]};
    addRound();
    g.updateBullets(.1);
    const drop = origin.y - g.bullets[0].position.y;
    const impactY = g.bullets[0].velocity.y;
    g.collisionWorld = originalWorld; g.resetWeapons();
    return {caught,hit,wallFront:wall.z+wall.hz,drop,verticalVelocity:impactY};
  });
  assert.ok(ballistics.caught && Math.abs(ballistics.hit[2] - ballistics.wallFront) < .001, 'An 820 m/s round hits a 5 cm wall at its first surface');
  assert.ok(Math.abs(ballistics.drop - .04905) < .001 && ballistics.verticalVelocity < -.97, 'Ballistics include gravity in SI units');
  await page.evaluate(() => { const g=document.querySelector('canvas').__drive; g.active=true; g.previousTime=0; g.animationFrame=requestAnimationFrame(g.frameHandler); });
  const measureAudio = async () => page.evaluate(async () => {
    const a = document.querySelector('canvas').__drive.audio, ctx=a.context;
    const output=ctx.createAnalyser(), gun=ctx.createAnalyser(); output.fftSize=gun.fftSize=4096;
    a.output.connect(output); a.gunTone.connect(gun);
    const data=new Float32Array(4096); let outputEnergy=0,gunEnergy=0,peak=0;
    for(let i=0;i<24;i++) {
      output.getFloatTimeDomainData(data); for(const v of data) {outputEnergy+=v*v;peak=Math.max(peak,Math.abs(v));}
      gun.getFloatTimeDomainData(data); for(const v of data) gunEnergy+=v*v;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    a.output.disconnect(output); a.gunTone.disconnect(gun);
    return {outputRms:Math.sqrt(outputEnergy/(24*4096)),gunRms:Math.sqrt(gunEnergy/(24*4096)),peak,state:ctx.state,...a.diagnostics().gun};
  });
  const idleAudio=await measureAudio();
  await page.keyboard.down('f'); await page.waitForTimeout(1400);
  const firingAudio=await measureAudio();
  const firing=await page.evaluate(async()=>{
    const g=document.querySelector('canvas').__drive, seen=[false,false], start=performance.now();
    await new Promise(resolve=>{function check(now){g.carRig.muzzleFlashes.forEach((flash,i)=>seen[i] ||= flash.visible);if(now-start<250)requestAnimationFrame(check);else resolve();}requestAnimationFrame(check);});
    const smoke=g.smokeParticles.at(-1); g.__smokeCheck={particle:smoke,y:smoke.position.y,size:smoke.size};
    return {mountsVisible:g.carRig.miniguns.mounts.every(mount=>mount.visible),flashes:seen,rounds:[...g.carRig.miniguns.shotCounts],smoke:g.smokeParticles.length,bullets:g.bullets.length,cases:g.carRig.miniguns.casings.length};
  });
  assert.ok(firing.mountsVisible && firing.flashes.every(Boolean) && firing.rounds.every(n=>n>50) && firing.smoke>40 && firing.bullets>0 && firing.cases>40, 'Both deployed weapons fire with smoke, tracers and brass');
  assert.ok(firingAudio.state==='running' && firingAudio.gunRms>.07 && firingAudio.outputRms>idleAudio.outputRms*2.5 && firingAudio.peak<.99, 'Gunfire is clearly above the engine, with output compression preventing clipping');
  await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.active=false;cancelAnimationFrame(g.animationFrame);g.carRig.miniguns.flashes.forEach(f=>f.visible=true);});
  await capture('firing-front');
  await page.keyboard.up('f');
  await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.active=true;g.previousTime=0;g.animationFrame=requestAnimationFrame(g.frameHandler);});
  await page.waitForTimeout(400);
  const released=await page.evaluate(()=>{
    const g=document.querySelector('canvas').__drive,check=g.__smokeCheck;
    return {mountsVisible:g.carRig.miniguns.mounts.every(m=>m.visible),flashes:g.carRig.muzzleFlashes.some(f=>f.visible),
      smoke:g.smokeParticles.length,rising:check.particle.position.y>check.y,expanding:check.particle.size>check.size,
      gunActive:g.audioDiagnostics().gun.active,rattle:g.audioDiagnostics().gun.rattle,spin:g.carRig.miniguns.spin};
  });
  assert.ok(released.mountsVisible && !released.flashes && released.smoke>0 && released.rising && released.expanding && !released.gunActive && released.rattle<.001 && released.spin>0, 'Release leaves cooling smoke and visible guns, while fire stops and rotors coast');
  await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.active=false;cancelAnimationFrame(g.animationFrame);});
  await capture('cooling-smoke');
  await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.active=true;g.previousTime=0;g.animationFrame=requestAnimationFrame(g.frameHandler);});
  await page.waitForFunction(()=>{const rig=document.querySelector('canvas').__drive.carRig.miniguns;return rig.spin===0&&rig.mounts.every(mount=>!mount.visible);},null,{timeout:10000});
  const cooled=await page.evaluate(()=>{const rig=document.querySelector('canvas').__drive.carRig.miniguns;return {spin:rig.spin,mountsConcealed:rig.mounts.every(mount=>!mount.visible),flashes:rig.flashes.some(flash=>flash.visible),glow:rig.glow.visible};});
  assert.deepEqual(cooled,{spin:0,mountsConcealed:true,flashes:false,glow:false},'Spin-down restores the clean idle bumper and extinguishes muzzle effects');
  await page.keyboard.down('w');await page.keyboard.down('f');await page.waitForTimeout(1100);
  const driving=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {speed:g.velocity.length(),firing:g.lastTelemetry.firing,smoke:g.smokeParticles.length,contextLost:g.renderer.getContext().isContextLost(),calls:g.renderer.info.render.calls};});
  await page.keyboard.up('w');await page.keyboard.press('r');await page.keyboard.up('f');
  const reset=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {smoke:g.smokeParticles.length,bullets:g.bullets.length,cases:g.carRig.miniguns.casings.length,spin:g.carRig.miniguns.spin,active:g.audioDiagnostics().gun.active,mountsConcealed:g.carRig.miniguns.mounts.every(mount=>!mount.visible)};});
  assert.ok(driving.speed>2&&driving.firing&&!driving.contextLost,'Moving vehicle and weapons work together');
  assert.deepEqual(reset,{smoke:0,bullets:0,cases:0,spin:0,active:false,mountsConcealed:true},'Reset conceals weapons and clears firing effects and sound');
  const pools = await page.evaluate(() => {
    const g=document.querySelector('canvas').__drive; g.active=false; cancelAnimationFrame(g.animationFrame);
    const bulletObjects=new Set(g.freeBullets), smokeObjects=new Set(g.freeSmokeParticles);
    for (let round=0;round<6;round++) {
      for(let frame=0;frame<240;frame++) {g.updateWeapons(1/60,true);g.updateBullets(1/60);g.updateSmoke(1/60);}
      g.resetWeapons();
    }
    let effectLights=false;
    g.car.traverse(o=>{if(o.isPointLight) effectLights=true;});
    return {bullets:g.freeBullets.length,smoke:g.freeSmokeParticles.length,
      bulletObjectsReused:g.freeBullets.every(b=>bulletObjects.has(b)),smokeObjectsReused:g.freeSmokeParticles.every(p=>smokeObjects.has(p)),
      effectLights};
  });
  assert.deepEqual(pools,{bullets:200,smoke:512,bulletObjectsReused:true,smokeObjectsReused:true,effectLights:false},'Long bursts and resets reuse bounded pools without adding a city light');
  const fallback=await page.evaluate(()=>{
    const g=document.querySelector('canvas').__drive;
    g.qualityLevel=0;g.resize();
    const baselineSceneRatio=g.composer.readBuffer.width/innerWidth;
    g.qualityLevel=4;g.reflections.setQuality(4);g.renderer.shadowMap.enabled=false;g.resize();
    g.updateCityVisibility(g.carPosition,4);g.scene.updateMatrixWorld(true);g.renderer.info.reset();g.composer.render();
    return {baselineSceneRatio,pixelRatio:g.renderer.getPixelRatio(),scenePixelRatio:g.composer.readBuffer.width/innerWidth,bloom:g.bloomPass.enabled,reflection:g.reflections.mirror.visible,
      shadows:g.renderer.shadowMap.enabled,contextLost:g.renderer.getContext().isContextLost(),calls:g.renderer.info.render.calls};
  });
  assert.ok(fallback.scenePixelRatio>.3&&fallback.scenePixelRatio<fallback.baselineSceneRatio&&fallback.pixelRatio>=fallback.scenePixelRatio&&fallback.bloom&&fallback.reflection&&fallback.shadows&&!fallback.contextLost&&fallback.calls>50,'Lower effects tiers reduce scene resolution while retaining reconstruction, glow, reflections and shadows');
  await capture('performance-fallback');
  assert.deepEqual(errors,[],'No browser, shader or audio errors');
  const report={setup,rates,alignment,ballistics,audio:{idle:idleAudio,firing:firingAudio},firing,released,cooled,driving,reset,pools,fallback,errors};
  await writeFile('artifacts/miniguns/verification.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally {
  // Release the game's audio and GPU resources before shutting down Chrome.
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (!page.isClosed()) await page.evaluate(() => document.querySelector('canvas')?.__drive?.destroy());
  }
  await browser.close();
}
