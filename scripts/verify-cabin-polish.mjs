import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = 'artifacts/cabin-polish';
const visualOnly = process.argv.includes('--visual-only');
await mkdir(directory, { recursive: true });
const report = { errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  if (!visualOnly) report.runtime = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, cockpit = g.carRig.cockpit, ambience = cockpit.ambience;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity; g.reset(); g.active = true;
    const render = g.composer.render, mirrors = g.drivingMirrors.update, traffic = g.traffic.step;
    // Exercise the actual frame/entry pipeline deterministically; render only the final state.
    g.composer.render = () => {}; g.drivingMirrors.update = () => {}; g.traffic.step = () => 0;
    let time = 1000; g.previousTime = time;
    const step = (count = 1) => { for (let i = 0; i < count; i++) { time += 1000 / 60; g.frame(time); cancelAnimationFrame(g.animationFrame); } };
    const levels = [], sample = name => levels.push({ name, level: ambience.level, elapsed: ambience.elapsed,
      mode: g.person.mode, lights: ambience.lights.map(light => light.intensity),
      guides: ambience.ledMeshes.filter(mesh => !mesh.material.transparent).map(mesh => mesh.material.color.r) });
    try {
      step(); sample('entry'); step(59); sample('before-delay'); step(1); sample('at-delay');
      step(15); sample('fade-quarter'); step(15); sample('fade-half'); step(30); sample('fully-on');
      const exitAccepted = g.interactVehicle(); step(24); sample('exit-faded');
      for (let i = 0; i < 600 && g.person.mode !== 'walking'; i++) step();
      const walking = g.person.mode;
      const entryAccepted = g.interactVehicle();
      for (let i = 0; i < 600 && g.person.mode !== 'driving'; i++) step();
      sample('reseated'); step(60); sample('reentry-delay'); step(30); sample('reentry-half'); step(30); sample('reentry-on');
      g.pressed.add('a'); const turning = [];
      for (let i = 0; i < 24; i++) { step(); turning.push({ angle: cockpit.steering.angle, velocity: cockpit.steering.velocity }); }
      g.pressed.delete('a'); g.pressed.add('d'); const reversing = [];
      for (let i = 0; i < 48; i++) { step(); reversing.push({ angle: cockpit.steering.angle, velocity: cockpit.steering.velocity }); }
      g.pressed.clear(); step(90);
      const steering = { turning, reversing, centered: cockpit.steering.angle, grip: g.person.diagnostics.steering };
      g.updateCamera(0, true);
      return { levels, exitAccepted, walking, entryAccepted, steering };
    } finally {
      g.composer.render = render; g.drivingMirrors.update = mirrors; g.traffic.step = traffic;
      cancelAnimationFrame(g.animationFrame); g.active = false;
    }
  });
  if (visualOnly) await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity; g.reset(); g.active = false;
    g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
    g.person.update(0, g.pressed, g.carPosition, g.yaw, 0, []);
  });
  console.log(visualOnly ? 'Visual geometry verification' : 'Actual entry/exit light sequence and steering sampled');
  report.visual = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, cockpit = g.carRig.cockpit;
    g.setCameraView('driver'); g.carRig.body.rotation.set(0, 0, 0); g.carRig.body.position.y = 0;
    g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
    const cabin = cockpit.rearviewMirror.parent.parent, path = cockpit.ambience.paths.passengerFascia;
    const opaque = [], raycaster = new THREE.Raycaster();
    g.car.traverse(object => {
      if (!object.isMesh || !object.visible || object.material.transparent || !object.material.visible) return;
      let parent = object.parent; while (parent && parent.visible) parent = parent.parent;
      if (!parent) opaque.push(object);
    });
    const routing = [];
    for (let sample = 1; sample < 20; sample++) {
      const local = path.curve.getPointAt(sample / 20), target = cabin.localToWorld(local.clone());
      const distance = g.camera.position.distanceTo(target);
      raycaster.set(g.camera.position, target.clone().sub(g.camera.position).normalize()); raycaster.far = distance + .006;
      const hit = raycaster.intersectObjects(opaque, false)[0];
      routing.push({ sample, local: local.toArray(), visible: !!hit?.object.userData.cabinAmbient,
        hit: hit?.object.material.name, gap: hit ? distance - hit.distance : null });
    }
    const system = g.drivingMirrors, mirror = system.mirrors.find(item => item.isRearview);
    const capture = () => {
      const before = mirror.captures; system.invalidate();
      for (let i = 0; i < 8 && mirror.captures === before; i++) { g.elapsed += .3; system.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
      const half = new Uint16Array(mirror.target.width * mirror.target.height * 4);
      g.renderer.readRenderTargetPixels(mirror.target, 0, 0, mirror.target.width, mirror.target.height, half);
      return Uint8Array.from(half, value => Math.round(Math.min(1, Math.max(0, THREE.DataUtils.fromHalfFloat(value))) * 255));
    };
    const withCabin = capture();
    let withoutCabin;
    const wasVisible = g.car.visible;
    try { g.car.visible = false; withoutCabin = capture(); } finally { g.car.visible = wasVisible; }
    let changed = 0, total = 0, maximum = 0;
    for (let i = 0; i < withCabin.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(withCabin[i + channel] - withoutCabin[i + channel]))) > 5) changed++;
      total += withCabin[i] + withCabin[i + 1] + withCabin[i + 2]; maximum = Math.max(maximum, withCabin[i], withCabin[i + 1], withCabin[i + 2]);
    }
    capture();
    const cameraLocal = mirror.camera.position.clone().applyMatrix4(g.carRig.body.matrixWorld.clone().invert()).toArray();
    const image = document.createElement('canvas'); image.width = mirror.target.width; image.height = mirror.target.height;
    const context = image.getContext('2d'), frame = context.createImageData(image.width, image.height), stride = image.width * 4;
    for (let y = 0; y < image.height; y++) frame.data.set(withCabin.subarray(y * stride, (y + 1) * stride), (image.height - 1 - y) * stride);
    context.putImageData(frame, 0, 0);
    let invalidAttributes = 0;
    g.car.traverse(object => { if (object.isMesh) for (const attribute of Object.values(object.geometry.attributes)) if (Array.from(attribute.array).some(value => !Number.isFinite(value))) invalidAttributes++; });
    g.composer.render();
    return { routing, mirror: { cameraLocal, cabinPixels: changed, pixels: mirror.target.width * mirror.target.height,
      mean: total / (withCabin.length / 4 * 3), maximum, image: image.toDataURL('image/png') },
      invalidAttributes, contextLost: g.renderer.getContext().isContextLost() };
  });
  await writeFile(`${directory}/rearview.png`, Buffer.from(report.visual.mirror.image.split(',')[1], 'base64'));
  delete report.visual.mirror.image;
  await page.screenshot({ path: `${directory}/driver.png` });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.camera.lookAt(g.carRig.cockpit.eye.clone().set(.40, .84, -.72).applyMatrix4(g.carRig.body.matrixWorld));
    g.camera.fov = 55; g.camera.updateProjectionMatrix(); g.composer.render();
  });
  await page.screenshot({ path: `${directory}/fascia-detail.png` });
  if (!visualOnly) {
  const byName = Object.fromEntries(report.runtime.levels.map(sample => [sample.name, sample]));
  for (const name of ['entry', 'before-delay', 'at-delay', 'exit-faded', 'reseated', 'reentry-delay']) assert.ok(byName[name].level < 1e-8, `${name}: ambient lights remain off`);
  assert.ok(byName['fade-quarter'].level > .10 && byName['fade-quarter'].level < .22);
  assert.ok(Math.abs(byName['fade-half'].level - .5) < .04 && Math.abs(byName['reentry-half'].level - .5) < .04);
  for (const name of ['fully-on', 'reentry-on']) assert.ok(byName[name].level > .999 && byName[name].guides.every(value => value > .999));
  assert.ok(report.runtime.exitAccepted && report.runtime.entryAccepted && report.runtime.walking === 'walking', 'Actual door entry and exit complete');
  const steering = report.runtime.steering;
  assert.ok(steering.turning[0].angle > 0 && steering.turning[0].angle < .04, 'Steering starts gently');
  const angles = [0, ...steering.turning.map(sample => sample.angle), ...steering.reversing.map(sample => sample.angle)];
  assert.ok(angles.every((value, index) => !index || Math.abs(value - angles[index - 1]) < .10), 'Steering and reversals have bounded frame motion');
  assert.ok(Math.abs(steering.centered) < .001 && steering.grip.maximumGripError < .015, 'Wheel returns to center and hands remain attached');
  }
  assert.ok(report.visual.routing.every(sample => sample.local[0] > .25), 'Passenger guide stays outside the console shoulder');
  assert.ok(report.visual.routing.every(sample => sample.visible), 'Passenger neon stays visible across its entire fitted channel');
  assert.ok(report.visual.mirror.cameraLocal[2] < 0 && report.visual.mirror.cabinPixels > report.visual.mirror.pixels * .08, 'Rearview shows actual cabin from the mirror mount');
  assert.ok(report.visual.mirror.maximum > 70 && report.visual.mirror.mean > 3, 'Rear-window view remains illuminated');
  assert.equal(report.visual.invalidAttributes, 0); assert.equal(report.visual.contextLost, false);
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ timingSamples: report.runtime?.levels, steeringFirstFrame: report.runtime?.steering.turning[0],
    clearNeonSamples: report.visual.routing.filter(sample => sample.visible).length,
    totalNeonSamples: report.visual.routing.length, mirror: report.visual.mirror, errors: report.errors }, null, 2));
} finally {
  await writeFile(`${directory}/${visualOnly ? 'visual-verification' : 'verification'}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
