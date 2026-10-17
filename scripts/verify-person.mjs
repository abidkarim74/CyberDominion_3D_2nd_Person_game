import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = { url: process.env.GAME_URL || 'http://127.0.0.1:3001/', checks: {} };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const snapshot = () => page.evaluate(() => {
  const g = document.querySelector('canvas').__drive, p = g.person;
  let skinnedMeshes = 0, skeletonBones = 0;
  p.root.traverse(object => {
    if (object.isSkinnedMesh) { skinnedMeshes++; skeletonBones = Math.max(skeletonBones, object.skeleton.bones.length); }
  });
  return { ...p.diagnostics, car: g.carPosition.toArray(), carVelocity: g.velocity.toArray(),
    skinnedMeshes, skeletonBones,
    cameraView: g.cameraView, cameraYaw: g.personCameraYaw, doorRotation: g.carRig.driverDoor.rotation.y,
    activeClip: p.activeAction?.getClip().name, telemetry: p.telemetry,
    keys: [...g.pressed], bullets: g.bullets.length, nitro: g.nitroRemaining,
    contextLost: g.renderer.getContext().isContextLost() };
});

// The real frame path retains traffic, parked-car physics, door updates, camera,
// and React telemetry. A bounded clock avoids machine-dependent wait durations.
const advance = (seconds) => page.evaluate(seconds => {
  const g = document.querySelector('canvas').__drive;
  cancelAnimationFrame(g.animationFrame);
  if (!g.previousTime) g.previousTime = performance.now();
  let peakDoor = 0;
  for (let remaining = seconds; remaining > .00001; remaining -= .1) {
    g.frame(g.previousTime + Math.min(.1, remaining) * 1000);
    cancelAnimationFrame(g.animationFrame);
    peakDoor = Math.max(peakDoor, Math.abs(g.carRig.driverDoor.rotation.y));
  }
  return { peakDoor, ...g.person.diagnostics, clip: g.person.activeAction?.getClip().name };
}, seconds);

const press = async key => { await page.keyboard.press(key); };
const bonePose = () => page.evaluate(() => {
  const bones = [];
  document.querySelector('canvas').__drive.person.root.traverse(object => {
    if (object.isBone) bones.push(...object.quaternion.toArray());
  });
  return bones;
});
const render = () => page.evaluate(() => {
  const g = document.querySelector('canvas').__drive;
  g.updateCamera(0, true); g.scene.updateMatrixWorld(true); g.composer.render();
  g.onTelemetry({ ...g.lastTelemetry, person: g.person.telemetry });
});

