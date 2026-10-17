import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const directory = 'artifacts/driver-hands';
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(await readFile('public/models/person/person-detailed-hands-manifest.json', 'utf8'));
assert.ok(manifest.addedBodyVertices > 3000 && manifest.nailVertices === 490);
assert.ok(manifest.triangles < 60000 && manifest.glbBytes < 7000000, 'Hand detail has a bounded runtime/download cost');
assert.ok(manifest.sourceUnchanged && manifest.bones === 67 && manifest.clips.length === 6);
assert.ok(manifest.skinImages.every(image => image.size[0] === 2048));
const report = { manifest, errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  try {
    await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready);
  } catch (error) {
    report.loadFailure = await page.evaluate(() => {
      const person = document.querySelector('canvas')?.__drive?.person;
      return { telemetry: person?.telemetry, diagnostics: person?.diagnostics };
    });
    throw error;
  }
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to driver view' }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity; g.reset(); g.active = false;
    g.setCameraView('driver'); g.carRig.body.rotation.set(0, 0, 0); g.carRig.body.position.y = 0;
    g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
  });
  report.poses = [];
  for (const [name, angle] of [['center', 0], ['full-left', 1.18], ['full-right', -1.18]]) {
    const pose = await page.evaluate(async ({ angle }) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const g = document.querySelector('canvas').__drive, p = g.person;
      g.carRig.cockpit.steeringWheel.rotation.z = angle;
      p.update(0, g.pressed, g.carPosition, g.yaw, 0, []);
      g.updateCamera(0, true); g.scene.updateMatrixWorld(true);
      let invalidAttributes = 0, invalidSkinnedVertices = 0, nailVertices = 0, invalidNailWeights = 0;
      const vertex = new THREE.Vector3(), handBounds = new THREE.Box3();
      p.root.traverse(object => {
        if (!object.isMesh) return;
        for (const attribute of Object.values(object.geometry.attributes)) {
          if (Array.from(attribute.array).some(value => !Number.isFinite(value))) invalidAttributes++;
        }
        if (!object.isSkinnedMesh) return;
        object.skeleton.update();
        const nail = /natural.fingernails/i.test(object.name), geometry = object.geometry;
        const joint = geometry.getAttribute('skinIndex'), weight = geometry.getAttribute('skinWeight');
        const hand = object.skeleton.bones.map(bone => /Hand/.test(bone.name));
        for (let i = 0; i < geometry.getAttribute('position').count; i++) {
          object.getVertexPosition(i, vertex).applyMatrix4(object.matrixWorld);
          if (!vertex.toArray().every(Number.isFinite)) invalidSkinnedVertices++;
          let handWeight = 0;
          for (let j = 0; j < 4; j++) if (hand[joint.getComponent(i, j)]) handWeight += weight.getComponent(i, j);
          if (handWeight > .5) handBounds.expandByPoint(vertex);
          if (nail) {
            nailVertices++;
            const dominant = object.skeleton.bones[joint.getX(i)]?.name;
            if (Math.abs(weight.getX(i) - 1) > 1e-5 || !/Hand(?:Thumb|Index|Middle|Ring|Pinky)3$/.test(dominant ?? '')) invalidNailWeights++;
          }
        }
      });
      const wristRolls = p.steeringMotion.arms.map(arm => {
        const axis = arm.hand.bone.position.clone().normalize();
        const delta = arm.hand.bone.quaternion.clone().multiply(arm.hand.base.clone().invert());
        const along = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
        const direction = delta.w < 0 ? -1 : 1;
        return { side: arm.side, radians: 2 * Math.atan2(along * direction, delta.w * direction) };
      });
      g.composer.render();
      return { asset: p.diagnostics.asset, grip: p.diagnostics.steering, invalidAttributes, invalidSkinnedVertices,
        nailVertices, invalidNailWeights, wristRolls, handBounds: { min: handBounds.min.toArray(), max: handBounds.max.toArray() },
        contextLost: g.renderer.getContext().isContextLost() };
    }, { angle });
    assert.ok(pose.asset.includes('person-detailed-hands.glb'));
    assert.ok(pose.grip.maximumGripError < .015, `${name}: actual rig palms stay on the steering rim`);
    assert.equal(pose.invalidAttributes + pose.invalidSkinnedVertices + pose.invalidNailWeights, 0);
    assert.equal(pose.nailVertices, 490); assert.equal(pose.contextLost, false);
    if (name === 'center') assert.ok(Math.abs(pose.wristRolls.find(wrist => wrist.side === 'right').radians) < .35,
      'The right wrist retains a relaxed roll instead of collapsing under a quarter-turn twist');
    report.poses.push({ name, angle, ...pose });
    await page.screenshot({ path: `${directory}/${name}.png` });
  }
  report.motion = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, p = g.person;
    const previous = [], result = { maximumForearmStep: 0, maximumGripError: 0 };
    // Sweep both ways after the static poses to catch a forearm roll flip.
    for (let frame = 0; frame <= 160; frame++) {
      g.carRig.cockpit.steeringWheel.rotation.z = Math.sin(frame / 160 * Math.PI * 2) * 1.18;
      p.update(0, g.pressed, g.carPosition, g.yaw, 0, []);
      result.maximumGripError = Math.max(result.maximumGripError, p.diagnostics.steering.maximumGripError);
      p.steeringMotion.arms.forEach((arm, index) => {
        const rotation = arm.lower.bone.getWorldQuaternion(new THREE.Quaternion());
        if (frame) result.maximumForearmStep = Math.max(result.maximumForearmStep, rotation.angleTo(previous[index]));
        previous[index] = rotation;
      });
    }
    return result;
  });
  assert.ok(report.motion.maximumForearmStep < .2 && report.motion.maximumGripError < .015,
    'Both forearms rotate smoothly while the fingers stay on the wheel');
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive;
    g.carRig.cockpit.steeringWheel.rotation.z = 0;
    g.person.update(0, g.pressed, g.carPosition, g.yaw, 0, []);
    g.updateCamera(0, true);
    const target = g.carRig.cockpit.steeringWheel.getWorldPosition(new THREE.Vector3());
    g.camera.lookAt(target); g.camera.fov = 42; g.camera.updateProjectionMatrix(); g.composer.render();
  });
  await page.screenshot({ path: `${directory}/hands-close.png` });
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ triangles: manifest.triangles, bytes: manifest.glbBytes,
    poses: report.poses.map(({ name, grip, nailVertices }) => ({ name, gripError: grip.maximumGripError, nailVertices })), errors: report.errors }, null, 2));
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
