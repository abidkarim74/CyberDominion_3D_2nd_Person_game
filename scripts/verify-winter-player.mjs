import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Exercise the shipped rig, real keyboard controls and normal game frame path.
// The bounded clock makes this a behavior check, not a rendering benchmark.
await mkdir('artifacts', { recursive: true });
const report = { url: process.env.GAME_URL || 'http://localhost:3000/', checks: {} };
const glbJson = async path => {
  const bytes = await readFile(path);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${path} is a GLB`);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, `${path} has a JSON chunk`);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
};
const original = await glbJson('public/models/person/person.glb');
const winter = await glbJson('public/models/person/person-winter.glb');
const manifest = JSON.parse(await readFile('public/models/person/person-winter-manifest.json', 'utf8'));
const expectedClips = ['EnterCar', 'ExitCar', 'Idle', 'Run', 'Seated', 'Walk'];
assert.deepEqual(winter.animations.map(clip => clip.name).sort(), expectedClips, 'All six authored animation clips ship in the winter GLB');
const duration = (gltf, animation) => Math.max(...animation.samplers.map(sampler => gltf.accessors[sampler.input].max[0]));
for (const clip of original.animations) {
  const retained = winter.animations.find(candidate => candidate.name === clip.name);
  assert.ok(Math.abs(duration(original, clip) - duration(winter, retained)) < .035, `${clip.name} retains its authored duration`);
}
const jointNames = gltf => [...new Set(gltf.skins.flatMap(skin => skin.joints.map(index => gltf.nodes[index].name)))].sort();
assert.deepEqual(jointNames(winter), jointNames(original), 'Winter clothes retain the complete original articulated skeleton');
const winterMaterials = winter.materials.filter(material => /winter/i.test(material.name));
assert.ok(winterMaterials.length >= 6, 'The outfit contains distinct authored winter materials');
assert.ok(winterMaterials.filter(material => material.pbrMetallicRoughness?.baseColorTexture).length >= 4,
  'Detailed winter fabrics have embedded surface textures');
report.glb = { clips: expectedClips, bones: jointNames(winter).length, winterMaterials: winterMaterials.map(material => material.name),
  textures: winter.images?.length ?? 0, manifest };

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(report.url);
  await page.waitForFunction(() => {
    const p = document.querySelector('canvas')?.__drive?.person;
    return p?.ready || p?.telemetry.loadingError;
  }, null, { timeout: 90000 });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity;
  });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, p = g.person;
    cancelAnimationFrame(g.animationFrame); g.reset();
    const point = p.position.clone(), inverse = p.root.matrixWorld.clone();
    const materials = mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    const label = mesh => `${mesh.name} ${materials(mesh).map(material => material.name).join(' ')}`;
    const winterMesh = mesh => /winter/i.test(label(mesh));
    const meshes = [];
    p.root.traverse(mesh => { if (mesh.isSkinnedMesh) meshes.push(mesh); });
    const weight = (mesh, vertex, pattern) => {
      const joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
      let sum = 0;
      for (let component = 0; component < 4; component++) {
        if (pattern.test(mesh.skeleton.bones[joints.getComponent(vertex, component)].name))
          sum += weights.getComponent(vertex, component);
      }
      return sum;
    };
    const roles = { parka: [], gloves: [], boots: [] };
    for (const mesh of meshes.filter(winterMesh)) {
      const selected = { parka: [], gloves: [], boots: [] };
      for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
        if (/coat|parka/i.test(label(mesh))) selected.parka.push(vertex);
        if (weight(mesh, vertex, /(?:Left|Right)Hand/) > .5) selected.gloves.push(vertex);
        if (weight(mesh, vertex, /(?:Left|Right)(?:Foot|Toe)/) > .5) selected.boots.push(vertex);
      }
      for (const role of Object.keys(roles)) if (selected[role].length) {
        const vertices = selected[role], stride = Math.max(1, Math.floor(vertices.length / 96));
        roles[role].push({ mesh, vertices: vertices.filter((_, index) => index % stride === 0) });
      }
    }
    const sampleClothes = () => {
      g.scene.updateMatrixWorld(true); inverse.copy(p.root.matrixWorld).invert();
      return Object.fromEntries(Object.entries(roles).map(([role, entries]) => [role,
        entries.flatMap(({ mesh, vertices }) => {
          mesh.skeleton.update();
          return vertices.flatMap(vertex => mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld)
            .applyMatrix4(inverse).toArray());
        })]));
    };
    const sample = () => ({ ...p.diagnostics, clip: p.activeAction?.getClip().name,
      poseTime: p.activeAction?.time, yaw: p.yaw, position: p.position.toArray(),
      doorAngle: g.carRig.driverDoor.rotation.y, camera: g.cameraView, clothes: sampleClothes() });
    const capture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = g.renderer.domElement.width; canvas.height = g.renderer.domElement.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      g.composer.render(); context.drawImage(g.renderer.domElement, 0, 0);
      return { pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width, height: canvas.height };
    };
    window.__winterCheck = {
      sample,
      meshInfo: () => meshes.map(mesh => ({ name: mesh.name, label: label(mesh), winter: winterMesh(mesh), visible: mesh.visible,
        vertices: mesh.geometry.attributes.position.count,
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
        bones: mesh.skeleton.bones.length,
        materials: materials(mesh).map(material => ({ name: material.name, color: material.color?.getHexString(),
          textured: !!material.map, width: material.map?.image?.width, height: material.map?.image?.height })) })),
      advance(seconds) {
        const samples = [];
        cancelAnimationFrame(g.animationFrame);
        if (!g.previousTime) g.previousTime = performance.now();
        for (let remaining = seconds; remaining > .00001; remaining -= .1) {
          g.frame(g.previousTime + Math.min(.1, remaining) * 1000);
          cancelAnimationFrame(g.animationFrame); samples.push(sample());
        }
        return samples;
      },
      renderPerson(camera, target) {
        p.root.updateMatrixWorld(true);
        g.camera.position.copy(p.root.localToWorld(point.set(...camera)));
        g.camera.lookAt(p.root.localToWorld(point.set(...target)));
        g.camera.near = .025; g.camera.fov = 46; g.camera.updateProjectionMatrix();
        g.scene.updateMatrixWorld(true); g.composer.render();
      },
      renderCar(camera, target) {
        g.camera.position.copy(g.carPosition).add(point.set(...camera));
        g.camera.lookAt(g.carPosition.clone().add(point.set(...target)));
        g.camera.near = .025; g.camera.fov = 46; g.camera.updateProjectionMatrix();
        g.scene.updateMatrixWorld(true); g.composer.render();
      },
      // Remove only the actual gloved-hand triangles, even if boots share their
      // exported mesh/material. This proves visible winter gloves in the cockpit.
      visiblePixels(role) {
        const mirror = g.reflections.mirror, mirrorVisible = mirror.visible;
        mirror.visible = false;
        const before = capture(), changed = [];
        for (const mesh of meshes.filter(winterMesh)) {
          if (role === 'parka' && /coat|parka/i.test(label(mesh))) {
            changed.push({ mesh, visible: mesh.visible }); mesh.visible = false;
          } else if (role === 'gloves') {
            const source = mesh.geometry, index = source.index;
            if (!index) continue;
            const retained = [];
            for (let i = 0; i < index.count; i += 3) {
              const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
              if (vertices.some(vertex => weight(mesh, vertex, /(?:Left|Right)Hand/) > .5)) continue;
              retained.push(...vertices);
            }
            if (retained.length === index.count) continue;
            const geometry = source.clone(); geometry.setIndex(retained);
            geometry.clearGroups();
            changed.push({ mesh, geometry: source, temporary: geometry }); mesh.geometry = geometry;
          }
        }
        const after = capture();
        for (const entry of changed) {
          if (entry.geometry) { entry.mesh.geometry = entry.geometry; entry.temporary.dispose(); }
          else entry.mesh.visible = entry.visible;
        }
        let pixels = 0, lowerPixels = 0;
        for (let i = 0; i < before.pixels.length; i += 4) {
          if (Math.max(...[0, 1, 2].map(channel => Math.abs(before.pixels[i + channel] - after.pixels[i + channel]))) > 5) {
            pixels++; if (i / 4 >= before.width * before.height * .5) lowerPixels++;
          }
        }
        mirror.visible = mirrorVisible; g.composer.render();
        return { pixels, lowerPixels, affectedMeshes: changed.map(entry => entry.mesh.name) };
      },
      headTriangles() {
        return meshes.filter(winterMesh).map(mesh => {
          const index = mesh.geometry.index;
          let headTriangles = 0;
          if (mesh.visible) for (let i = 0; i < (index?.count ?? 0); i += 3) {
            if ([0, 1, 2].some(offset => weight(mesh, index.getX(i + offset), /(?:Neck|Head|Eye)/) >= .5)) headTriangles++;
          }
          return { name: mesh.name, label: label(mesh), visible: mesh.visible,
            triangles: mesh.visible ? (index?.count ?? 0) / 3 : 0, headTriangles };
        });
      },
    };
  });
  const advance = seconds => page.evaluate(seconds => window.__winterCheck.advance(seconds), seconds);
  const snapshot = () => page.evaluate(() => window.__winterCheck.sample());
  const screenshot = async name => {
    await page.screenshot({ path: `artifacts/winter-player-${name}.png` });
  };
  const deformation = (samples, role) => {
    const reference = samples[0].clothes[role];
    let displacement = 0;
    for (const sample of samples) for (let index = 0; index < reference.length; index += 3)
      displacement = Math.max(displacement, Math.hypot(...[0, 1, 2].map(axis => sample.clothes[role][index + axis] - reference[index + axis])));
    return displacement;
  };
  const compact = samples => samples.map(({ clothes, ...sample }) => sample);
  report.asset = await page.evaluate(() => ({ ...document.querySelector('canvas').__drive.person.diagnostics,
    meshes: window.__winterCheck.meshInfo() }));
  assert.equal(report.asset.ready, true, report.asset.loadingError || 'Winter player loads');
  assert.match(report.asset.asset, /person-winter\.glb\?v=winter-outfit-v1/, 'The game loads the shipped winter model');
  assert.ok(Math.abs(report.asset.scale - .92 * .92) < 1e-6, 'Clothing preserves the fitted anatomical rig scale');
  assert.ok(report.asset.height > 1.45 && report.asset.height < 1.75, 'Measured dressed player retains the cabin-sized proportions');
  const winterMeshes = report.asset.meshes.filter(mesh => mesh.winter);
  for (const part of ['coat|parka', 'trouser', 'boot', 'scarf', 'beanie', 'cuff', 'seam', 'hardware'])
    assert.ok(winterMeshes.some(mesh => new RegExp(part, 'i').test(mesh.label)), `${part} detail is present in the loaded outfit`);
  assert.ok(winterMeshes.filter(mesh => mesh.materials.some(material => material.textured && material.width >= 128)).length >= 4,
    'Fabric maps upload correctly for the rendered winter outfit');
  assert.ok(winterMeshes.every(mesh => mesh.bones >= 20), 'Winter garments are skinned to the articulated rig');
  const before = await advance(.2);
  for (const role of ['parka', 'gloves', 'boots'])
    assert.ok(before.at(-1).clothes[role].length >= 30, `Actual skinned ${role} vertices are tracked`);
  await page.evaluate(() => window.__winterCheck.renderCar([-3.1, 1.5, .65], [-.25, .84, -.1]));
  await screenshot('seated');

  await page.keyboard.press('e');
  assert.equal((await snapshot()).mode, 'exiting');
  const exit = await advance(report.asset.transitionSeconds + .15);
  report.checks.exit = compact(exit);
  assert.equal(exit.at(-1).mode, 'walking');
  assert.ok(exit.some(sample => sample.doorOpenAmount > .98), 'The fitted winter player exits through the animated open door');
  assert.ok(exit.some(sample => /exit/i.test(sample.clip)), 'The winter player uses the authored exit animation');
  assert.equal(exit.at(-1).doorOpenAmount, 0, 'The door closes after exit');
  const outside = { position: exit.at(-1).position, yaw: exit.at(-1).yaw };
  for (const [name, camera, target] of [
    ['front', [0, 1.06, 2.55], [0, .82, 0]],
    ['back', [0, 1.12, -2.55], [0, .82, 0]],
    ['head', [.35, 1.48, 1.1], [0, 1.32, 0]],
  ]) {
    await page.evaluate(({ camera, target }) => window.__winterCheck.renderPerson(camera, target), { camera, target });
    await screenshot(name);
  }

  const locomotion = {};
  for (const [name, seconds, shift] of [['walking', .8, false], ['running', .65, true]]) {
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    const samples = await advance(seconds);
    await page.keyboard.up('w'); if (shift) await page.keyboard.up('Shift');
    const motion = Object.fromEntries(['parka', 'gloves', 'boots'].map(role => [role, deformation(samples, role)]));
    locomotion[name] = { samples: compact(samples), deformationMeters: motion };
    assert.ok(samples.some(sample => new RegExp(shift ? 'run' : 'walk', 'i').test(sample.clip)), `${name} uses its authored animation`);
    assert.ok(samples.some(sample => sample.speed > (shift ? 2.3 : .5)), `${name} responds to normal keyboard input`);
    for (const role of ['parka', 'gloves', 'boots'])
      assert.ok(motion[role] > .008, `Skinned ${role} visibly deform during ${name}`);
    if (shift) {
      await page.evaluate(() => window.__winterCheck.renderPerson([1.5, 1.03, 2.1], [0, .8, 0]));
      await screenshot('running');
    }
  }
  report.checks.locomotion = locomotion;
  await page.evaluate(outside => {
    const p = document.querySelector('canvas').__drive.person;
    p.position.set(...outside.position); p.yaw = outside.yaw; p.velocity.set(0, 0, 0);
  }, outside);
  await advance(.1);
  assert.equal((await snapshot()).mode, 'walking');
  await page.keyboard.press('e');
  assert.equal((await snapshot()).mode, 'entering');
  const entering = await advance(report.asset.transitionSeconds * .6);
  await page.evaluate(() => window.__winterCheck.renderCar([-3.1, 1.65, 1], [-.6, .85, .1]));
  await screenshot('entering');
  entering.push(...await advance(report.asset.transitionSeconds * .4 + .2));
  report.checks.entry = compact(entering);
  assert.equal(entering.at(-1).mode, 'driving');
  assert.match(entering.at(-1).clip, /seated/i);
  assert.ok(entering.some(sample => sample.doorOpenAmount > .98), 'Re-entry opens the animated door');
  assert.equal(entering.at(-1).doorOpenAmount, 0, 'Re-entry finishes with the door closed');
  assert.ok(entering.every((sample, index) => index === 0 ||
    Math.hypot(...sample.position.map((coordinate, axis) => coordinate - entering[index - 1].position[axis])) < .5),
  'The dressed player follows the continuous cabin-entry path');

  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.setCameraView('driver'); g.updateCamera(0, true); g.composer.render();
  });
  await advance(.2);
  const firstPerson = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { view: g.cameraView, visibility: g.person.diagnostics.driverVisibility,
      headwear: window.__winterCheck.headTriangles(),
      gloves: window.__winterCheck.visiblePixels('gloves'), parka: window.__winterCheck.visiblePixels('parka'),
      contextLost: g.renderer.getContext().isContextLost() };
  });
  report.checks.firstPerson = firstPerson;
  assert.equal(firstPerson.view, 'driver');
  assert.equal(firstPerson.visibility.driverView, true);
  assert.ok(firstPerson.headwear.every(mesh => mesh.headTriangles === 0),
    'All head and neck weighted winter triangles are cleared away from the cockpit camera');
  assert.ok(firstPerson.headwear.filter(mesh => /beanie/i.test(mesh.label)).every(mesh => mesh.triangles === 0),
    'The winter cap cannot surround or obstruct the cockpit camera');
  assert.ok(firstPerson.gloves.lowerPixels > 80, 'Textured articulated winter gloves are visible at the wheel');
  assert.ok(firstPerson.parka.lowerPixels > 80, 'The padded winter torso and sleeves remain visible in first person');
  assert.equal(firstPerson.contextLost, false, 'Winter materials render without a lost WebGL context');
  await screenshot('cockpit');
  await page.keyboard.press('c');
  await advance(.1);
  report.checks.restoredOutfit = await page.evaluate(() => ({
    visibility: document.querySelector('canvas').__drive.person.diagnostics.driverVisibility,
    meshes: window.__winterCheck.headTriangles(),
  }));
  assert.equal(report.checks.restoredOutfit.visibility.driverView, false);
  assert.ok(report.checks.restoredOutfit.meshes.some(mesh => /beanie/i.test(mesh.label) && mesh.triangles > 0),
    'The complete beanie is restored outside first person');
  assert.ok(report.checks.restoredOutfit.meshes.some(mesh => /scarf/i.test(mesh.label) && mesh.triangles > 0),
    'The detailed scarf is restored outside first person');
  assert.deepEqual(errors, [], 'No browser, loader or shader errors during the winter outfit checks');
  report.runtimeErrors = errors; report.passed = true;
  console.log('Winter player asset, clothing animation, entry/exit, and first-person visibility checks passed');
} catch (error) {
  report.passed = false; report.failure = error.stack || error.message; report.runtimeErrors = errors;
  await page.screenshot({ path: 'artifacts/winter-player-verification-failure.png' }).catch(() => {});
  throw error;
} finally {
  await writeFile('artifacts/winter-player-verification.json', JSON.stringify(report, null, 2));
  await browser.close();
}
