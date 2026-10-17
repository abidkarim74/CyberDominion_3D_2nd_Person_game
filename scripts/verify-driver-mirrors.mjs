import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = 'artifacts/driver-mirrors';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const report = { errors: [], failedResponses: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`${message.text()} (${message.location().url || 'browser'})`); });
  page.on('response', response => {
    if (response.status() >= 400) report.failedResponses.push({ url: response.url(), status: response.status() });
  });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.drivingMirrors?.mirrors.length === 3);
  console.log('Game, side mirrors and panoramic rearview ready');
  await page.evaluate(() => { document.querySelector('canvas').__drive.qualityWarmup = Infinity; });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  const captures = () => page.evaluate(() => document.querySelector('canvas').__drive.drivingMirrors.mirrors.map(mirror => mirror.captures));
  const parkedBefore = await captures();
  await page.waitForFunction(before => document.querySelector('canvas').__drive.drivingMirrors.mirrors.some((mirror, i) => mirror.captures > before[i] + 1), parkedBefore);
  report.parked = { before: parkedBefore, after: await captures() };
  console.log('Parked mirror updates verified', report.parked);
  await page.screenshot({ path: `${directory}/driver-parked.png` });
  report.otherViews = [];
  for (const view of ['chase', 'orbit', 'person']) {
    await page.evaluate(view => document.querySelector('canvas').__drive.setCameraView(view), view);
    const before = await captures();
    await page.waitForTimeout(400);
    const after = await captures();
    report.otherViews.push({ view, before, after });
    assert.deepEqual(after, before, `Mirror captures pause in ${view} view`);
  }
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.setCameraView('driver'); g.reset(); g.active = false;
    cancelAnimationFrame(g.animationFrame);
  });

  report.rendering = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, system = g.drivingMirrors;
    const renderer = g.renderer;
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0);
    g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
    const cabinRays = [];
    const raycaster = new THREE.Raycaster(), opaque = [];
    g.car.traverse(object => {
      if (!object.isMesh || !object.visible) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.every(material => !material.transparent && material.visible)) opaque.push(object);
    });
    for (const [pitch, roll] of [[0, 0], [.04, -.03], [-.04, .03]]) {
      g.carRig.body.rotation.set(pitch, 0, roll); g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
      const eye = g.carRig.cockpit.eye.clone().applyMatrix4(g.carRig.body.matrixWorld);
      let samples = 0; const escapes = [];
      for (let ix = 0; ix <= 10; ix++) for (let iz = 0; iz <= 14; iz++) {
        const local = new THREE.Vector3(-.67 + ix * 1.34 / 10, .20, -.98 + iz * 1.70 / 14);
        const target = local.clone().applyMatrix4(g.carRig.body.matrixWorld), distance = eye.distanceTo(target);
        raycaster.set(eye, target.sub(eye).normalize()); raycaster.far = distance;
        samples++;
        if (!raycaster.intersectObjects(opaque, false).length) escapes.push(local.toArray());
      }
      cabinRays.push({ pitch, roll, samples, escapes });
    }
    g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
    const tick = () => { g.elapsed += .25; system.update(renderer, g.scene, g.camera, g.elapsed, true); };
    const captureAll = () => {
      const quaternion = g.camera.quaternion.clone();
      system.invalidate();
      for (const mirror of system.mirrors) {
        mirror.surface.updateWorldMatrix(true, false);
        g.camera.lookAt(mirror.surface.localToWorld(mirror.center.clone()));
        for (let i = 0; i < system.mirrors.length; i++) tick();
      }
      g.camera.quaternion.copy(quaternion); g.camera.updateMatrixWorld();
    };
    const pixels = mirror => {
      const half = new Uint16Array(mirror.target.width * mirror.target.height * 4);
      renderer.readRenderTargetPixels(mirror.target, 0, 0, mirror.target.width, mirror.target.height, half);
      return Uint8Array.from(half, value => Math.round(Math.min(1, Math.max(0, THREE.DataUtils.fromHalfFloat(value))) * 255));
    };
    const statistics = data => {
      let sum = 0, sumSquares = 0, maximum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const light = (data[i] + data[i + 1] + data[i + 2]) / 3;
        sum += light; sumSquares += light * light; maximum = Math.max(maximum, light);
      }
      const count = data.length / 4, mean = sum / count;
      return { mean, deviation: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)), maximum };
    };
    const centroid = (mirror, data, channel, background) => {
      let weight = 0, x = 0, y = 0;
      for (let row = 0; row < mirror.target.height; row++) for (let column = 0; column < mirror.target.width; column++) {
        const i = (row * mirror.target.width + column) * 4;
        const primary = data[i + channel], other = Math.max(data[i + (channel + 1) % 3], data[i + (channel + 2) % 3]);
        if (primary < 70 || primary < other * 1.8) continue;
        if (background && Math.max(...[0, 1, 2].map(component => Math.abs(data[i + component] - background[i + component]))) < 25) continue;
        const strength = primary - other; weight += strength; x += column * strength; y += row * strength;
      }
      return { pixels: weight / 255, x: weight ? x / weight : null, y: weight ? y / weight : null };
    };
    captureAll();
    const mirrors = [];
    for (const mirror of system.mirrors) {
      const original = pixels(mirror), forward = mirror.camera.getWorldDirection(new THREE.Vector3());
      let interiorContribution = null;
      if (mirror.isRearview) {
        const wasVisible = g.car.visible;
        try {
          g.car.visible = false; captureAll();
          const withoutCabin = pixels(mirror);
          let changed = 0, lowerHalfChanged = 0;
          for (let i = 0; i < original.length; i += 4) {
            if (Math.max(...[0, 1, 2].map(channel => Math.abs(original[i + channel] - withoutCabin[i + channel]))) <= 12) continue;
            changed++;
            if (i / 4 / mirror.target.width < mirror.target.height / 2) lowerHalfChanged++;
          }
          mirror.surface.updateWorldMatrix(true, false);
          interiorContribution = { changed, lowerHalfChanged, fraction: changed / (mirror.target.width * mirror.target.height),
            cameraDistanceFromGlass: mirror.camera.position.distanceTo(mirror.surface.localToWorld(mirror.center.clone())),
            apertureMeshes: system.rearviewOpening.swaps.length };
        } finally { g.car.visible = wasVisible; captureAll(); }
      }
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(mirror.camera.quaternion);
      const material = color => new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
      const red = new THREE.Mesh(new THREE.SphereGeometry(.55, 12, 8), material(0xff0000));
      const green = new THREE.Mesh(red.geometry, material(0x00ff00));
      const center = mirror.camera.position.clone().addScaledVector(forward, 7);
      red.position.copy(center).addScaledVector(right, .95);
      green.position.copy(center).addScaledVector(right, -.95);
      g.scene.add(red, green);
      captureAll();
      const marked = pixels(mirror), initialRed = centroid(mirror, marked, 0, original), initialGreen = centroid(mirror, marked, 1, original);
      red.position.addScaledVector(right, .65); captureAll();
      const moved = pixels(mirror), movedRed = centroid(mirror, moved, 0, original);
      let changed = 0;
      for (let i = 0; i < marked.length; i += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(marked[i + channel] - moved[i + channel]))) > 10) changed++;
      // Compare authored texture U against the surface's screen-horizontal axis.
      // Rear-facing camera images must be horizontally reversed on the mirror.
      mirror.surface.updateWorldMatrix(true, false);
      const position = mirror.surface.geometry.attributes.position, uv = mirror.surface.geometry.attributes.uv;
      const samples = [];
      for (let i = 0; i < position.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mirror.surface.matrixWorld).project(g.camera);
        samples.push([p.x, uv.getX(i)]);
      }
      const meanX = samples.reduce((sum, p) => sum + p[0], 0) / samples.length;
      const meanU = samples.reduce((sum, p) => sum + p[1], 0) / samples.length;
      const screenUCovariance = samples.reduce((sum, p) => sum + (p[0] - meanX) * (p[1] - meanU), 0);
      const driverQuaternion = g.camera.quaternion.clone();
      g.camera.lookAt(mirror.surface.localToWorld(mirror.center.clone())); g.camera.updateMatrixWorld();
      mirrors.push({ name: mirror.surface.name, isRearview: mirror.isRearview, size: [mirror.target.width, mirror.target.height],
        image: statistics(original), interiorContribution, initialRed, initialGreen, movedRed, changed,
        rearwardDot: forward.dot(new THREE.Vector3(0, 0, 1).transformDirection(g.carRig.body.matrixWorld)),
        screenUCovariance, horizontalTextureRepeat: mirror.surface.material.map?.repeat.x ?? 1,
        captures: mirror.captures });
      g.camera.quaternion.copy(driverQuaternion); g.camera.updateMatrixWorld();
      g.scene.remove(red, green); red.geometry.dispose(); red.material.dispose(); green.material.dispose();
    }

    const pose = [];
    const initial = system.mirrors.map(mirror => ({ position: mirror.camera.position.clone(), direction: mirror.camera.getWorldDirection(new THREE.Vector3()) }));
    g.car.rotation.y = .83; g.yaw = .83; g.updateCamera(0, true); captureAll();
    for (const [index, mirror] of system.mirrors.entries()) pose.push({ name: mirror.surface.name,
      yawDirectionError: mirror.camera.getWorldDirection(new THREE.Vector3()).distanceTo(initial[index].direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), .83)) });
    const beforeDoor = system.mirrors.map(mirror => mirror.camera.position.clone());
    g.carRig.driverDoor.rotation.y = -.8; g.updateCamera(0, true); captureAll();
    const door = system.mirrors.map((mirror, index) => ({ name: mirror.surface.name, isRearview: mirror.isRearview,
      cameraMotion: mirror.camera.position.distanceTo(beforeDoor[index]) }));
    g.reset(); g.updateCamera(0, true); captureAll();

    const motion = [];
    for (const mode of ['turning', 'reversing']) {
      g.reset(); g.active = true; g.pressed.clear();
      for (const key of mode === 'turning' ? ['w', 'a'] : ['s']) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      for (let i = 0; i < 240; i++) g.updateDriving(1 / 120);
      g.updateCamera(0, true);
      const before = system.mirrors.map(mirror => mirror.captures); captureAll();
      motion.push({ mode, speed: g.velocity.length(), yaw: g.yaw,
        forwardVelocity: g.velocity.dot(new THREE.Vector3(-Math.sin(g.yaw), 0, -Math.cos(g.yaw))),
        capturesAdvanced: system.mirrors.every((mirror, i) => mirror.captures > before[i]) });
      g.pressed.clear(); g.active = false;
    }
    g.reset(); g.updateCamera(0, true); captureAll();
    const npcMirrors = [];
    for (const npc of g.traffic.cars) npc.rig.car.traverse(object => {
      if (object.isMesh && (object.userData.sideMirror || object.userData.rearviewMirror)) npcMirrors.push({ name: object.name, map: !!object.material.map,
        usesLiveTarget: system.mirrors.some(mirror => object.material.map === mirror.target.texture) });
    });

    // Mirror capture must preserve the renderer state used by the main pipeline.
    const sentinel = new THREE.WebGLRenderTarget(16, 12);
    renderer.setRenderTarget(sentinel); renderer.setViewport(2, 3, 7, 6); renderer.setScissor(1, 2, 5, 4); renderer.setScissorTest(true);
    const state = () => ({ target: renderer.getRenderTarget()?.texture.uuid,
      viewport: renderer.getViewport(new THREE.Vector4()).toArray(), scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
      scissorTest: renderer.getScissorTest(), xr: renderer.xr.enabled, shadowAuto: renderer.shadowMap.autoUpdate,
      shadowNeeds: renderer.shadowMap.needsUpdate, car: g.car.visible, person: g.person.root.visible,
      road: g.reflections.mirror.visible, mirrors: system.mirrors.map(mirror => mirror.surface.visible),
      rearGeometry: system.rearviewOpening.swaps.map(swap => swap.mesh.geometry.uuid) });
    const before = state(); captureAll(); const after = state();
    renderer.setRenderTarget(null); renderer.setScissorTest(false); sentinel.dispose();
    g.resize();
    captureAll(); g.composer.render();
    return { cabinRays, mirrors, pose, door, motion, npcMirrors, state: { before, after }, contextLost: renderer.getContext().isContextLost() };
  });
  console.log('Mirror rendering and cabin rays complete:', JSON.stringify({ rays: report.rendering.cabinRays.map(pose => ({ samples: pose.samples, escapes: pose.escapes.length })), motion: report.rendering.motion }));
  assert.ok(report.rendering.cabinRays.every(pose => pose.escapes.length === 0), 'Opaque cabin blocks every downward ray across both footwells under pitch and roll');
  for (const mirror of report.rendering.mirrors) {
    assert.ok(mirror.image.deviation > 2 && mirror.image.maximum > 20, `${mirror.name} renders a detailed world image`);
    assert.ok(mirror.rearwardDot > .9, `${mirror.name} faces rearward`);
    assert.ok(mirror.initialRed.pixels > 5 && mirror.initialGreen.pixels > 5, `${mirror.name} sees rearward marker objects`);
    assert.ok(mirror.initialRed.x > mirror.initialGreen.x + 5, `${mirror.name} rear camera preserves image-horizontal coordinates`);
    assert.ok(mirror.movedRed.x > mirror.initialRed.x + 2 && mirror.changed > 20, `${mirror.name} updates when the world changes`);
    assert.ok(mirror.screenUCovariance * mirror.horizontalTextureRepeat < 0, `${mirror.name} displays a horizontally reversed reflection`);
  }
  assert.equal(report.rendering.mirrors.filter(mirror => mirror.isRearview).length, 1, 'Exactly one central rearview mirror is active');
  assert.ok(report.rendering.mirrors.some(mirror => mirror.isRearview && mirror.size[0] / mirror.size[1] > 2.4), 'Rearview camera uses a wide panoramic render target');
  const central = report.rendering.mirrors.find(mirror => mirror.isRearview);
  assert.ok(central.interiorContribution.cameraDistanceFromGlass < 1e-5, 'Rearview captures from the mirror glass inside the cabin');
  assert.ok(central.interiorContribution.fraction > .06 && central.interiorContribution.lowerHalfChanged > 100,
    'Actual cabin geometry visibly contributes to the rearview, including the lower headrest and shelf area');
  assert.ok(central.interiorContribution.apertureMeshes > 0, 'Rear window sight cone clears the authored closed engine shell');
  assert.ok(report.rendering.pose.every(pose => pose.yawDirectionError < 1e-5), 'Mirror cameras follow vehicle yaw');
  assert.ok(report.rendering.door.some(door => door.cameraMotion > .1), 'Driver mirror follows its hinged door');
  assert.ok(report.rendering.door.some(door => door.cameraMotion < 1e-5), 'Passenger mirror stays attached to its side');
  assert.ok(report.rendering.door.some(door => door.isRearview && door.cameraMotion < 1e-5), 'Rearview camera stays attached to the chassis when the door opens');
  assert.ok(report.rendering.motion.every(motion => motion.speed > .1 && motion.capturesAdvanced), 'All mirrors update while turning and reversing');
  assert.ok(Math.abs(report.rendering.motion[0].yaw) > .01, 'Steering changes vehicle yaw');
  assert.ok(report.rendering.motion[1].forwardVelocity < -.1, 'Reverse test moves the vehicle rearward');
  assert.ok(report.rendering.npcMirrors.length > 0 && report.rendering.npcMirrors.every(mirror => !mirror.map && !mirror.usesLiveTarget), 'Traffic mirrors use shared static glass');
  assert.deepEqual(report.rendering.state.after, report.rendering.state.before, 'Capture restores renderer and scene visibility state');
  assert.equal(report.rendering.contextLost, false);
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.reset(); g.setCameraView('driver'); g.updateCamera(0, true); g.composer.render(); });
  await page.screenshot({ path: `${directory}/driver-complete.png` });
  for (const side of [-1, 1, 0]) {
    await page.evaluate(side => {
      const g = document.querySelector('canvas').__drive;
      g.setCameraView('driver'); g.reset(); g.updateCamera(0, true);
      const mirror = g.drivingMirrors.mirrors.find(mirror => side === 0 ? mirror.isRearview : mirror.surface.userData.side === side);
      mirror.surface.updateWorldMatrix(true, false); g.camera.lookAt(mirror.surface.localToWorld(mirror.center.clone()));
      g.drivingMirrors.invalidate();
      for (let i = 0; i < 3; i++) { g.elapsed += .3; g.drivingMirrors.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
      g.composer.render();
    }, side);
    await page.screenshot({ path: `${directory}/${side === 0 ? 'rearview' : side < 0 ? 'driver' : 'passenger'}-mirror.png` });
  }
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.setCameraView('driver'); g.updateCamera(0, true);
    const target = g.carRig.cockpit.eye.clone().set(-.32, .30, -.65).applyMatrix4(g.carRig.body.matrixWorld);
    g.camera.lookAt(target); g.composer.render();
  });
  await page.screenshot({ path: `${directory}/sealed-footwell.png` });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.setCameraView('driver'); g.updateCamera(0, true); g.composer.render(); });

  report.resources = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, system = g.drivingMirrors;
    const identities = system.mirrors.map(mirror => [mirror.surface.uuid, mirror.camera.uuid, mirror.target.texture.uuid]);
    const capture = () => {
      const quaternion = g.camera.quaternion.clone(); system.invalidate();
      for (const mirror of system.mirrors) {
        mirror.surface.updateWorldMatrix(true, false); g.camera.lookAt(mirror.surface.localToWorld(mirror.center.clone()));
        for (let i = 0; i < system.mirrors.length; i++) { g.elapsed += .3; system.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
      }
      g.camera.quaternion.copy(quaternion); g.camera.updateMatrixWorld();
    };
    const cycle = () => {
      for (const preset of ['low', 'medium', 'high', 'ultra', 'high']) {
        system.setPreset(preset, 0); capture();
        for (let i = 0; i < 4; i++) g.toggleCameraView();
      }
    };
    cycle(); const before = { ...g.renderer.info.memory };
    cycle(); const after = { ...g.renderer.info.memory };
    return { before, after, identitiesStable: JSON.stringify(identities) === JSON.stringify(system.mirrors.map(mirror => [mirror.surface.uuid, mirror.camera.uuid, mirror.target.texture.uuid])),
      sizes: system.mirrors.map(mirror => [mirror.target.width, mirror.target.height]) };
  });
  assert.deepEqual(report.resources.after, report.resources.before, 'Preset and camera switches keep GPU allocation counts stable');
  assert.equal(report.resources.identitiesStable, true, 'Preset and camera switches reuse the same mirrors, cameras and render targets');
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.updateCamera(0, true); g.composer.render(); });
  await page.screenshot({ path: `${directory}/driver-compact.png` });
  assert.deepEqual(report.errors, [], 'No browser or shader errors');
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ resources: report.resources, errors: report.errors }));
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
