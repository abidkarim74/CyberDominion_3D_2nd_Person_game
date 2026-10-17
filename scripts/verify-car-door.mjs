import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const asset = JSON.parse(await readFile('lib/blender-car-model.json', 'utf8'));
const authored = asset.meshes.filter(panel => panel.part === 'driverDoor');
assert.ok(authored.some(panel => panel.material === 'glass'), 'The complete side window belongs to the authored door');
assert.ok(authored.some(panel => panel.material === 'paint'), 'The complete outer skin belongs to the authored door');
const passenger = asset.meshes.filter(panel => panel.part === 'passengerDoor');
assert.ok(passenger.some(panel => panel.material === 'glass') && passenger.some(panel => panel.material === 'paint'),
  'Passenger glass and skin retain their own fitted boundaries');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true, timeout: 90000 });
  const assembly = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame); game.reset(); game.active = false;
    game.qualityWarmup = Infinity; game.person.root.visible = false;
    game.carRig.body.position.y = 0; game.carRig.body.rotation.set(0, 0, 0);
    const hinge = game.carRig.driverDoor;
    const panels = hinge.children.filter(mesh => mesh.isMesh && mesh.userData.carPart === 'driverDoor');
    const geometry = panels.map(mesh => ({ name: mesh.name,
      triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
      material: mesh.material.name, dynamic: mesh.userData.dynamic,
    }));
    const points = panels.map(mesh => mesh.geometry.attributes.position);
    const v = game.car.position.clone();
    hinge.rotation.y = 0; game.car.updateMatrixWorld(true);
    const closed = panels.map((mesh, index) => v.fromBufferAttribute(points[index], 0).applyMatrix4(mesh.matrixWorld).toArray());
    const pivot = hinge.getWorldPosition(v).clone();
    hinge.rotation.y = -.96; game.car.updateMatrixWorld(true);
    const open = panels.map((mesh, index) => v.fromBufferAttribute(points[index], 0).applyMatrix4(mesh.matrixWorld).toArray());
    hinge.rotation.y = 0; game.car.updateMatrixWorld(true);
    const restored = panels.map((mesh, index) => v.fromBufferAttribute(points[index], 0).applyMatrix4(mesh.matrixWorld).toArray());
    let stranded = 0;
    game.carRig.body.traverse(mesh => { if (mesh.isMesh && mesh.userData.carPart === 'driverDoor' && mesh.parent !== hinge) stranded++; });
    return { geometry, hinge: hinge.position.toArray(), closed, open, restored, pivot: pivot.toArray(), stranded,
      liningAttached: panels.some(mesh => /driverDoor \/ trim$/.test(mesh.name)) };
  });
  assert.deepEqual(assembly.hinge, asset.driverDoorHinge, 'The original author hinge is retained');
  assert.equal(assembly.stranded, 0, 'No door fragments remain attached to the chassis');
  assert.ok(assembly.liningAttached, 'The complete fitted interior lining follows the door');
  for (const panel of authored) {
    const runtime = assembly.geometry.find(mesh => mesh.name === `Driver door / ${panel.name}`);
    assert.ok(runtime, `Whole authored panel retained: ${panel.material}`);
    assert.equal(runtime.triangles, panel.triangles, `No triangles are cut from ${panel.material}`);
    assert.equal(runtime.dynamic, true);
  }
  assert.equal(assembly.geometry.filter(mesh => /inner surface/.test(mesh.name)).length, 1,
    'The entire inner window laminate follows the outer side window');
  for (let i = 0; i < assembly.closed.length; i++) {
    const [x, y, z] = assembly.closed[i].map((value, axis) => value - assembly.pivot[axis]);
    const angle = -.96, c = Math.cos(angle), s = Math.sin(angle);
    const expected = [c * x + s * z, y, -s * x + c * z].map((value, axis) => value + assembly.pivot[axis]);
    assert.ok(expected.every((value, axis) => Math.abs(value - assembly.open[i][axis]) < 1e-6), 'Every panel moves as one rigid door');
    assert.deepEqual(assembly.restored[i], assembly.closed[i], 'Closing restores the exact authored surface');
  }

  await page.addStyleTag({ content: '.drive-hud,.person-hud,.person-interaction,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident{display:none!important}' });
  for (const [name, angle, camera, target] of [
    ['closed', 0, [-3.8, 1.5, -2.3], [-.4, .75, -.1]],
    ['closed-passenger', 0, [3.0, 1.35, -.5], [.6, .83, -.1]],
    ['closed-top', 0, [2.7, 3.4, -3.0], [.3, .82, .05]],
    ['half-open', -.48, [-3.8, 1.7, -2.5], [-.8, .75, -.2]],
    ['open-front', -.96, [-3.8, 1.6, -2.4], [-1.0, .75, -.15]],
    ['open-rear', -.96, [-3.6, 1.8, 2.0], [-1.0, .75, -.1]],
    ['open-inside', -.96, [-.10, 1.08, .35], [-1.7, .72, -.40]],
  ]) {
    await page.evaluate(({ angle, camera, target }) => {
      const g = document.querySelector('canvas').__drive, v = g.carPosition.clone();
      g.carRig.driverDoor.rotation.y = angle;
      g.camera.position.copy(g.carPosition).add(v.set(...camera));
      g.camera.lookAt(g.carPosition.clone().add(v.set(...target)));
      g.camera.near = .025; g.camera.fov = 45; g.camera.updateProjectionMatrix();
      g.scene.updateMatrixWorld(true); g.renderer.shadowMap.needsUpdate = true;
      g.renderer.info.reset();
      for (let i = 0; i < 3; i++) g.composer.render();
    }, { angle, camera, target });
    await page.screenshot({ path: `artifacts/car-door-${name}.png` });
  }
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = true; g.person.root.visible = true;
  });
  const transfer = async expectedMode => {
    await page.keyboard.press('e');
    const result = await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive, initial = g.person.mode;
      let peakAngle = 0;
      for (let t = 0; t < g.person.diagnostics.transitionSeconds + .15; t += .05) {
        g.frame((g.previousTime || performance.now()) + 50); cancelAnimationFrame(g.animationFrame);
        peakAngle = Math.max(peakAngle, Math.abs(g.carRig.driverDoor.rotation.y));
      }
      return { initial, mode: g.person.mode, peakAngle, finalAngle: g.carRig.driverDoor.rotation.y };
    });
    assert.equal(result.mode, expectedMode);
    assert.ok(result.peakAngle > .9, 'The door opens through the full animated transfer');
    assert.ok(Math.abs(result.finalAngle) < 1e-8, 'The door closes after the transfer');
    return result;
  };
  const exit = await transfer('walking'), entry = await transfer('driving');
  assert.deepEqual(errors, [], 'No browser errors');
  await writeFile('artifacts/car-door-verification.json', JSON.stringify({ authored, ...assembly, exit, entry, errors },
    (key, value) => ['position', 'normal', 'uv', 'index'].includes(key) ? undefined : value, 2));
  console.log(JSON.stringify({ hinge: assembly.hinge, authoredPanels: authored.length,
    doorTriangles: authored.reduce((sum, panel) => sum + panel.triangles, 0), stranded: assembly.stranded, exit, entry, errors }));
} finally { await browser.close(); }
