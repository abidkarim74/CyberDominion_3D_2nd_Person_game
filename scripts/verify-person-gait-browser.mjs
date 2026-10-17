import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const directory = 'artifacts/person-gait';
await mkdir(directory, { recursive: true });
const report = { errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person?.ready);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.reset(); g.active = true; g.qualityWarmup = Infinity;
    g.setGraphicsQuality('high');
    g.person.update(1 / 60, new Set(), g.carPosition, g.yaw, 0);
  });
  // Use the ordinary E interaction before advancing only the character's normal
  // update path. City rendering is unnecessary for hundreds of pose samples.
  await page.keyboard.press('e');
  report.exitStarted = await page.evaluate(() => document.querySelector('canvas').__drive.person.mode);
  assert.equal(report.exitStarted, 'exiting', 'E starts the normal driver exit');

  await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive, p = g.person, point = new THREE.Vector3();
    const inverse = new THREE.Matrix4(), bones = new Map(), bootMeshes = [];
    p.root.traverse(object => {
      if (object.isBone) bones.set(object.name.toLowerCase().replace(/[^a-z0-9]/g, ''), object);
      if (!object.isSkinnedMesh) return;
      const indices = object.geometry.getAttribute('skinIndex'), weights = object.geometry.getAttribute('skinWeight'), vertices = [];
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let weight = 0;
        for (let component = 0; component < 4; component++) if (/(left|right)(?:foot|toe)/i.test(object.skeleton.bones[indices.getComponent(vertex, component)].name))
          weight += weights.getComponent(vertex, component);
        if (weight >= .5) vertices.push(vertex);
      }
      if (vertices.length) bootMeshes.push({ mesh: object, vertices });
    });
    const find = suffix => [...bones].find(([name]) => name.endsWith(suffix))?.[1];
    const legs = Object.fromEntries(['left', 'right'].map(side => [side, {
      hip: find(`${side}upleg`), knee: find(`${side}leg`), ankle: find(`${side}foot`),
    }]));
    const sample = (boots = false) => {
      // SkinnedMesh refreshes its bind inverse in updateMatrixWorld (the
      // renderer path), whereas updateWorldMatrix alone leaves it stale.
      if (boots) g.scene.updateMatrixWorld(true); else p.root.updateMatrixWorld(true);
      inverse.copy(p.root.matrixWorld).invert();
      const joints = Object.fromEntries(Object.entries(legs).map(([side, leg]) => {
        const world = Object.fromEntries(Object.entries(leg).map(([name, bone]) => [name, bone.getWorldPosition(new THREE.Vector3())]));
        const thigh = world.hip.clone().sub(world.knee), shin = world.ankle.clone().sub(world.knee);
        const local = Object.fromEntries(Object.entries(world).map(([name, vector]) => [name, vector.clone().applyMatrix4(inverse).toArray()]));
        const axis = world.ankle.clone().sub(world.hip), offset = world.knee.clone().sub(world.hip);
        offset.addScaledVector(axis, -offset.dot(axis) / axis.lengthSq()).transformDirection(inverse);
        return [side, { world: Object.fromEntries(Object.entries(world).map(([name, vector]) => [name, vector.toArray()])), local,
          flexion: 180 - THREE.MathUtils.radToDeg(thigh.angleTo(shin)),
          ankleClearance: world.ankle.y - p.ankleFloor(world.ankle.clone(), side),
          rotations: [leg.hip, leg.knee].map(bone => bone.getWorldQuaternion(new THREE.Quaternion()).toArray()) }];
      }));
      let bootClearance = null;
      if (boots) {
        bootClearance = Infinity;
        for (const { mesh, vertices } of bootMeshes) {
          mesh.skeleton.update();
          for (const vertex of vertices) {
            mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);
            bootClearance = Math.min(bootClearance, point.y - p.getGroundHeight(point.x, point.z));
          }
        }
      }
      const hips = find('hips').getWorldPosition(point);
      return { mode: p.mode, speed: p.telemetry.speed, clip: p.activeAction?.getClip().name, time: p.activeAction?.time,
        position: p.position.toArray(), grounding: p.diagnostics.grounding, hipsHeight: hips.y - p.getGroundHeight(hips.x, hips.z),
        joints, bootClearance };
    };
    window.__gaitCheck = {
      sample,
      advance(frames, moving = false) {
        const pressed = moving ? new Set(['w']) : new Set(), samples = [];
        p.cameraYaw = 0;
        for (let i = 0; i < frames; i++) { p.update(1 / 60, pressed, g.carPosition, g.yaw, 0); samples.push(sample()); }
        return samples;
      },
      view(label) {
        p.setDriverView(false); p.root.updateWorldMatrix(true, true);
        g.onTelemetry({ ...g.lastTelemetry, person: p.telemetry });
        const from = label === 'side' ? [3.1, 1.35, .15] : label === 'front' ? [1.6, 1.6, 3.5] : [0, 1.65, -3.7];
        g.camera.position.copy(p.root.localToWorld(point.set(...from)));
        g.camera.lookAt(p.root.localToWorld(point.set(0, .80, 0)));
        g.camera.near = .025; g.camera.fov = 40; g.camera.updateProjectionMatrix();
        g.scene.updateMatrixWorld(true); g.composer.render();
      },
    };
  });
  await page.evaluate(() => window.__gaitCheck.advance(420));
  report.idle = await page.evaluate(() => window.__gaitCheck.sample(true));
  assert.equal(report.idle.mode, 'walking', 'Normal exit settles on foot');
  for (const side of ['left', 'right']) {
    assert.ok(report.idle.joints[side].flexion > 1 && report.idle.joints[side].flexion < 10, 'Idle keeps a natural softly unlocked knee');
    assert.ok(report.idle.joints[side].local.knee[0] * report.idle.joints[side].local.ankle[0] > 0, 'Idle knees track the corresponding feet');
  }
  assert.ok(report.idle.hipsHeight > .78 && report.idle.hipsHeight < .93, 'Standing pelvis remains at the upright authored height');
  assert.ok(report.idle.bootClearance > -.012 && report.idle.bootClearance < .035, 'Idle boot soles rest close to the road');
  for (const view of ['back', 'side', 'front']) {
    await page.evaluate(view => window.__gaitCheck.view(view), view);
    await page.screenshot({ path: `${directory}/idle-${view}.png` });
  }

  report.walking = await page.evaluate(() => window.__gaitCheck.advance(72, true));
  report.phases = [];
  for (let phase = 0; phase < 4; phase++) {
    if (phase) report.walking.push(...await page.evaluate(() => window.__gaitCheck.advance(13, true)));
    report.phases.push(await page.evaluate(() => window.__gaitCheck.sample(true)));
    await page.evaluate(() => window.__gaitCheck.view('side'));
    await page.screenshot({ path: `${directory}/walk-phase-${phase + 1}.png` });
  }
  const gait = report.walking.slice(24), heights = { left: [], right: [] }, planted = [];
  let maximumJointFrameAngle = 0;
  for (let i = 0; i < gait.length; i++) for (const side of ['left', 'right']) {
    const joint = gait[i].joints[side]; heights[side].push(joint.ankleClearance);
    assert.ok(joint.flexion > 2 && joint.flexion < 90, 'Walking knee flexion stays within its captured anatomical range');
    if (!i) continue;
    const previous = gait[i - 1].joints[side];
    if (joint.ankleClearance < .012) planted.push(Math.hypot(joint.world.ankle[0] - previous.world.ankle[0], joint.world.ankle[2] - previous.world.ankle[2]) * 60);
    for (let bone = 0; bone < 2; bone++) {
      const dot = joint.rotations[bone].reduce((sum, value, component) => sum + value * previous.rotations[bone][component], 0);
      maximumJointFrameAngle = Math.max(maximumJointFrameAngle, 2 * Math.acos(Math.min(1, Math.abs(dot))));
    }
  }
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const left = mean(heights.left), right = mean(heights.right);
  const correlation = heights.left.reduce((sum, value, i) => sum + (value - left) * (heights.right[i] - right), 0) /
    Math.sqrt(heights.left.reduce((sum, value) => sum + (value - left) ** 2, 0) * heights.right.reduce((sum, value) => sum + (value - right) ** 2, 0));
  planted.sort((a, b) => a - b);
  report.motion = { maximumJointFrameAngle, alternatingHeightCorrelation: correlation,
    plantedMedianSpeed: planted[Math.floor(planted.length / 2)], swingClearance: Math.max(...heights.left, ...heights.right) };
  assert.ok(maximumJointFrameAngle < .24, 'The actual runtime gait has no knee/hip branch flips');
  assert.ok(correlation < -.35 && report.motion.swingClearance > .03, 'The actual player alternates planted and swinging feet');
  assert.ok(report.motion.plantedMedianSpeed < .45, 'Planted foot motion counters body travel');
  assert.ok(report.phases.every(phase => phase.bootClearance > -.035), 'Walking boots clear the visible road');
  await page.evaluate(() => window.__gaitCheck.advance(120));
  report.stopped = await page.evaluate(() => window.__gaitCheck.sample(true));
  assert.ok(['left', 'right'].every(side => report.stopped.joints[side].flexion < 10), 'Stopping returns to upright idle');
  report.seated = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, p = g.person;
    p.resetDriving(g.carPosition, g.yaw);
    for (let i = 0; i < 60; i++) p.update(1 / 60, new Set(), g.carPosition, g.yaw, 0);
    return { mode: p.mode, grounding: p.diagnostics.grounding, steering: p.diagnostics.steering };
  });
  assert.equal(report.seated.mode, 'driving');
  assert.equal(report.seated.grounding.verticalOffset, 0, 'On-foot body grounding is removed before sitting');
  assert.ok(report.seated.steering.maximumGripError < .055, 'Seated hands still track the wheel');
  assert.deepEqual(report.errors, [], 'No runtime or shader errors');
  console.log(JSON.stringify({ idle: report.idle, motion: report.motion, phases: report.phases.map(phase => ({
    clip: phase.clip, time: phase.time, knees: [phase.joints.left.flexion, phase.joints.right.flexion], bootClearance: phase.bootClearance,
  })), seated: report.seated, errors: report.errors }, null, 2));
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
