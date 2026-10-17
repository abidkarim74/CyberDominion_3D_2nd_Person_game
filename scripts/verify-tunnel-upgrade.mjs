import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = 'artifacts/tunnel-upgrade';
await mkdir(directory, { recursive: true });
const report = { errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready);
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  report.routes = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { ROAD_COORDS } = await import('/lib/city-layout.ts');
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.active = false; g.qualityWarmup = Infinity; g.reset();
    const structures = [];
    g.scene.traverse(object => { if (object.userData.tunnelLength) structures.push({
      name: object.name, position: object.position.toArray(), length: object.userData.tunnelLength,
      sections: object.userData.tunnelWallSections, crossings: object.userData.tunnelCrossings,
    }); });
    g.car.visible = false; g.person.root.visible = false; g.scene.updateMatrixWorld(true);
    const meshes = [];
    g.scene.traverse(object => { if (object.isMesh && !object.userData.dynamic && !object.material.transparent) meshes.push(object); });
    const ray = new THREE.Raycaster(), upward = new THREE.Vector3(0, 1, 0), source = new THREE.Vector3();
    const results = [];
    for (const route of g.coveredRoads) {
      const half = Math.max(route.hx, route.hz), sideways = route.hx > route.hz;
      if (half < 49) continue;
      // GPU-batched geometry raycasts honor the instance visibility selected
      // around the current player, so probe each tunnel from its own district.
      g.updateCityVisibility(new THREE.Vector3(route.x, 0, route.z), 0, 1);
      g.scene.updateMatrixWorld(true);
      const from = { x: route.x - (sideways ? half + 3 : 0), z: route.z - (sideways ? 0 : half + 3) };
      const to = { x: route.x + (sideways ? half + 3 : 0), z: route.z + (sideways ? 0 : half + 3) };
      const laneHits = [-4, 0, 4].map(lane => {
        const a = { x: from.x + (sideways ? 0 : lane), z: from.z + (sideways ? lane : 0) };
        const b = { x: to.x + (sideways ? 0 : lane), z: to.z + (sideways ? lane : 0) };
        const hit = g.collisionWorld.sweep(a, b, sideways ? Math.PI / 2 : 0);
        return { lane, hit: hit ? { time: hit.time, collider: hit.collider } : null };
      });
      const crossRoutes = [];
      for (const coordinate of ROAD_COORDS) {
        const local = coordinate - (sideways ? route.x : route.z);
        if (Math.abs(local) >= half - 1) continue;
        const a = sideways ? { x: coordinate, z: route.z - 12.5 } : { x: route.x - 12.5, z: coordinate };
        const b = sideways ? { x: coordinate, z: route.z + 12.5 } : { x: route.x + 12.5, z: coordinate };
        const hit = g.collisionWorld.sweep(a, b, sideways ? 0 : Math.PI / 2);
        crossRoutes.push({ coordinate, hit: hit ? { time: hit.time, collider: hit.collider } : null });
      }
      const roof = [];
      for (let i = 0; i <= 12; i++) {
        const along = -half + .7 + i / 12 * (half * 2 - 1.4);
        source.set(route.x + (sideways ? along : 0), 2.2, route.z + (sideways ? 0 : along));
        ray.set(source, upward); ray.far = 12;
        const hit = ray.intersectObjects(meshes, false)[0];
        roof.push({ along, height: hit?.point.y ?? null });
      }
      results.push({ ...route, length: half * 2, laneHits, crossRoutes, roof });
    }
    g.car.visible = true; g.person.root.visible = true;
    return { tunnels: results, structures, underpasses: g.coveredRoads.filter(route => Math.max(route.hx, route.hz) < 49),
      spawnCovered: g.coveredRoads.some(route => Math.abs(-22 - route.x) < route.hx && Math.abs(40 - route.z) < route.hz) };
  });
  console.log('Extended tunnel geometry, collision lanes and roofs sampled');
  for (const [index, route] of report.routes.tunnels.slice(0, 2).entries()) {
    await page.evaluate(route => {
      const g = document.querySelector('canvas').__drive;
      const sideways = route.hx > route.hz, half = Math.max(route.hx, route.hz);
      g.carPosition.set(route.x - (sideways ? half - 9 : 0), .015, route.z - (sideways ? 0 : half - 9));
      g.car.position.copy(g.carPosition); g.yaw = sideways ? -Math.PI / 2 : Math.PI;
      g.car.rotation.y = g.yaw; g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0);
      g.setCameraView('driver'); g.person.update(0, g.pressed, g.carPosition, g.yaw, 0, []);
      g.carRig.cockpit.ambience.reset(true); g.carRig.cockpit.ambience.update(2.5, true, true);
      g.updateCityVisibility(g.carPosition, 0, 1); g.updateCamera(0, true);
      for (let i = 0; i < 3; i++) { g.elapsed += .3; g.drivingMirrors.update(g.renderer, g.scene, g.camera, g.elapsed, true); }
      g.renderer.shadowMap.needsUpdate = true; g.composer.render();
    }, route);
    await page.screenshot({ path: `${directory}/${index ? 'arched' : 'central'}-driver.png` });
    await page.evaluate(route => {
      const g = document.querySelector('canvas').__drive;
      g.car.visible = false; g.person.root.visible = false;
      g.camera.position.set(route.x - 2.5, 2.1, route.z - route.hz + 3.5);
      g.camera.lookAt(route.x + 1.2, 5.1, route.z + 16);
      g.camera.updateMatrixWorld(true);
      g.composer.render();
    }, route);
    await page.screenshot({ path: `${directory}/${index ? 'arched' : 'central'}-interior.png` });
    await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      g.car.visible = true; g.person.root.visible = true;
    });
  }
  assert.ok(report.routes.tunnels.length >= 5, 'Existing vehicle tunnels are retained');
  assert.equal(report.routes.spawnCovered, false, 'The town-side central entrance stays beyond the starting square');
  for (const route of report.routes.tunnels) {
    assert.equal(route.length, route.label === 'CENTRAL TUNNEL' ? 104 : 100, `${route.label} is four times its prior length`);
    assert.ok(route.laneHits.every(sample => !sample.hit), `${route.label} retains clear traffic lanes`);
    assert.ok(route.crossRoutes.every(sample => !sample.hit), `${route.label} retains perpendicular cross-street access`);
    assert.ok(route.roof.every(sample => sample.height > 6 && sample.height < 12), `${route.label} has continuous full-length overhead cover`);
  }
  assert.ok(report.routes.underpasses.every(route => route.hx === 12.5 || route.hz === 12.5), 'Underpass lengths remain 25m');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ tunnels: report.routes.tunnels.map(route => ({ label: route.label, length: route.length,
    lanesClear: route.laneHits.every(sample => !sample.hit), crossStreets: route.crossRoutes.length,
    crossStreetsClear: route.crossRoutes.every(sample => !sample.hit), roof: route.roof.map(sample => sample.height) })), errors: report.errors }, null, 2));
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
