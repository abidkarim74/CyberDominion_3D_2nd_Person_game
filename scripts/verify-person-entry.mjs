import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const report = { url: process.env.GAME_URL || 'http://localhost:3000/', checks: {} };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(report.url);
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready,
    null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame);
    g.qualityWarmup = Infinity;
    g.reset();
    g.scene.updateMatrixWorld(true);
    const p = g.person, point = p.position.clone();
    const roof = [];
    const inverse = g.carRig.body.matrixWorld.clone().invert();
    // Read the actual headliner triangles after architecture batching. Only its
    // leather upper surfaces can intersect a vertical ray above the seated head.
    g.carRig.body.traverse(mesh => {
      if (!mesh.isMesh || !mesh.material?.name?.includes('fine grained anthracite leather')) return;
      const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
      const matrix = inverse.clone().multiply(mesh.matrixWorld);
      for (let i = 0; i < (index?.count ?? position.count); i += 3) {
        const vertices = [0, 1, 2].map(j => point.fromBufferAttribute(position, index ? index.getX(i + j) : i + j)
          .applyMatrix4(matrix).toArray());
        if (vertices.every(([x, y, z]) => Math.abs(x) < .63 && y > 1.16 && y < 1.26 && z > -.56 && z < .80)) roof.push(vertices);
      }
    });
    const heads = [], feet = [];
    p.root.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return;
      const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight, vertices = [], footVertices = [];
      for (let i = 0; i < indices.count; i++) {
        let headWeight = 0, footWeight = 0;
        for (let j = 0; j < 4; j++) {
          const name = mesh.skeleton.bones[indices.getComponent(i, j)].name;
          if (/Head/.test(name)) headWeight += weights.getComponent(i, j);
          if (/(Left|Right)(Foot|Toe)/.test(name)) footWeight += weights.getComponent(i, j);
        }
        if (headWeight >= .5) vertices.push(i);
        if (footWeight >= .5) footVertices.push(i);
      }
      if (vertices.length) heads.push({ mesh, vertices });
      if (footVertices.length) feet.push({ mesh, vertices: footVertices });
    });
    const ceiling = (x, z) => {
      let height = Infinity;
      for (const [a, b, c] of roof) {
        const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(denominator) < 1e-10) continue;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
        if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) height = Math.min(height, u * a[1] + v * b[1] + (1 - u - v) * c[1]);
      }
      return height;
    };
    const sample = () => {
      g.scene.updateMatrixWorld(true);
      inverse.copy(g.carRig.body.matrixWorld).invert();
      const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      let covered = 0, clearance = Infinity;
      for (const { mesh, vertices } of heads) {
        mesh.skeleton.update();
        for (const i of vertices) {
          mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
          for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], point.getComponent(axis));
            bounds.max[axis] = Math.max(bounds.max[axis], point.getComponent(axis));
          }
          const y = ceiling(point.x, point.z);
          if (Number.isFinite(y)) { covered++; clearance = Math.min(clearance, y - point.y); }
        }
      }
      let roadClearance = Infinity, floorClearance = Infinity, roadVertices = 0, cabinVertices = 0;
      for (const { mesh, vertices } of feet) {
        mesh.skeleton.update();
        for (const i of vertices) {
          mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
          const road = g.person.getGroundHeight(point.x, point.z), worldY = point.y;
          point.applyMatrix4(inverse);
          if (point.x < -1.10) { roadVertices++; roadClearance = Math.min(roadClearance, worldY - road); }
          if (Math.abs(point.x) < .63 && point.z > -.74 && point.z < .65) {
            cabinVertices++; floorClearance = Math.min(floorClearance, point.y - .4375);
          }
        }
      }
      const bones = {};
      p.root.traverse(bone => { if (bone.isBone && /Hips$|Head$|UpLeg$|Leg$|Foot$/.test(bone.name)) bones[bone.name] = bone.getWorldPosition(point).applyMatrix4(inverse).toArray(); });
      const root = p.position.clone().applyMatrix4(inverse).toArray();
      return { mode: p.mode, root, yaw: p.yaw - g.yaw, head: bounds, covered,
        clearance: Number.isFinite(clearance) ? clearance : null, bones,
        soles: { roadVertices, cabinVertices, roadClearance: Number.isFinite(roadClearance) ? roadClearance : null,
          floorClearance: Number.isFinite(floorClearance) ? floorClearance : null },
        door: p.doorOpenAmount, doorAngle: g.carRig.driverDoor.rotation.y,
        clip: p.activeAction?.getClip().name, poseTime: p.activeAction?.time,
        elapsed: p.transition?.elapsed ?? null };
    };
    window.__entryCheck = { sample, roofTriangles: roof.length, headVertices: heads.reduce((sum, entry) => sum + entry.vertices.length, 0),
      advance(seconds) {
        const samples = [];
        if (!g.previousTime) g.previousTime = performance.now();
        for (let remaining = seconds; remaining > .000001; remaining -= .05) {
          g.frame(g.previousTime + Math.min(.05, remaining) * 1000);
          cancelAnimationFrame(g.animationFrame);
          samples.push(sample());
        }
        return samples;
      },
      renderCamera(position, target) {
        const origin = g.carPosition;
        g.camera.position.copy(origin).add(point.set(...position));
        g.camera.lookAt(origin.clone().add(point.set(...target)));
        g.camera.near = .025; g.camera.updateProjectionMatrix();
        g.scene.updateMatrixWorld(true); g.composer.render();
      } };
  });
  const advance = seconds => page.evaluate(seconds => window.__entryCheck.advance(seconds), seconds);
  const info = await page.evaluate(() => ({ ...document.querySelector('canvas').__drive.person.diagnostics,
    roofTriangles: window.__entryCheck.roofTriangles, headVertices: window.__entryCheck.headVertices }));
  report.asset = info;
  assert.ok(Math.abs(info.scale - .92 * .92) < 1e-8, 'The current character is eight percent smaller');
  assert.ok(info.height > 1.50 && info.height < 1.54, 'Measured standing height matches the reduced rig');
  assert.ok(info.roofTriangles > 100 && info.headVertices > 1000, 'Clearance checks use actual roof and skinned head geometry');
  report.checks.seated = await advance(2);
  console.log(`Seated head clearance: ${Math.min(...report.checks.seated.map(sample => sample.clearance)).toFixed(4)}m; sole clearance: ${Math.min(...report.checks.seated.map(sample => sample.soles.floorClearance)).toFixed(4)}m`);
  assert.ok(report.checks.seated.every(sample => sample.covered > 1000 && sample.clearance > .01),
    'The animated seated head clears the inside roof by at least one centimetre');
  await page.evaluate(() => window.__entryCheck.renderCamera([-3.2, 2.1, 2.2], [-.2, 1.05, .1]));
  await page.screenshot({ path: 'artifacts/person-seated-roof-clearance.png' });

  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.person.mode), 'exiting');
  const duration = info.transitionSeconds;
  report.checks.exit = await advance(duration + .15);
  assert.equal(report.checks.exit.at(-1).mode, 'walking');
  assert.ok(report.checks.exit.some(sample => sample.door > .98));
  const outside = report.checks.exit.at(-1);
  await page.keyboard.press('e');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.person.mode), 'entering');
  const entering = await advance(duration * .40);
  report.checks.entry = entering;

  report.checks.doorMaterials = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, hinge = g.carRig.driverDoor, meshes = [];
    hinge.traverse(mesh => { if (mesh.isMesh) meshes.push({ name: mesh.name, carPart: mesh.userData.carPart, visible: mesh.visible,
      triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
      materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material =>
        ({ name: material.name, side: material.side, transparent: material.transparent, opacity: material.opacity })) }); });
    return meshes;
  });
  const opaqueDoor = report.checks.doorMaterials.filter(mesh => mesh.materials.some(material => !material.transparent && material.opacity >= .99));
  assert.ok(opaqueDoor.some(mesh => mesh.carPart === 'driverDoor' && /trim|interior/i.test(mesh.name)),
    'The fitted authored interior follows the hinge');
  assert.ok(opaqueDoor.filter(mesh => mesh.name.startsWith('Driver door /')).every(mesh => mesh.materials.every(material => material.side === 2)),
    'Painted door skin is visible from both sides');
  assert.ok(entering.at(-1).door > .9, 'Door stays open during approach and ducking');

  for (const [name, camera, target] of [
    ['exterior', [-4.2, 1.4, -2], [-1.4, .8, .1]],
    ['inside', [-.28, 1.05, .40], [-1.5, .8, -.05]],
  ]) {
    const visiblePixels = await page.evaluate(({ camera, target }) => {
      const g = document.querySelector('canvas').__drive, hinge = g.carRig.driverDoor;
      const mirror = g.reflections.mirror, mirrorVisible = mirror.visible; mirror.visible = false;
      window.__entryCheck.renderCamera(camera, target);
      const canvas = document.createElement('canvas'); canvas.width = g.renderer.domElement.width; canvas.height = g.renderer.domElement.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const pixels = () => { g.composer.render(); context.drawImage(g.renderer.domElement, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
      const before = pixels(); hinge.visible = false; const after = pixels(); hinge.visible = true;
      let count = 0;
      for (let i = 0; i < before.length; i += 4) if (Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2])) > 8) count++;
      mirror.visible = mirrorVisible; g.composer.render();
      return count;
    }, { camera, target });
    report.checks[`openDoor${name}`] = { visiblePixels };
    assert.ok(visiblePixels > 3000, `The open door contributes visible pixels from ${name}`);
    await page.screenshot({ path: `artifacts/person-open-door-${name}.png` });
  }

  report.checks.entry.push(...await advance(duration * .25));
  await page.evaluate(() => window.__entryCheck.renderCamera([-3.2, 1.7, 1.2], [-.6, .85, .1]));
  await page.screenshot({ path: 'artifacts/person-entering-through-door.png' });
  report.checks.entry.push(...await advance(duration * .35 + .2));
  const entry = report.checks.entry;
  assert.equal(entry.at(-1).mode, 'driving');
  assert.match(entry.at(-1).clip, /seated/i);
  assert.equal(entry.at(-1).door, 0);
  assert.ok(entry.filter(sample => sample.covered > 0).every(sample => sample.clearance >= .005),
    'Every head vertex that passes below the cabin roof clears its actual leather surface');
  const crossing = entry.filter(sample => sample.root[0] > -.85 && sample.root[0] < -.50);
  assert.ok(crossing.length >= 3 && crossing.every(sample => sample.door > .95),
    'The driver moves through the open doorway before the door closes');
  assert.ok(entry.filter(sample => sample.elapsed !== null && sample.door < .5 && sample.elapsed < duration * .25)
    .every(sample => sample.root[0] < -1.1), 'The door opens before the person crosses the sill');
  assert.ok(entry.some(sample => sample.root[1] < outside.root[1] - .12 && sample.root[0] < -.7),
    'The person ducks outside the low roof before entering');
  assert.ok(entry.every((sample, index) => index === 0 || Math.hypot(...sample.root.map((value, axis) => value - entry[index - 1].root[axis])) < .30),
    'Entry follows a continuous path without teleporting');
  report.checks.afterEntry = await advance(2);
  assert.ok(report.checks.afterEntry.every(sample => sample.clearance > .01 && sample.covered > 1000),
    'Head remains inside the cabin throughout seated breathing after entry');
  const transfers = [...report.checks.exit, ...entry].filter(sample => sample.mode === 'entering' || sample.mode === 'exiting');
  console.log(`Transfer sole clearance: road ${Math.min(...transfers.filter(sample => sample.soles.roadClearance !== null).map(sample => sample.soles.roadClearance)).toFixed(4)}m; cabin ${Math.min(...transfers.filter(sample => sample.soles.floorClearance !== null).map(sample => sample.soles.floorClearance)).toFixed(4)}m`);
  assert.ok(transfers.filter(sample => sample.soles.roadVertices > 0).every(sample => sample.soles.roadClearance >= -.01),
    'Actual shoe soles remain within one centimetre of the snowy road while the feet are outside the car');
  assert.ok(transfers.filter(sample => sample.soles.cabinVertices > 0).every(sample => sample.soles.floorClearance >= -.004),
    'Actual shoe soles clear the cabin floor while crossing into the footwell');
  assert.ok(report.checks.afterEntry.every(sample => sample.soles.cabinVertices > 100 && sample.soles.floorClearance >= -.004),
    'Both seated shoes remain on or above the cabin floor');
  report.checks.suspension = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, samples = [];
    for (const [pitch, roll, bob] of [[.08, .09, .02], [-.08, -.09, -.02], [.06, -.08, .015], [-.06, .08, -.015]]) {
      g.carRig.body.rotation.set(pitch, 0, roll); g.carRig.body.position.y = bob;
      g.scene.updateMatrixWorld(true);
      g.person.update(1 / 60, new Set(), g.carPosition, g.yaw, 0, []);
      samples.push({ pitch, roll, bob, ...window.__entryCheck.sample() });
    }
    g.carRig.body.rotation.set(0, 0, 0); g.carRig.body.position.y = 0;
    g.scene.updateMatrixWorld(true); g.person.update(1 / 60, new Set(), g.carPosition, g.yaw, 0, []);
    return samples;
  });
  assert.ok(report.checks.suspension.every(sample => sample.clearance > .01 && sample.soles.floorClearance >= -.004),
    'Seated head and shoe soles follow the pitched, banked, and bobbing cabin');
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.carRig.driverDoor.rotation.y = -.96;
    window.__entryCheck.renderCamera([-2.6, 1.3, .6], [-.35, .8, -.15]);
  });
  await page.screenshot({ path: 'artifacts/person-seated-open-cabin.png' });
  await page.evaluate(() => { document.querySelector('canvas').__drive.carRig.driverDoor.rotation.y = 0; });
  await page.evaluate(() => window.__entryCheck.renderCamera([-3.2, 2.1, 2.2], [-.2, 1.05, .1]));
  await page.screenshot({ path: 'artifacts/person-seated-after-entry.png' });
  assert.deepEqual(errors, [], 'No browser runtime errors during entry or exit');
  report.runtimeErrors = errors;
  report.passed = true;
  console.log('Person size, skinned roof clearance, staged entry, and visible door checks passed');
} catch (error) {
  report.passed = false; report.failure = error.stack || error.message; report.runtimeErrors = errors;
  await page.screenshot({ path: 'artifacts/person-entry-verification-failure.png' }).catch(() => {});
  throw error;
} finally {
  await writeFile('artifacts/person-entry-verification.json', JSON.stringify(report, null, 2));
  await browser.close();
}