try {
  await page.goto(report.url);
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 90000 });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    // The test clock advances in large deterministic steps, so it is not a
    // rendering performance sample and must not lower the scene's quality.
    g.qualityWarmup = Infinity;
  });
  await page.waitForFunction(() => {
    const person = document.querySelector('canvas').__drive.person;
    return person.ready || person.telemetry.loadingError;
  }, null, { timeout: 90000 });
  report.asset = await snapshot();
  assert.equal(report.asset.ready, true, report.asset.loadingError || 'Character GLB loads');
  assert.ok(report.asset.height > 1.5 && report.asset.height < 1.55, 'Character fits the low sports-car cabin');
  assert.ok(Math.abs(report.asset.scale - .92 * .92) < 1e-6, 'Character is 8% smaller than the previous version');
  assert.ok(report.asset.meshes >= 1 && report.asset.triangles > 10000, 'Detailed renderable character loads');
  assert.ok(report.asset.skinnedMeshes > 0 && report.asset.skeletonBones >= 20, 'Character contains an articulated skin and skeleton');
  for (const clip of ['Idle', 'Walk', 'Run', 'Seated', 'EnterCar', 'ExitCar'])
    assert.ok(report.asset.animations.some(name => name.toLowerCase().includes(clip.toLowerCase())), `${clip} animation exists`);
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  // Check the ordinary animation loop before taking over the test clock. This
  // catches an idle that moves in simulations but appears frozen during play.
  await page.keyboard.press('e');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.frame(performance.now());
  });
  await page.waitForFunction(() => {
    const g = document.querySelector('canvas').__drive;
    return g.person.mode === 'walking' && g.person.idleMotion.idleTime > .5;
  }, null, { timeout: 30000 });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.personCameraYaw = Math.PI; g.personCameraDistance = 2.8; g.personCameraElevation = .14;
    g.updateCamera(0, true);
  });
  await page.screenshot({ path: 'artifacts/person-upright-idle-in-game.png' });
  const realTimePose = await bonePose();
  await page.waitForFunction(pose => {
    const g = document.querySelector('canvas').__drive;
    const bones = [];
    g.person.root.traverse(object => { if (object.isBone) bones.push(...object.quaternion.toArray()); });
    return Math.max(...bones.map((value, i) => Math.abs(value - pose[i]))) > .10;
  }, realTimePose, { timeout: 30000 });
  await page.screenshot({ path: 'artifacts/person-idle-looking-around.png' });
  report.checks.realTimeIdle = true;
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.reset();
  });
  await advance(.1);
  console.log('Checking actual E-key car exit, animated door, and walking controls');
  await press('e');
  const exiting = await snapshot();
  assert.equal(exiting.mode, 'exiting');
  assert.match(exiting.activeClip, /exit/i);
  const exited = await advance(report.asset.transitionSeconds + .1);
  report.checks.exit = { exiting, exited };
  assert.equal(exited.mode, 'walking');
  assert.ok(exited.peakDoor > .75, 'Door opens during the exit');
  assert.equal(exited.doorOpenAmount, 0, 'Door closes after exiting');
  assert.match(exited.clip, /idle/i);
  assert.equal((await snapshot()).cameraView, 'person');
  await page.waitForFunction(() => !!document.querySelector('.person-hud'));
  assert.equal(await page.locator('.drive-hud').count(), 0);
  assert.equal(await page.locator('.camera-toggle').count(), 0);
  const parked = (await snapshot()).car;
  await render();
  await page.screenshot({ path: 'artifacts/person-walking-desktop.png' });

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.personCameraYaw = Math.PI; g.personCameraDistance = 2.8; g.personCameraElevation = .14;
  });
  await advance(3.7);
  await render();
  await page.screenshot({ path: 'artifacts/person-idle-hands-resting.png' });

  console.log('Checking sustained natural idle motion on the actual rig');
  report.checks.idle = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, p = g.person;
    const find = suffix => {
      let bone;
      p.root.traverse(object => { if (object.isBone && object.name.replace(/[^a-z0-9]/gi, '').toLowerCase() === `mixamorig${suffix}`.toLowerCase()) bone = object; });
      if (!bone) throw new Error(`Missing ${suffix} bone`);
      return bone;
    };
    const tracked = ['Head', 'Spine2', 'LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm'].map(find);
    const feet = ['LeftFoot', 'RightFoot'].map(find);
    const origin = p.position.clone(), facing = p.yaw;
    const quaternions = tracked.map(bone => bone.quaternion.clone().normalize());
    const footPositions = feet.map(bone => bone.position.clone());
    p.root.updateMatrixWorld(true);
    const hands = tracked.slice(2, 4);
    const handPositions = hands.map(bone => bone.getWorldPosition(origin.clone()));
    const handRotations = hands.map(bone => bone.getWorldQuaternion(quaternions[0].clone()).normalize());
    const ranges = tracked.map(() => 0);
    let footPoseChange = 0, handPositionDrift = 0, handRotationDrift = 0;
    for (let frame = 0; frame < 1800; frame++) {
      p.update(1 / 60, new Set(), g.carPosition, g.yaw, 0, []);
      tracked.forEach((bone, i) => { ranges[i] = Math.max(ranges[i], quaternions[i].angleTo(bone.quaternion.clone().normalize())); });
      feet.forEach((bone, i) => { footPoseChange = Math.max(footPoseChange, footPositions[i].distanceTo(bone.position)); });
      p.root.updateMatrixWorld(true);
      hands.forEach((bone, i) => {
        handPositionDrift = Math.max(handPositionDrift, handPositions[i].distanceTo(bone.getWorldPosition(origin.clone())));
        handRotationDrift = Math.max(handRotationDrift, handRotations[i].angleTo(bone.getWorldQuaternion(quaternions[0].clone()).normalize()));
      });
    }
    // Repeated paused frames must preserve the complete pose without accumulating offsets.
    const paused = tracked.map(bone => bone.quaternion.toArray());
    for (let frame = 0; frame < 100; frame++) p.update(0, new Set(), g.carPosition, g.yaw, 0, []);
    const pausedDrift = Math.max(...tracked.flatMap((bone, i) =>
      bone.quaternion.toArray().map((value, j) => Math.abs(value - paused[i][j]))));
    p.root.updateMatrixWorld(true);
    const legs = ['Left', 'Right'].map(side => {
      const hip = find(`${side}UpLeg`).getWorldPosition(origin.clone());
      const knee = find(`${side}Leg`).getWorldPosition(origin.clone());
      const ankle = find(`${side}Foot`).getWorldPosition(origin.clone());
      const thigh = knee.clone().sub(hip).normalize(), shin = ankle.clone().sub(knee).normalize();
      return { kneeBend: thigh.angleTo(shin), thighLean: Math.acos(-thigh.y), shinLean: Math.acos(-shin.y) };
    });
    return { head: ranges[0], chest: ranges[1], leftHand: ranges[2], rightHand: ranges[3],
      leftElbow: ranges[4], rightElbow: ranges[5], legs,
      footPoseChange, handPositionDrift, handRotationDrift, pausedDrift,
      rootDrift: origin.distanceTo(p.position), facingDrift: Math.abs(facing - p.yaw) };
  });
  assert.ok(report.checks.idle.head > .35, 'Idle character makes clear head glances');
  for (const joint of ['chest', 'leftHand', 'rightHand', 'leftElbow', 'rightElbow'])
    assert.ok(report.checks.idle[joint] < 1e-6, `${joint}: standing pose stays relaxed and still`);
  assert.ok(report.checks.idle.handPositionDrift < 1e-6 && report.checks.idle.handRotationDrift < 1e-6,
    'Neither hand moves in world space throughout thirty seconds of standing idle');
  for (const leg of report.checks.idle.legs) {
    assert.ok(leg.kneeBend < .22 && leg.thighLean < .22 && leg.shinLean < .22, 'Idle uses relaxed upright legs instead of the combat crouch');
  }
  assert.ok(report.checks.idle.footPoseChange < .001, 'Idle overlay preserves the captured foot poses');
  assert.ok(report.checks.idle.pausedDrift < .000001, 'Paused idle pose does not drift');
  assert.ok(report.checks.idle.rootDrift < .000001 && report.checks.idle.facingDrift < .000001,
    'Idle glances leave the grounded position and movement direction stable');

  await page.keyboard.down('w');
  report.checks.walk = await advance(1.2);
  assert.match(report.checks.walk.clip, /walk/i);
  assert.ok(report.checks.walk.speed > 1.5 && report.checks.walk.speed < 1.8, 'W walks at human pace');
  const poseA = await bonePose(); await advance(.2); const poseB = await bonePose();
  report.checks.walkBoneMotion = Math.max(...poseA.map((value, index) => Math.abs(value - poseB[index])));
  assert.ok(report.checks.walkBoneMotion > .01, 'The walking animation moves the actual skeleton');
  await page.keyboard.down('Shift');
  report.checks.run = await advance(1.0);
  assert.match(report.checks.run.clip, /run/i);
  assert.ok(report.checks.run.speed > 4 && report.checks.run.speed < 4.5, 'Shift runs faster');
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  await advance(.6);
  await press('p'); await page.keyboard.down('f'); await press('c'); await press('o');
  await advance(.2);
  const footOnly = await snapshot();
  await page.keyboard.up('f');
  assert.deepEqual(footOnly.car, parked, 'Walking and car keys leave the car parked');
  assert.deepEqual(footOnly.carVelocity, [0, 0, 0]);
  assert.equal(footOnly.cameraView, 'person', 'Car camera controls are ignored on foot');
  assert.equal(footOnly.bullets, 0, 'Car weapons stay inactive on foot');
  assert.equal(footOnly.nitro, 0, 'Car nitro stays inactive on foot');
  await press('e');
  assert.equal((await snapshot()).mode, 'walking', 'Distant entry is rejected');
  report.checks.parkedAndDistantEntry = footOnly;

  const yawBefore = footOnly.cameraYaw;
  await page.mouse.move(700, 350); await page.mouse.down();
  await page.mouse.move(820, 400, { steps: 8 }); await page.mouse.up();
  await advance(.1);
  const dragged = await snapshot();
  assert.ok(Math.abs(dragged.cameraYaw - yawBefore) > .4, 'Dragging orbits the walking camera');
  report.checks.cameraDrag = { before: yawBefore, after: dragged.cameraYaw };

  // Put the person at the door only to seed this independent interaction check.
  // Actual E input and the complete frame path perform the transfer.
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, p = g.person;
    const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
    p.position.set(g.carPosition.x - 1.75 * c + .107 * s, 0,
      g.carPosition.z + 1.75 * s + .107 * c);
    p.velocity.set(0, 0, 0);
  });
  await advance(.1);
  assert.equal((await snapshot()).telemetry.canInteract, true);
  await page.getByRole('button', { name: /Get in car/ }).click();
  assert.equal((await snapshot()).mode, 'entering');
  const entered = await advance(report.asset.transitionSeconds + .1);
  assert.equal(entered.mode, 'driving');
  assert.match(entered.clip, /seat/i);
  assert.ok(entered.peakDoor > .75, 'Door opens during entry');
  assert.equal((await snapshot()).cameraView, 'chase');
  report.checks.entry = entered;

  await page.evaluate(() => document.querySelector('canvas').__drive.velocity.set(0, 0, -8));
  await press('e');
  assert.equal((await snapshot()).mode, 'driving', 'Exiting a moving vehicle is rejected');
  await page.keyboard.press('r');
  const reset = await snapshot();
  assert.equal(reset.mode, 'driving');
  assert.deepEqual(reset.carVelocity, [0, 0, 0]);
  assert.equal(reset.doorOpenAmount, 0);
  report.checks.movingExitAndReset = reset;

  console.log('Checking diagonal walking speed and collision against actual city geometry');
  report.checks.controller = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, p = g.person;
    const car = g.carPosition.clone().set(-22, .015, -100);
    const simulate = keys => {
      p.mode = 'walking'; p.transition = undefined; p.cameraYaw = 0;
      p.position.set(-22, p.getGroundHeight(-22, -60), -60); p.velocity.set(0, 0, 0);
      const origin = p.position.clone();
      for (let i = 0; i < 120; i++) p.update(1 / 60, new Set(keys), car, 0, 0, []);
      return { distance: Math.hypot(p.position.x - origin.x, p.position.z - origin.z), speed: p.telemetry.speed,
        position: p.position.toArray() };
    };
    const straight = simulate(['w']), diagonal = simulate(['w', 'd']);
    const solid = g.colliders.find(c => c.hx > 3 && c.hz > 3 && c.hx < 25 && c.hz < 25 &&
      Math.abs(c.x) < 150 && Math.abs(c.z) < 150 && (c.minY ?? 0) < 1 && (c.maxY ?? 5) > 2);
    if (!solid) throw new Error('No suitable real city wall for collision check');
    p.position.set(solid.x, p.getGroundHeight(solid.x, solid.z + solid.hz + .8), solid.z + solid.hz + .8);
    p.velocity.set(0, 0, 0);
    const wallStart = p.position.toArray();
    for (let i = 0; i < 240; i++) p.update(1 / 60, new Set(['w', 'shift']), car, 0, 0, []);
    const wallEnd = p.position.toArray();
    return { straight, diagonal, wall: { collider: solid, start: wallStart, end: wallEnd, speed: p.telemetry.speed } };
  });
  assert.ok(Math.abs(report.checks.controller.diagonal.distance - report.checks.controller.straight.distance) < .03,
    'Diagonal walking is normalized');
  const wall = report.checks.controller.wall;
  assert.ok(wall.end[2] >= wall.collider.z + wall.collider.hz + .295, 'A running person stops outside the city wall');
  assert.ok(wall.speed < .1, 'Blocked person settles to idle');

  await press('r'); await advance(.1); await press('e'); await advance(report.asset.transitionSeconds + .1);
  await render();
  await page.setViewportSize({ width: 390, height: 844 }); await advance(.1); await render();
  await page.screenshot({ path: 'artifacts/person-walking-mobile.png' });
  report.checks.mobile = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
    return { viewport: { width: innerWidth, height: innerHeight }, prompt: rect('.person-interaction'),
      hud: rect('.person-hud'), map: rect('.city-minimap') };
  });
  for (const [name, rect] of Object.entries(report.checks.mobile)) {
    if (name === 'viewport') continue;
    assert.ok(rect.x >= 0 && rect.right <= 390 && rect.y >= 0 && rect.bottom <= 844, `${name} fits mobile viewport`);
  }
  assert.ok(report.checks.mobile.prompt.bottom < report.checks.mobile.hud.y,
    'Mobile interaction prompt clears walking controls');
  assert.ok(report.checks.mobile.map.right < report.checks.mobile.hud.x,
    'Mobile minimap clears walking controls');
  assert.ok(report.checks.mobile.map.right < report.checks.mobile.prompt.x,
    'Mobile contextual hints clear the minimap');
  await page.setViewportSize({ width: 320, height: 640 }); await advance(.1); await render();
  await page.screenshot({ path: 'artifacts/person-walking-mobile-small.png' });
  report.checks.smallMobile = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom }; };
    return { prompt: rect('.person-interaction'), hud: rect('.person-hud'), map: rect('.city-minimap') };
  });
  for (const [name, rect] of Object.entries(report.checks.smallMobile))
    assert.ok(rect.x >= 0 && rect.right <= 320 && rect.y >= 0 && rect.bottom <= 640, `${name} fits a small phone`);
  assert.ok(report.checks.smallMobile.map.right < report.checks.smallMobile.hud.x, 'Small phone HUD clears minimap');
  assert.ok(report.checks.smallMobile.map.right < report.checks.smallMobile.prompt.x, 'Small phone contextual hints clear minimap');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.personCameraYaw = Math.PI; g.personCameraDistance = 3.2; g.personCameraElevation = .2;
  });
  await advance(.3); await render();
  await page.screenshot({ path: 'artifacts/person-detail-in-game.png' });
  assert.equal((await snapshot()).contextLost, false);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  report.runtimeErrors = errors;
  report.passed = true;
  console.log('Person behavior and responsive UI checks passed');
} catch (error) {
  report.passed = false;
  report.failure = error.stack || error.message;
  report.runtimeErrors = errors;
  await page.screenshot({ path: 'artifacts/person-verification-failure.png' }).catch(() => {});
  throw error;
} finally {
  await writeFile('artifacts/person-verification.json', JSON.stringify(report, null, 2));
  await browser.close();
}
