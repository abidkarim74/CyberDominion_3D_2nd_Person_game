import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = 'artifacts/interior-upgrade';
const layoutOnly = process.argv.includes('--layout-only');
await mkdir(directory, { recursive: true });
const report = { errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.carRig?.cockpit?.rearviewMirror &&
    document.querySelector('canvas').__drive.drivingMirrors?.mirrors.length === 3);
  await page.evaluate(() => { document.querySelector('canvas').__drive.qualityWarmup = Infinity; });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.active = false; g.reset(); g.setGraphicsQuality('high');
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true);
    // The occupied cabin now starts dark, then fades in after its welcome delay.
    g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
  });

  if (!layoutOnly) {
  report.cabin = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, cockpit = g.carRig.cockpit;
    const surface = cockpit.rearviewMirror, geometry = surface.geometry;
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox, position = geometry.getAttribute('position');
    const width = bounds.max.x - bounds.min.x, height = bounds.max.y - bounds.min.y;
    // A rounded outline has no square corner vertex and several intermediate
    // samples around each end; a beveled box or rectangular plane cannot pass.
    const corners = [[bounds.min.x, bounds.min.y], [bounds.max.x, bounds.min.y],
      [bounds.min.x, bounds.max.y], [bounds.max.x, bounds.max.y]];
    const cornerDistances = corners.map(([x, y]) => {
      let nearest = Infinity;
      for (let i = 0; i < position.count; i++) nearest = Math.min(nearest,
        Math.hypot((position.getX(i) - x) / width, (position.getY(i) - y) / height));
      return nearest;
    });
    const precision = value => Math.round(value * 1e6);
    const uniqueX = new Set(Array.from({ length: position.count }, (_, i) => precision(position.getX(i)))).size;
    const uniqueY = new Set(Array.from({ length: position.count }, (_, i) => precision(position.getY(i)))).size;
    const materials = new Set(), geometries = new Set(), invalidAttributes = [];
    const ambientLights = [], leds = [];
    g.car.traverse(object => {
      if (object.isLight && (object.isPointLight || object.isSpotLight) &&
        (object.userData.cabinAmbient || object.userData.cockpitDetail || /cabin|footwell/i.test(object.name))) {
        ambientLights.push({ name: object.name, type: object.type, intensity: object.intensity, distance: object.distance,
          color: object.color.getHexString(), position: object.position.toArray(), visible: object.visible });
      }
      if (!object.isMesh) return;
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const interior = object.userData.cockpitDetail || meshMaterials.some(material => material.userData.cockpitDetail);
      if (!interior) return;
      meshMaterials.forEach(material => {
        materials.add(material);
        if ((material.userData.cabinAmbient || object.userData.cabinAmbient || /ambient|neon|light guide|led/i.test(material.name)) &&
          ((material.isMeshBasicMaterial && Math.max(material.color.r, material.color.g, material.color.b) > .2) ||
            (material.emissive && Math.max(material.emissive.r, material.emissive.g, material.emissive.b) > .2))) {
          leds.push({ name: object.name, material: material.name, type: material.type, visible: object.visible,
            positions: object.geometry.getAttribute('position')?.count ?? 0 });
        }
      });
      if (geometries.has(object.geometry)) return;
      geometries.add(object.geometry);
      for (const [name, attribute] of Object.entries(object.geometry.attributes)) {
        if (Array.from(attribute.array).some(value => !Number.isFinite(value))) invalidAttributes.push(`${object.name}: ${name} is not finite`);
        if (attribute.count !== object.geometry.getAttribute('position').count) invalidAttributes.push(`${object.name}: ${name} has mismatched vertex count`);
      }
      const index = object.geometry.index;
      if (index && Array.from(index.array).some(value => value < 0 || value >= object.geometry.getAttribute('position').count)) {
        invalidAttributes.push(`${object.name}: index outside vertex range`);
      }
    });
    return { rearview: { name: surface.name, uuid: surface.uuid,
      attached: !!g.car.getObjectById(surface.id), dynamic: !!surface.userData.dynamic,
      independent: g.drivingMirrors.mirrors.filter(mirror => mirror.surface === surface).length === 1,
      width, height, vertices: position.count, uniqueX, uniqueY, cornerDistances },
      materials: materials.size, geometries: geometries.size, invalidAttributes, ambientLights, leds };
  });
  assert.equal(report.cabin.rearview.attached, true, 'Rearview remains attached after geometry batching');
  assert.equal(report.cabin.rearview.dynamic, true, 'Rearview is excluded from static geometry merging');
  assert.equal(report.cabin.rearview.independent, true, 'Rearview has its own live mirror surface');
  assert.ok(report.cabin.rearview.width / report.cabin.rearview.height > 2.4, 'Rearview has a panoramic mirror proportion');
  assert.ok(report.cabin.rearview.uniqueX >= 8 && report.cabin.rearview.uniqueY >= 8 &&
    report.cabin.rearview.cornerDistances.every(distance => distance > .005), 'Rearview perimeter has smoothly rounded corners');
  assert.deepEqual(report.cabin.invalidAttributes, [], 'Cabin geometry has finite, correctly sized attributes and valid indices');
  assert.ok(report.cabin.ambientLights.length >= 2 && report.cabin.ambientLights.every(light => light.intensity > 0 && light.distance > 0),
    'Cabin has local physical light sources');
  assert.ok(report.cabin.leds.length >= 2, 'Cabin contains visible illuminated light guides');
  console.log('Rounded rearview and detailed cabin geometry verified');

  report.reflections = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, system = g.drivingMirrors, renderer = g.renderer;
    const captureAll = () => {
      const quaternion = g.camera.quaternion.clone();
      system.invalidate();
      for (const mirror of system.mirrors) {
        mirror.surface.updateWorldMatrix(true, false);
        g.camera.lookAt(mirror.surface.localToWorld(mirror.center.clone())); g.camera.updateMatrixWorld();
        for (let i = 0; i < 4; i++) { g.elapsed += .3; system.update(renderer, g.scene, g.camera, g.elapsed, true); }
      }
      g.camera.quaternion.copy(quaternion); g.camera.updateMatrixWorld();
    };
    const pixels = mirror => {
      const data = new Uint16Array(mirror.target.width * mirror.target.height * 4);
      renderer.readRenderTargetPixels(mirror.target, 0, 0, mirror.target.width, mirror.target.height, data);
      return Uint8Array.from(data, value => Math.round(THREE.MathUtils.clamp(THREE.DataUtils.fromHalfFloat(value), 0, 1) * 255));
    };
    const statistics = data => {
      let sum = 0, squares = 0, maximum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const light = (data[i] + data[i + 1] + data[i + 2]) / 3;
        sum += light; squares += light * light; maximum = Math.max(maximum, light);
      }
      const mean = sum / (data.length / 4);
      return { mean, deviation: Math.sqrt(Math.max(0, squares / (data.length / 4) - mean * mean)), maximum };
    };
    captureAll();
    const before = system.mirrors.map(mirror => ({ image: pixels(mirror), captures: mirror.captures,
      position: mirror.camera.position.clone(), direction: mirror.camera.getWorldDirection(new THREE.Vector3()) }));
    g.car.position.x += 7; g.car.position.z += 5; g.car.rotation.y = .47; g.yaw = .47;
    g.updateCamera(0, true); g.scene.updateMatrixWorld(true); captureAll();
    const mirrors = system.mirrors.map((mirror, index) => {
      const image = pixels(mirror), initial = before[index];
      let changed = 0;
      for (let i = 0; i < image.length; i += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(image[i + channel] - initial.image[i + channel]))) > 10) changed++;
      const direction = mirror.camera.getWorldDirection(new THREE.Vector3());
      const yawError = direction.distanceTo(initial.direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), .47));
      return { name: mirror.surface.name, rearview: mirror.surface === g.carRig.cockpit.rearviewMirror,
        mapped: mirror.surface.material.map === mirror.target.texture, image: statistics(initial.image),
        size: [mirror.target.width, mirror.target.height], capturesBefore: initial.captures, capturesAfter: mirror.captures,
        changed, changedFraction: changed / (image.length / 4), cameraMotion: mirror.camera.position.distanceTo(initial.position), yawError,
        rearwardDot: direction.dot(new THREE.Vector3(0, 0, 1).transformDirection(g.carRig.body.matrixWorld)) };
    });
    const identities = system.mirrors.map(mirror => [mirror.surface.uuid, mirror.target.texture.uuid, mirror.camera.uuid]);
    g.reset(); g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true);
    g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
    captureAll();
    g.composer.render();
    return { mirrors, independentTargets: new Set(system.mirrors.map(mirror => mirror.target.texture.uuid)).size,
      independentCameras: new Set(system.mirrors.map(mirror => mirror.camera.uuid)).size, identities,
      contextLost: renderer.getContext().isContextLost() };
  });
  assert.equal(report.reflections.mirrors.length, 3, 'Driver, passenger and center mirrors are active');
  assert.equal(report.reflections.independentTargets, 3, 'Every mirror owns a separate render target');
  assert.equal(report.reflections.independentCameras, 3, 'Every mirror owns a separate rear camera');
  for (const mirror of report.reflections.mirrors) {
    assert.equal(mirror.mapped, true, `${mirror.name} displays its live render target`);
    assert.ok(mirror.image.deviation > 2 && mirror.image.maximum > 20, `${mirror.name} renders a detailed rearward scene`);
    assert.ok(mirror.rearwardDot > .9 && mirror.yawError < 1e-5, `${mirror.name} camera follows vehicle yaw and faces rearward`);
    assert.ok(mirror.capturesAfter > mirror.capturesBefore && mirror.changed > 30 && mirror.cameraMotion > 3,
      `${mirror.name} reflection changes after translating and turning the vehicle`);
  }
  assert.equal(report.reflections.contextLost, false);
  console.log('Three live mirrors verified after translation and steering');

  report.lighting = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, renderer = g.renderer;
    const lights = [];
    g.car.traverse(object => {
      if (object.isLight && (object.isPointLight || object.isSpotLight) &&
        (object.userData.cabinAmbient || object.userData.cockpitDetail || /cabin|footwell/i.test(object.name))) lights.push(object);
    });
    const target = new THREE.WebGLRenderTarget(800, 450);
    const previousTarget = renderer.getRenderTarget();
    const capture = () => {
      const data = new Uint8Array(800 * 450 * 4);
      renderer.setRenderTarget(target); renderer.render(g.scene, g.camera);
      renderer.readRenderTargetPixels(target, 0, 0, 800, 450, data);
      return data;
    };
    const on = capture(), intensities = lights.map(light => light.intensity);
    let off;
    try { lights.forEach(light => { light.intensity = 0; }); off = capture(); }
    finally {
      lights.forEach((light, i) => { light.intensity = intensities[i]; });
      renderer.setRenderTarget(previousTarget); target.dispose();
    }
    let cabinChanged = 0, roadChanged = 0, cabinDelta = 0;
    for (let y = 0; y < 450; y++) for (let x = 0; x < 800; x++) {
      const i = (y * 800 + x) * 4;
      const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(on[i + channel] - off[i + channel])));
      // WebGL readback starts at the bottom: the first 55% is the cabin.
      if (y < 450 * .55) { if (delta > 2) cabinChanged++; cabinDelta += delta; }
      else if (y > 450 * .75 && delta > 2) roadChanged++;
    }
    g.composer.render();
    return { lights: lights.length, cabinChanged, cabinMeanDelta: cabinDelta / (800 * 450 * .55), roadChanged };
  });
  assert.ok(report.lighting.cabinChanged > 100, 'Physical ambient lights illuminate upholstery beyond the emissive LED geometry');
  console.log('Local cabin light contribution verified:', JSON.stringify(report.lighting));

  report.controls = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, cockpit = g.carRig.cockpit;
    const image = () => cockpit.dashboardMap.image.getContext('2d').getImageData(0, 0,
      cockpit.dashboardMap.image.width, cockpit.dashboardMap.image.height).data;
    g.reset(); g.active = true; g.pressed.clear();
    const before = { readout: { ...cockpit.readout }, rotation: cockpit.steeringWheel.rotation.z, pixels: image(), version: cockpit.dashboardMap.version };
    g.pressed.add('w'); g.pressed.add('a');
    for (let i = 0; i < 240; i++) {
      g.updateDriving(1 / 120); cockpit.update(1 / 120, g.lastTelemetry, g.steerInput, true);
    }
    const after = image(); let changed = 0;
    for (let i = 0; i < after.length; i += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(after[i + channel] - before.pixels[i + channel]))) > 10) changed++;
    const result = { speed: g.velocity.length(), yaw: g.yaw, steeringRotation: cockpit.steeringWheel.rotation.z,
      before: before.readout, after: { ...cockpit.readout }, changedInstrumentPixels: changed,
      instrumentUploads: cockpit.dashboardMap.version - before.version };
    g.pressed.clear(); g.active = false; g.reset(); g.updateCamera(0, true); g.composer.render();
    return result;
  });
  assert.ok(report.controls.speed > .1 && Math.abs(report.controls.yaw) > .01 && Math.abs(report.controls.steeringRotation) > .1,
    'Throttle and steering still move the car and animate the wheel');
  assert.ok(report.controls.after.speed > report.controls.before.speed && report.controls.changedInstrumentPixels > 20 && report.controls.instrumentUploads > 0,
    'Analog and digital instruments repaint from actual driving telemetry');
  }

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    // Driving/reset probes restart the welcome timer; captures show full light.
    g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
    g.drivingMirrors.invalidate();
    for (let i = 0; i < 8; i++) { g.elapsed += .3; g.drivingMirrors.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
    g.composer.render();
  });
  await page.screenshot({ path: `${directory}/driver-1600.png` });
  for (const side of layoutOnly ? [] : [-1, 1]) {
    await page.evaluate(side => {
      const g = document.querySelector('canvas').__drive;
      g.updateCamera(0, true);
      g.camera.lookAt(g.carRig.cockpit.eye.clone().set(side * .63, .86, -.52).applyMatrix4(g.carRig.body.matrixWorld));
      g.composer.render();
    }, side);
    await page.screenshot({ path: `${directory}/${side < 0 ? 'driver' : 'passenger'}-detail.png` });
  }
  report.layout = [];
  for (const viewport of [{ width: 1000, height: 700 }, { width: 390, height: 844 }, { width: 360, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => { const g = document.querySelector('canvas').__drive; g.resize(); g.updateCamera(0, true); g.composer.render(); });
    const layout = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const g = document.querySelector('canvas').__drive, surface = g.carRig.cockpit.rearviewMirror;
      const canvas = g.renderer.domElement.getBoundingClientRect();
      surface.updateWorldMatrix(true, false); g.camera.updateMatrixWorld();
      const position = surface.geometry.getAttribute('position'), points = [];
      for (let i = 0; i < position.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(surface.matrixWorld).project(g.camera);
        points.push({ x: canvas.left + (p.x + 1) / 2 * canvas.width, y: canvas.top + (1 - p.y) / 2 * canvas.height });
      }
      const mirror = { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
        top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
      const rect = element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      };
      const controls = [...document.querySelectorAll('.camera-toggle,.graphics-toggle')].map(element =>
        ({ name: element.getAttribute('aria-label') || element.textContent.trim(), rect: rect(element) }));
      return { viewport: { width: innerWidth, height: innerHeight }, mirror, controls,
        interaction: rect(document.querySelector('.vehicle-interaction-button')) };
    });
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const control of layout.controls) {
      assert.equal(overlaps(layout.mirror, control.rect), false, `${control.name} leaves the rearview clear at ${viewport.width}px`);
      assert.equal(overlaps(layout.interaction, control.rect), false, `${control.name} leaves the exit action clear at ${viewport.width}px`);
      assert.ok(control.rect.left >= 0 && control.rect.right <= viewport.width && control.rect.top >= 0 && control.rect.bottom <= viewport.height,
        `${control.name} stays inside the ${viewport.width}px viewport`);
    }
    report.layout.push(layout);
    await page.screenshot({ path: `${directory}/${viewport.width === 1000 ? 'driver-compact' : `driver-${viewport.width}`}.png` });
  }
  assert.deepEqual(report.errors, [], 'No browser, WebGL or shader errors');
  console.log(JSON.stringify({ cabin: report.cabin, reflections: report.reflections, lighting: report.lighting,
    controls: report.controls, layout: report.layout, errors: report.errors }, null, 2));
} finally {
  await writeFile(`${directory}/${layoutOnly ? 'layout-verification' : 'verification'}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
