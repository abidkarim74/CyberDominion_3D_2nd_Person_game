import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Check the actual exported asset and the real E/W/Shift game controls. The
// deterministic frame clock avoids turning visual QA into a GPU benchmark.
const directory = 'artifacts/realistic-player';
await mkdir(directory, { recursive: true });
const report = { url: process.env.GAME_URL || 'http://localhost:3000/', checks: {}, errors: [] };
const readGlb = async path => {
  const bytes = await readFile(path);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${path} is a GLB`);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, `${path} contains its glTF JSON chunk`);
  return { bytes, gltf: JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) };
};
const jointNames = gltf => [...new Set(gltf.skins.flatMap(skin => skin.joints.map(index => gltf.nodes[index].name)))].sort();
const clips = ['EnterCar', 'ExitCar', 'Idle', 'Run', 'Seated', 'Walk'];
const duration = (gltf, clip) => Math.max(...clip.samplers.map(sampler => gltf.accessors[sampler.input].max[0]));
let browser, page;

try {
  const source = await readGlb('public/models/person/person.glb');
  const { bytes, gltf } = await readGlb('public/models/person/person-realistic.glb');
  assert.deepEqual(gltf.animations.map(clip => clip.name).sort(), clips, 'The new model ships all six gameplay clips');
  assert.deepEqual(jointNames(gltf), jointNames(source.gltf), 'The detailed model retains the complete compatible rig');
  for (const clip of source.gltf.animations) {
    const retained = gltf.animations.find(candidate => candidate.name === clip.name);
    assert.ok(Math.abs(duration(source.gltf, clip) - duration(gltf, retained)) < .035,
      `${clip.name} keeps its authored duration`);
  }
  assert.ok(![...gltf.nodes, ...gltf.meshes, ...gltf.materials].some(part => /hair/i.test(part.name ?? '')),
    'The original hairstyle is removed to match the shaved reference');
  const scannedMaterials = gltf.materials.map((material, index) => ({ material, index }))
    .filter(({ material }) => /scanned.*skin|skin.*scanned/i.test(material.name ?? ''));
  assert.ok(scannedMaterials.length > 0, 'A dedicated scanned facial skin material is exported');
  for (const { material } of scannedMaterials) {
    for (const texture of [material.pbrMetallicRoughness?.baseColorTexture, material.normalTexture]) {
      assert.ok(texture, 'Scanned skin includes both albedo and normal maps');
      const image = gltf.images[gltf.textures[texture.index].source];
      assert.ok(Number.isInteger(image.bufferView) && !image.uri, 'Scanned skin maps are embedded in the GLB');
      assert.ok(gltf.bufferViews[image.bufferView].byteLength > 10000, 'Embedded facial maps contain meaningful image data');
    }
  }
  const headNodes = gltf.nodes.filter(node => Number.isInteger(node.mesh) && gltf.meshes[node.mesh].primitives
    .some(primitive => scannedMaterials.some(({ index }) => index === primitive.material)));
  assert.ok(headNodes.length > 0 && headNodes.every(node => Number.isInteger(node.skin)),
    'The scanned head is skinned to the gameplay skeleton');
  const headVertices = headNodes.reduce((sum, node) => sum + gltf.meshes[node.mesh].primitives
    .reduce((count, primitive) => count + gltf.accessors[primitive.attributes.POSITION].count, 0), 0);
  assert.ok(headVertices > 8000, 'The facial silhouette uses detailed scan geometry');
  const triangles = gltf.meshes.flatMap(mesh => mesh.primitives).reduce((sum, primitive) =>
    sum + (gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3), 0);
  assert.ok(triangles > 20000 && triangles < 300000, 'The detailed player stays within a practical realtime triangle budget');
  assert.ok(gltf.materials.length < 30, 'The player keeps a bounded material count');
  report.glb = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    clips, bones: jointNames(gltf).length, headVertices, triangles, materials: gltf.materials.map(material => material.name),
    embeddedImages: gltf.images.filter(image => Number.isInteger(image.bufferView)).length };
  console.log(`Realistic GLB: ${triangles} triangles, ${headVertices} head vertices, compatible rig and embedded scan maps verified`);

  browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(report.url, { timeout: 90000 });
  await page.waitForFunction(() => {
    const person = document.querySelector('canvas')?.__drive?.person;
    return person?.ready || person?.telemetry.loadingError;
  });
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame); game.qualityWarmup = Infinity;
  });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive, person = game.person;
    cancelAnimationFrame(game.animationFrame); game.reset(); game.active = true; game.qualityWarmup = Infinity;
    game.setGraphicsQuality('high');
    const point = person.position.clone(), meshes = [], bones = [];
    const materials = mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    person.root.traverse(object => {
      if (object.isSkinnedMesh) meshes.push(object);
      if (object.isBone && /Head$|Spine2$|LeftHand$|RightHand$|LeftFoot$|RightFoot$/.test(object.name)) bones.push(object);
    });
    const sample = () => ({ ...person.diagnostics, clip: person.activeAction?.getClip().name,
      poseTime: person.activeAction?.time, position: person.position.toArray(), yaw: person.yaw,
      bones: bones.flatMap(bone => bone.quaternion.toArray()), doorAngle: game.carRig.driverDoor.rotation.y,
      blink: meshes.filter(mesh => mesh.morphTargetDictionary?.Blink !== undefined)
        .map(mesh => ({ name: mesh.name, weight: mesh.morphTargetInfluences[mesh.morphTargetDictionary.Blink] })),
      camera: game.cameraView });
    window.__realisticPlayerCheck = {
      sample,
      meshes: () => meshes.map(mesh => ({ name: mesh.name, visible: mesh.visible,
        vertices: mesh.geometry.attributes.position.count,
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
        bones: mesh.skeleton.bones.length,
        materials: materials(mesh).map(material => ({ name: material.name,
          albedo: material.map ? { width: material.map.image.width, height: material.map.image.height } : null,
          normal: material.normalMap ? { width: material.normalMap.image.width, height: material.normalMap.image.height } : null,
          roughness: material.roughness, metalness: material.metalness })) })),
      advance(seconds) {
        const samples = [], render = game.composer.render;
        cancelAnimationFrame(game.animationFrame);
        if (!game.previousTime) game.previousTime = performance.now();
        game.composer.render = () => {};
        try {
          for (let remaining = seconds; remaining > .000001; remaining -= 1 / 60) {
            game.frame(game.previousTime + Math.min(1 / 60, remaining) * 1000);
            cancelAnimationFrame(game.animationFrame); samples.push(sample());
          }
        } finally { game.composer.render = render; }
        return samples;
      },
      renderPerson(closeup = false) {
        person.setDriverView(false); game.scene.updateMatrixWorld(true);
        const head = bones.find(bone => /Head$/.test(bone.name));
        const target = closeup ? person.root.worldToLocal(head.getWorldPosition(point)).clone() : point.set(0, .79, 0).clone();
        if (closeup) target.y += .065;
        const camera = target.clone(); camera.x += closeup ? .06 : .10; camera.y += closeup ? .015 : .15;
        camera.z += closeup ? .62 : 3.25;
        game.camera.position.copy(person.root.localToWorld(camera));
        game.camera.lookAt(person.root.localToWorld(target));
        game.camera.near = .025; game.camera.fov = closeup ? 36 : 39; game.camera.updateProjectionMatrix();
        game.scene.updateMatrixWorld(true);
        game.composer.render(); return game.renderer.domElement.toDataURL('image/png');
      },
      renderSeated() {
        game.carRig.driverDoor.rotation.y = -.96;
        game.camera.position.copy(game.carPosition).add(point.set(-2.6, 1.30, .6));
        game.camera.lookAt(game.carPosition.clone().add(point.set(-.35, .8, -.15)));
        game.camera.near = .025; game.camera.fov = 40; game.camera.updateProjectionMatrix();
        game.scene.updateMatrixWorld(true);
        game.composer.render(); return game.renderer.domElement.toDataURL('image/png');
      },
    };
  });
  const advance = seconds => page.evaluate(seconds => window.__realisticPlayerCheck.advance(seconds), seconds);
  const sample = () => page.evaluate(() => window.__realisticPlayerCheck.sample());
  const compact = samples => samples.map(({ bones, ...state }) => state);
  const boneMotion = samples => Math.max(...samples.flatMap(state => state.bones.map((value, index) =>
    Math.abs(value - samples[0].bones[index]))));
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  const capture = async (name, method, argument) => {
    const data=await page.evaluate(({method,argument})=>window.__realisticPlayerCheck[method](argument),{method,argument});
    await writeFile(`${directory}/${name}.png`,Buffer.from(data.split(',')[1],'base64'));
  };

  report.asset = await sample(); report.meshes = await page.evaluate(() => window.__realisticPlayerCheck.meshes());
  console.log(`Browser loaded ${report.asset.asset}`);
  assert.equal(report.asset.ready, true, report.asset.loadingError || 'The realistic character loads');
  assert.match(report.asset.asset, /\/models\/person\/person-realistic\.glb(?:\?|$)/, 'Gameplay selects the new detailed player asset');
  assert.deepEqual(report.asset.animations.toSorted(), clips, 'All gameplay animations load in the browser');
  const loadedHead = report.meshes.filter(mesh => mesh.materials.some(material => /scanned.*skin|skin.*scanned/i.test(material.name)));
  assert.ok(loadedHead.length > 0 && loadedHead.every(mesh => mesh.bones >= 20), 'The scanned face uploads as a skinned mesh');
  assert.ok(loadedHead.flatMap(mesh => mesh.materials).some(material =>
    material.albedo?.width >= 1024 && material.normal?.width >= 1024), 'High resolution facial albedo and pore normals upload successfully');
  assert.ok(!report.meshes.some(mesh => /hair/i.test(mesh.name)), 'The browser has no original hair mesh');
  report.checks.seated = compact(await advance(.5));
  assert.equal(report.checks.seated.at(-1).mode, 'driving');
  await capture('seated-driver','renderSeated');
  await page.evaluate(() => { document.querySelector('canvas').__drive.carRig.driverDoor.rotation.y = 0; });

  await page.keyboard.press('e');
  assert.equal((await sample()).mode, 'exiting', 'E starts the normal exit');
  const exit = await advance(report.asset.transitionSeconds + .2);
  report.checks.exit = compact(exit);
  assert.ok(exit.some(state => /exit/i.test(state.clip)) && exit.some(state => state.doorOpenAmount > .98),
    'The authored exit moves through the open door');
  assert.equal(exit.at(-1).mode, 'walking');
  assert.equal(exit.at(-1).doorOpenAmount, 0);
  console.log('Actual E-key exit and door animation verified');
  // The default door position can put the portrait camera through the parked
  // car. Seed an empty stretch of this same road before visual/movement QA.
  await page.evaluate(() => {
    const game=document.querySelector('canvas').__drive,person=game.person;
    person.position.set(-22,person.getGroundHeight(-22,-60),-60);
    person.velocity.set(0,0,0);game.personCameraYaw=0;person.cameraYaw=0;
  });
  const idle = await advance(8);
  report.checks.idle = { ...compact(idle).at(-1), boneMotion: boneMotion(idle) };
  assert.match(idle.at(-1).clip, /idle/i);
  assert.ok(report.checks.idle.boneMotion > .01, 'The detailed face and body continue moving naturally at idle');
  assert.ok(idle.every(state=>state.blink.length>=3), 'The head and both inset eyes have exported Blink morphs');
  const blinkFrame=idle.findIndex(state=>state.blink[0].weight>.8);
  assert.ok(blinkFrame>=0 && idle.slice(blinkFrame+1).some(state=>state.blink.every(part=>part.weight===0)),
    'The runtime closes the eyelids and returns to fully open eyes');
  assert.ok(idle.every(state=>state.blink.every(part=>Math.abs(part.weight-state.blink[0].weight)<1e-7)),
    'Scan eyelids, eye caps and rims blink in synchrony');
  report.checks.blink={morphMeshes:idle[0].blink.map(part=>part.name),
    maximum:Math.max(...idle.map(state=>state.blink[0].weight)),returnedOpen:true};
  console.log('Idle skeletal motion and synchronized eyelid blink verified');
  await capture('fullbody-front','renderPerson',false);
  await capture('face-closeup','renderPerson',true);

  const parked = await page.evaluate(() => document.querySelector('canvas').__drive.carPosition.toArray());
  const start = await sample();
  await page.keyboard.down('w');
  const walk = await advance(1.2);
  report.checks.walk = { ...compact(walk).at(-1), distance: distance(start.position, walk.at(-1).position), boneMotion: boneMotion(walk) };
  assert.match(walk.at(-1).clip, /walk/i);
  assert.ok(walk.at(-1).speed > 1.4 && walk.at(-1).speed < 1.9, 'W walks at a human pace');
  assert.ok(report.checks.walk.distance > 1 && report.checks.walk.boneMotion > .03, 'Walking moves both the player and actual rig');
  await capture('walking','renderPerson',false);
  await page.keyboard.down('Shift');
  const run = await advance(1);
  report.checks.run = { ...compact(run).at(-1), distance: distance(walk.at(-1).position, run.at(-1).position), boneMotion: boneMotion(run) };
  assert.match(run.at(-1).clip, /run/i);
  assert.ok(run.at(-1).speed > 3.8 && run.at(-1).speed < 4.7, 'Shift changes to running speed');
  assert.ok(report.checks.run.distance > report.checks.walk.distance && report.checks.run.boneMotion > .03,
    'Running changes actual movement and skeleton pose');
  await page.keyboard.up('Shift'); await page.keyboard.up('w');
  const stopped = await advance(1);
  report.checks.stopped = compact(stopped).at(-1);
  assert.match(stopped.at(-1).clip, /idle/i, 'Releasing movement returns to relaxed idle');
  assert.deepEqual(await page.evaluate(() => document.querySelector('canvas').__drive.carPosition.toArray()), parked,
    'On-foot movement leaves the car parked');
  report.checks.contextLost = await page.evaluate(() => document.querySelector('canvas').__drive.renderer.getContext().isContextLost());
  assert.equal(report.checks.contextLost, false);
  assert.deepEqual(report.errors, [], 'No browser runtime or shader errors');
  report.passed = true;
  console.log(JSON.stringify({ glb: report.glb, asset: report.asset.asset,
    walk: report.checks.walk.speed, run: report.checks.run.speed, errors: report.errors, passed: true }, null, 2));
} catch (error) {
  report.passed = false; report.failure = error.stack || error.message;
  if (page) await page.screenshot({ path: `${directory}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2));
  await browser?.close();
}
