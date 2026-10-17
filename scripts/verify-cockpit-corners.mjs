import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseline = process.argv.includes('--baseline');
const limits = { pitch: Number(process.env.COCKPIT_PITCH_LIMIT || .025), roll: Number(process.env.COCKPIT_ROLL_LIMIT || .035) };
const directory = `artifacts/cockpit-corners/${baseline ? 'before' : 'after'}`;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const report = { errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.carRig?.cockpit);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.active = false; g.reset(); g.qualityWarmup = Infinity;
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0); g.updateCamera(0, true);
  });
  report.probes = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive;
    g.scene.updateMatrixWorld(true);
    // These are interior surfaces only: exterior panels and wheels cannot
    // accidentally satisfy an occlusion check by covering an actual cabin hole.
    const opaqueInterior = [];
    g.car.traverse(object => {
      if (!object.isMesh || !object.visible || !object.userData.cockpitDetail) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.every(material => material.visible && !material.transparent && !material.alphaTest)) opaqueInterior.push(object);
    });
    const eye = g.carRig.cockpit.eye.clone().applyMatrix4(g.carRig.body.matrixWorld);
    const raycaster = new THREE.Raycaster();
    const sides = [];
    for (const side of [-1, 1]) {
      const escapes = []; let samples = 0;
      for (let ix = 0; ix <= 10; ix++) for (let iy = 0; iy <= 10; iy++) for (let iz = 0; iz <= 10; iz++) {
        const point = new THREE.Vector3(side * (.70 + ix * .02), .75 + iy * .02, -1.35 + iz * .045);
        // The sample must pass below the lower window seal at the cabin side.
        // Rays above the seal are legitimate views through the windshield.
        const t = (side * .69 - g.carRig.cockpit.eye.x) / (point.x - g.carRig.cockpit.eye.x);
        const yAtSeal = g.carRig.cockpit.eye.y + t * (point.y - g.carRig.cockpit.eye.y);
        const zAtSeal = g.carRig.cockpit.eye.z + t * (point.z - g.carRig.cockpit.eye.z);
        if (yAtSeal > .944 || zAtSeal < -1.0 || zAtSeal > -.86) continue;
        const target = point.clone().applyMatrix4(g.carRig.body.matrixWorld);
        raycaster.set(eye, target.clone().sub(eye).normalize()); raycaster.far = eye.distanceTo(target);
        samples++;
        if (!raycaster.intersectObjects(opaqueInterior, false).length) escapes.push(point.toArray());
      }
      sides.push({ side, samples, escapes });
    }
    return { interiorMeshes: opaqueInterior.length, sides };
  });
  console.log('Interior-only corner probes:', JSON.stringify({ interiorMeshes: report.probes.interiorMeshes,
    sides: report.probes.sides.map(side => ({ side: side.side, samples: side.samples, escapes: side.escapes.length, first: side.escapes.slice(0, 5) })) }));
  await page.addStyleTag({ content: '.drive-hud,.city-minimap,.camera-toggle,.car-inspect-toggle,.car-inspect-help,.city-ident,.screen-grade,.scanlines{display:none!important}' });
  for (const side of [-1, 1]) {
    await page.evaluate(side => {
      const g = document.querySelector('canvas').__drive;
      g.updateCamera(0, true);
      const target = g.carRig.cockpit.eye.clone().set(side * .69, .91, -.92).applyMatrix4(g.carRig.body.matrixWorld);
      g.camera.lookAt(target); g.camera.fov = 40; g.camera.updateProjectionMatrix(); g.composer.render();
    }, side);
    await page.screenshot({ path: `${directory}/${side < 0 ? 'left' : 'right'}-dash-pillar.png` });
  }
  report.wheelEnvelope = await page.evaluate(async ({ baseline, limits }) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, renderer = g.renderer;
    // Opaque interior is rendered black and tires fluorescent magenta, with the
    // exterior hidden. Count tire pixels through the corner region separately
    // from intentional window views, then restore the opaque exterior for the
    // full vehicle check. Mirrors and glass deliberately show the outside.
    const original = [], wheels = new Set(), exterior = [];
    for (const wheel of g.carRig.wheels) wheel.traverse(object => { if (object.isMesh) wheels.add(object); });
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false });
    const marker = new THREE.MeshBasicMaterial({ color: 0xff00ff, fog: false, toneMapped: false });
    g.scene.traverse(object => {
      if (!object.isMesh && !object.isSprite && !object.isPoints) return;
      original.push({ object, visible: object.visible, material: object.material });
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const interior = object.userData.cockpitDetail && materials.every(material => material.visible && !material.transparent && !material.alphaTest);
      const opaqueCar = object.isMesh && object.visible && materials.every(material => material.visible && !material.transparent && !material.alphaTest) && g.car.getObjectById(object.id);
      if (opaqueCar && !wheels.has(object) && !interior) exterior.push(object);
      object.visible = wheels.has(object) || interior;
      if (object.visible) object.material = wheels.has(object) ? marker : black;
    });
    const fog = g.scene.fog, background = g.scene.background;
    g.scene.fog = null; g.scene.background = new THREE.Color(0x000000);
    const target = new THREE.WebGLRenderTarget(800, 450);
    const pixels = new Uint8Array(800 * 450 * 4);
    const samples = []; let diagnostic = null;
    const frontPivots = g.carRig.steering;
    const restY = frontPivots.map(pivot => pivot.position.y);
    // The flat-road suspension limits are separate from terrain inclination.
    // Wheels remain independent of the sprung body; sweep both limits and lock.
    const pitchLimit = baseline ? .2 : limits.pitch, rollLimit = baseline ? .2 : limits.roll;
    for (const pitch of [-pitchLimit, 0, pitchLimit]) for (const roll of [-rollLimit, 0, rollLimit]) for (const steering of [-.82, 0, .82]) {
      g.carRig.body.rotation.set(pitch, 0, roll);
      frontPivots.forEach((pivot, i) => { pivot.rotation.y = steering; pivot.position.y = restY[i] + .025; });
      g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
      const previous = renderer.getRenderTarget(); renderer.setRenderTarget(target); renderer.render(g.scene, g.camera);
      renderer.readRenderTargetPixels(target, 0, 0, 800, 450, pixels); renderer.setRenderTarget(previous);
      let wheelPixels = 0, cabinLeakPixels = 0; const bounds = [800, 450, -1, -1];
      const raycaster = new THREE.Raycaster(), inverseBody = g.carRig.body.matrixWorld.clone().invert();
      const localEye = g.camera.position.clone().applyMatrix4(inverseBody), localRay = new THREE.Vector3();
      for (let y = 0; y < 450; y++) for (let x = 0; x < 800; x++) {
        const i = (y * 800 + x) * 4;
        if (pixels[i] > 180 && pixels[i + 2] > 180 && pixels[i + 1] < 60) {
          wheelPixels++; bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], 449 - y);
          bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], 449 - y);
          raycaster.setFromCamera(new THREE.Vector2((x + .5) / 800 * 2 - 1, (y + .5) / 450 * 2 - 1), g.camera);
          localRay.copy(raycaster.ray.direction).transformDirection(inverseBody);
          const side = Math.sign(localRay.x), distance = (side * .69 - localEye.x) / localRay.x;
          const boundaryY = localEye.y + distance * localRay.y, boundaryZ = localEye.z + distance * localRay.z;
          if (distance > 0 && boundaryY <= .944 && boundaryZ >= -1 && boundaryZ <= -.86) cabinLeakPixels++;
        }
      }
      let completeCarWheelPixels = 0;
      if (wheelPixels) {
        for (const object of exterior) { object.visible = true; object.material = black; }
        renderer.setRenderTarget(target); renderer.render(g.scene, g.camera);
        renderer.readRenderTargetPixels(target, 0, 0, 800, 450, pixels); renderer.setRenderTarget(previous);
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 180 && pixels[i + 2] > 180 && pixels[i + 1] < 60) completeCarWheelPixels++;
        if (completeCarWheelPixels > (diagnostic?.pixels ?? 0)) {
          const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
          const context = canvas.getContext('2d'), frame = context.createImageData(800, 450);
          for (let y = 0; y < 450; y++) frame.data.set(pixels.subarray(y * 800 * 4, (y + 1) * 800 * 4), (449 - y) * 800 * 4);
          context.putImageData(frame, 0, 0);
          diagnostic = { pixels: completeCarWheelPixels, pitch, roll, steering, image: canvas.toDataURL('image/png') };
        }
        for (const object of exterior) object.visible = false;
      }
      samples.push({ pitch, roll, steering, wheelPixelsWithoutExterior: wheelPixels, cabinLeakPixels, completeCarWheelPixels,
        bounds: wheelPixels ? bounds : null });
    }
    frontPivots.forEach((pivot, i) => { pivot.rotation.y = 0; pivot.position.y = restY[i]; });
    g.carRig.body.rotation.set(0, 0, 0);
    for (const { object, visible, material } of original) { object.visible = visible; object.material = material; }
    g.scene.fog = fog; g.scene.background = background;
    target.dispose(); black.dispose(); marker.dispose(); g.updateCamera(0, true); g.composer.render();
    return { samples, diagnostic };
  }, { baseline, limits });
  if (report.wheelEnvelope.diagnostic) {
    const { image, ...pose } = report.wheelEnvelope.diagnostic;
    await writeFile(`${directory}/wheel-mask.png`, Buffer.from(image.split(',')[1], 'base64'));
    report.wheelDiagnostic = pose;
  }
  report.wheelEnvelope = report.wheelEnvelope.samples;
  console.log('Wheel envelope:', JSON.stringify(report.wheelEnvelope));
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  if (!baseline) {
    assert.ok(report.probes.sides.every(side => side.samples > 200 && side.escapes.length === 0), 'Interior trim seals the dash/pillar corner below the window seal');
    assert.ok(report.wheelEnvelope.every(pose => pose.cabinLeakPixels === 0), 'No tire is visible through the dash/pillar closure with exterior panels excluded');
    assert.ok(report.wheelEnvelope.every(pose => pose.completeCarWheelPixels === 0), 'Complete vehicle blocks every tire pixel across pitch, roll and steering limits');
    assert.deepEqual(report.errors, []);
  }
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
