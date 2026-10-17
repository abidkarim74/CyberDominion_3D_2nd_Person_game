import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const report = { url: process.env.GAME_URL || 'http://localhost:3000/' };
const errors = [];
const originalPlayerHash = '7f7514c387b5fdba20bc5f3a935ea1d49dfc2bb55345cabb0caae3b52dcc2989';
const sha256 = data => createHash('sha256').update(data).digest('hex');
function readGlb(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'glTF', 'The asset is binary glTF');
  assert.equal(buffer.readUInt32LE(4), 2, 'The asset uses glTF 2');
  const length = buffer.readUInt32LE(12);
  return JSON.parse(buffer.toString('utf8', 20, 20 + length).trim());
}
function positionHash(buffer, gltf, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex], view = gltf.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126, 'Human mesh positions use float32 coordinates');
  let offset = 12, binaryOffset = -1;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4);
    if (type === 0x004e4942) { binaryOffset = offset + 8; break; }
    offset += 8 + length;
  }
  assert.ok(binaryOffset > 0, 'The GLB embeds its mesh buffers');
  const positions = Buffer.alloc(accessor.count * 12);
  const start = binaryOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  for (let i = 0; i < accessor.count; i++)
    buffer.copy(positions, i * 12, start + i * (view.byteStride || 12), start + i * (view.byteStride || 12) + 12);
  return sha256(positions);
}
async function inspectAssets() {
  const player = await readFile('public/models/person/person.glb');
  assert.equal(sha256(player), originalPlayerHash, 'The original player model is unchanged');
  const assets = [];
  for (const name of ['parka', 'puffer', 'wool-coat', 'anorak']) {
    const file = `public/models/pedestrians/${name}.glb`, buffer = await readFile(file), gltf = readGlb(buffer);
    const primitives = gltf.meshes.flatMap(mesh => mesh.primitives);
    const triangles = primitives.reduce((sum, primitive) => sum +
      gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3, 0);
    const skinnedPrimitives = primitives.filter(primitive => primitive.attributes.JOINTS_0 !== undefined &&
      primitive.attributes.WEIGHTS_0 !== undefined).length;
    const clips = (gltf.animations || []).map(clip => clip.name);
    assert.ok(triangles > 5000, `${name} retains detailed human anatomy from the player`);
    assert.ok(gltf.skins?.length > 0 && skinnedPrimitives > 0, `${name} has a skeletal character rig`);
    assert.ok(clips.some(clip => /walk/i.test(clip)) && clips.some(clip => /idle/i.test(clip)),
      `${name} includes standing and walking animation`);
    const bodyMesh = gltf.meshes.find(mesh => /realistic face and neck|body/i.test(mesh.name));
    assert.ok(bodyMesh, `${name} retains anatomical skin derived from the player`);
    assets.push({ name, file, bytes: buffer.length, sha256: sha256(buffer), triangles,
      bodyPositionHash: positionHash(buffer, gltf, bodyMesh.primitives[0].attributes.POSITION),
      skins: gltf.skins.length, skinnedPrimitives, clips, materials: gltf.materials.map(material => material.name) });
  }
  assert.equal(new Set(assets.map(asset => asset.sha256)).size, 4, 'All four Blender assets are distinct');
  assert.equal(new Set(assets.map(asset => asset.bodyPositionHash)).size, 4,
    'Every authored variant has a different sculpted anatomical body/head');
  const manifest = JSON.parse(await readFile('public/models/pedestrians/pedestrian-manifest.json', 'utf8'));
  assert.equal(manifest.variants.length, 4, 'The export manifest records all four Blender variants');
  for (const asset of assets) {
    const variant = manifest.variants.find(variant => variant.name === asset.name);
    assert.equal(variant?.sha256, asset.sha256, `${asset.name} matches its completed Blender export manifest`);
    assert.ok(variant.walkGrounding?.length >= 11 && variant.walkGrounding.every(sample =>
      [sample.frame, sample.sourceMinZ, sample.correctionMeters, sample.groundedMinZ].every(Number.isFinite) &&
      Math.abs(sample.groundedMinZ) < 1e-5), `${asset.name} has grounded soles across its authored walking cycle`);
  }
  assert.equal(sha256(await readFile(manifest.sourcePlayerModel)), manifest.sourcePlayerSHA256,
    'The source player Blender file matches its original checksum');
  const blenderSources = [];
  for (const variant of manifest.variants) {
    const blenderSource = await readFile(variant.sourceBlend);
    const decoded = blenderSource.readUInt32LE(0) === 0xfd2fb528 ? zstdDecompressSync(blenderSource)
      : blenderSource.readUInt16LE(0) === 0x8b1f ? gunzipSync(blenderSource) : blenderSource;
    assert.equal(decoded.toString('ascii', 0, 7), 'BLENDER', `${variant.name} has an editable Blender source`);
    blenderSources.push({ file: variant.sourceBlend, bytes: blenderSource.length, sha256: sha256(blenderSource) });
  }
  return { originalPlayerHash: sha256(player), assets, manifest,
    blenderSources };
}
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  report.assets = await inspectAssets();
  console.log('Loading pedestrian city');
  await page.goto(report.url);
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.pedestrians,
    null, { timeout: 90000 });
  await page.waitForFunction(() => {
    const g = document.querySelector('canvas')?.__drive;
    return g?.pedestrians.renderer.diagnostics.ready && g.person.ready;
  }, null, { timeout: 90000 });
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.qualityWarmup = Infinity;
  });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click({ noWaitAfter: true });
  await page.evaluate(() => cancelAnimationFrame(document.querySelector('canvas').__drive.animationFrame));

  report.routes = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, crowd = g.pedestrians;
    const blocks = new Set(), populatedBlocks = new Set(), unsafe = [], offFootpath = [];
    const extents = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    let segments = 0, invalidDistances = 0;
    // Test entire segments, not only sampled points: thin street furniture can
    // otherwise be missed even when both ends of a route are clear.
    const intersects = (a, b, box) => {
      const pad = .285 - 1e-6;
      let enter = 0, leave = 1;
      for (const axis of ['x', 'z']) {
        const half = (axis === 'x' ? box.hx : box.hz) + pad;
        const min = box[axis] - half, max = box[axis] + half, delta = b[axis] - a[axis];
        if (Math.abs(delta) < 1e-10) { if (a[axis] <= min || a[axis] >= max) return false; }
        else {
          const t0 = (min - a[axis]) / delta, t1 = (max - a[axis]) / delta;
          enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1));
          if (enter >= leave) return false;
        }
      }
      return enter < leave;
    };
    for (const [index, route] of crowd.routes.entries()) {
      blocks.add(`${route.blockX},${route.blockZ}`);
      if (!Number.isFinite(route.length) || route.length < 7 || route.points.length < 2) invalidDistances++;
      for (let i = 0; i < route.points.length; i++) {
        const point = route.points[i];
        extents.minX = Math.min(extents.minX, point.x); extents.maxX = Math.max(extents.maxX, point.x);
        extents.minZ = Math.min(extents.minZ, point.z); extents.maxZ = Math.max(extents.maxZ, point.z);
        const localX = Math.abs(point.x - route.blockX), localZ = Math.abs(point.z - route.blockZ);
        if (Math.max(localX, localZ) > 12.69001 || Math.max(localX, localZ) < 12.68999) {
          if (offFootpath.length < 8) offFootpath.push({ index, point, blockX: route.blockX, blockZ: route.blockZ });
        }
        if (!Number.isFinite(point.distance) || (i > 0 && point.distance <= route.points[i - 1].distance)) invalidDistances++;
        if (i === 0) continue;
        const a = route.points[i - 1], b = point; segments++;
        for (const box of g.collisionWorld.query(a, b)) {
          if ((box.maxY ?? Infinity) <= .45 || (box.minY ?? 0) >= 2.4) continue;
          if (intersects(a, b, box) && unsafe.length < 8) unsafe.push({ index, a, b, collider: box });
        }
      }
      if (Math.abs(route.points.at(-1).distance - route.length) > 1e-5) invalidDistances++;
    }
    for (const person of crowd.people) populatedBlocks.add(`${person.route.blockX},${person.route.blockZ}`);
    return { count: crowd.routes.length, blocks: blocks.size, populatedBlocks: populatedBlocks.size,
      segments, invalidDistances, unsafe, offFootpath, extents };
  });
  assert.equal(report.routes.blocks, 289, 'Footpaths cover every city block');
  assert.equal(report.routes.populatedBlocks, report.routes.blocks, 'Every block has pedestrians');
  assert.ok(report.routes.extents.minX < -350 && report.routes.extents.maxX > 350 &&
    report.routes.extents.minZ < -350 && report.routes.extents.maxZ > 350, 'Pedestrians cover every city boundary');
  assert.deepEqual(report.routes.unsafe, [], 'Every complete route clears building walls and street furniture');
  assert.deepEqual(report.routes.offFootpath, [], 'Routes stay inside the sidewalk slabs');
  assert.equal(report.routes.invalidDistances, 0, 'Routes have finite, increasing arc lengths');

  report.appearances = await page.evaluate(() => {
    const people = document.querySelector('canvas').__drive.pedestrians.people;
    const variants = {};
    for (const person of people) for (const [key, value] of Object.entries(person.appearance)) {
      (variants[key] ||= new Set()).add(JSON.stringify(value));
    }
    return { population: people.length,
      signatures: new Set(people.map(person => person.appearance.signature)).size,
      variants: Object.fromEntries(Object.entries(variants).map(([key, values]) => [key, values.size])),
      winterDressed: people.every(({ appearance: a }) =>
        ['parka', 'puffer', 'wool-coat', 'anorak'].includes(a.outerwear) &&
        ['beanie', 'none', 'trapper-cap'].includes(a.headwear) &&
        [a.coat, a.scarf, a.trousers, a.boots].every(Number.isFinite)),
      examples: people.slice(0, 8).map(person => person.appearance) };
  });
  assert.ok(report.appearances.population >= report.routes.blocks, 'The whole city has a resident population');
  assert.equal(report.appearances.signatures, report.appearances.population, 'Every pedestrian has a unique appearance');
  assert.ok(Object.entries(report.appearances.variants).filter(([key, count]) => key !== 'signature' && count >= 3).length >= 5,
    'Heads, clothing, and accessories vary across many independent traits');
  assert.equal(report.appearances.winterDressed, true, 'Everyone wears winter outerwear, scarves, trousers, and boots');
  assert.equal(report.appearances.variants.outerwear, 4, 'All four winter coat silhouettes are represented');
  assert.ok(report.appearances.variants.headwear >= 3, 'Authored winter hats and uncovered hairstyles vary');
  assert.ok(report.appearances.variants.skin >= 4 && report.appearances.variants.hair >= 4 && report.appearances.variants.face > 100,
    'Head shape, hair, and skin vary throughout the crowd');

  console.log('Checking walking, route clearance, pause, and rendering budgets');
  report.walking = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, crowd = g.pedestrians;
    const travel = crowd.people.map(() => 0), previous = crowd.people.map(person => ({ x: person.x, z: person.z }));
    let nonFinite = 0, offFootpath = 0, overlaps = 0, farFromRoute = 0;
    const overlapExamples = [];
    const focus = { x: 0, z: 0 };
    for (let tick = 0; tick < 20 * 30; tick++) {
      crowd.update(1 / 30, focus, 'high');
      crowd.people.forEach((person, index) => {
        travel[index] += Math.hypot(person.x - previous[index].x, person.z - previous[index].z);
        previous[index] = { x: person.x, z: person.z };
        if (![person.x, person.z, person.yaw, person.progress, person.phase].every(Number.isFinite)) nonFinite++;
        if (tick % 15 !== 0) return;
        if (Math.max(Math.abs(person.x - person.route.blockX), Math.abs(person.z - person.route.blockZ)) > 12.69001) offFootpath++;
        let nearest = Infinity;
        for (let i = 1; i < person.route.points.length; i++) {
          const a = person.route.points[i - 1], b = person.route.points[i], dx = b.x - a.x, dz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((person.x - a.x) * dx + (person.z - a.z) * dz) / (dx * dx + dz * dz)));
          nearest = Math.min(nearest, Math.hypot(person.x - a.x - t * dx, person.z - a.z - t * dz));
        }
        if (nearest > 1e-4) farFromRoute++;
        for (const box of g.collisionWorld.query(person)) {
          if ((box.maxY ?? Infinity) <= .45 || (box.minY ?? 0) >= 2.4) continue;
          if (Math.abs(person.x - box.x) < box.hx + .285 - 1e-6 && Math.abs(person.z - box.z) < box.hz + .285 - 1e-6) {
            overlaps++; if (overlapExamples.length < 5) overlapExamples.push({ id: person.id, x: person.x, z: person.z, collider: box });
          }
        }
      });
    }
    const paused = crowd.people.map(p => [p.x, p.z, p.progress, p.phase, p.yaw]);
    for (let i = 0; i < 60; i++) crowd.update(0, focus, 'high');
    const pausedDrift = Math.max(...crowd.people.flatMap((p, i) =>
      [p.x, p.z, p.progress, p.phase, p.yaw].map((value, j) => Math.abs(value - paused[i][j]))));
    return { nonFinite, offFootpath, overlaps, overlapExamples, farFromRoute, pausedDrift,
      minimumTravel: Math.min(...travel), maximumTravel: Math.max(...travel),
      averageTravel: travel.reduce((sum, value) => sum + value, 0) / travel.length };
  });
  assert.equal(report.walking.nonFinite, 0, 'All pedestrian state stays finite');
  assert.equal(report.walking.offFootpath, 0, 'Walking stays on footpaths through corners and turnarounds');
  assert.equal(report.walking.farFromRoute, 0, 'Every walker follows the safe route continuously');
  assert.equal(report.walking.overlaps, 0, 'Walking does not enter buildings or furniture');
  assert.ok(report.walking.minimumTravel > 5, 'Every pedestrian walks through the city');
  assert.equal(report.walking.pausedDrift, 0, 'Paused updates preserve position and animated phase');

  report.yielding = await page.evaluate(() => {
    const crowd = document.querySelector('canvas').__drive.pedestrians, person = crowd.people[0];
    const focus = { x: person.x, z: person.z }, before = person.progress;
    const blocker = { x: person.x, z: person.z, yaw: 0, hx: 1.05, hz: 2.65 };
    for (let tick = 0; tick < 30; tick++) crowd.update(1 / 30, focus, 'high', [blocker]);
    const blockedProgress = person.progress, blockedSpeed = person.walkingSpeed;
    for (let tick = 0; tick < 90; tick++) crowd.update(1 / 30, focus, 'high');
    return { blockedAdvance: blockedProgress - before, blockedSpeed,
      resumed: Math.abs(person.progress - blockedProgress) > .3 };
  });
  assert.equal(report.yielding.blockedAdvance, 0, 'Pedestrians yield to a car obstructing the pavement');
  assert.equal(report.yielding.blockedSpeed, 0, 'Yielding also stops the walking animation');
  assert.equal(report.yielding.resumed, true, 'Pedestrians resume when the pavement clears');

  report.frameIntegration = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, crowd = g.pedestrians;
    const render = g.composer.render, active = g.active;
    // Exercise the actual frame path with a deterministic clock. Rendering is
    // verified in the captures below rather than once for every simulation tick.
    g.composer.render = () => {}; g.previousTime = performance.now(); g.active = true;
    let before = crowd.people.map(p => p.progress);
    for (let tick = 0; tick < 20; tick++) { g.frame(g.previousTime + 50); cancelAnimationFrame(g.animationFrame); }
    const moving = crowd.people.filter((p, i) => p.progress !== before[i]).length;
    g.active = false; before = crowd.people.map(p => p.progress);
    for (let tick = 0; tick < 10; tick++) { g.frame(g.previousTime + 50); cancelAnimationFrame(g.animationFrame); }
    const paused = crowd.people.filter((p, i) => p.progress !== before[i]).length;
    g.composer.render = render; g.active = active;
    return { moving, paused, population: crowd.people.length };
  });
  assert.ok(report.frameIntegration.moving > report.frameIntegration.population * .8, 'The real game loop advances city pedestrians');
  assert.equal(report.frameIntegration.paused, 0, 'The real pause path freezes city pedestrians');

  report.rendering = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, crowd = g.pedestrians;
    const foci = [{ x: 0, z: 0 }, { x: -352, z: -352 }, { x: 352, z: -352 }, { x: -352, z: 352 }, { x: 352, z: 352 }];
    const budgets = [];
    for (let pass = 0; pass < 3; pass++) for (const focus of foci) {
      crowd.update(0, focus, 'high');
      const high = { ...crowd.diagnostics, renderer: { ...crowd.renderer.diagnostics } };
      crowd.update(0, focus, 'low');
      const low = { ...crowd.diagnostics, renderer: { ...crowd.renderer.diagnostics } };
      budgets.push({ pass, focus, high, low });
    }
    const meshes = [], geometries = new Set();
    crowd.renderer.root.traverse(object => {
      if (!object.isMesh) return;
      geometries.add(object.geometry.uuid);
      meshes.push({ name: object.name, skinned: !!object.isSkinnedMesh,
        dynamic: !!object.userData.dynamic, pedestrian: !!object.userData.pedestrian,
        staticArchitecture: !!(object.userData.cityBounds || object.userData.cityInstanceCells || object.userData.cityMaterialKey),
        autoUpdate: object.matrixWorldAutoUpdate,
        triangles: (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 });
    });
    return { budgets, meshes, sharedGeometries: geometries.size, diagnostics: crowd.renderer.diagnostics,
      player: g.person.diagnostics,
      heights: { min: Math.min(...crowd.people.map(person => person.appearance.height)),
        max: Math.max(...crowd.people.map(person => person.appearance.height)) } };
  });
  for (const budget of report.rendering.budgets) {
    assert.ok(budget.high.visible > 0 && budget.low.visible > 0, 'Every city district renders pedestrians');
    assert.ok(budget.high.visible <= budget.high.renderCapacity && budget.low.visible <= budget.low.renderCapacity,
      'The visible crowd respects its rendering budget');
    assert.ok(budget.low.visible <= budget.high.visible, 'Low quality reduces the crowd rendering budget');
    assert.ok(budget.high.renderer.poolSize <= budget.high.renderer.capacity,
      'Travel between districts keeps the model pool bounded');
    assert.equal(budget.high.renderer.skeletonCount, budget.high.renderer.poolSize,
      'Every pooled person reuses one skeletal palette across its clothing and skin meshes');
    assert.ok(budget.high.renderer.ready && !budget.high.renderer.loadingError,
      'All Blender character assets load successfully');
  }
  assert.equal(report.rendering.diagnostics.templateCount, 4, 'All four Blender variants are loaded');
  assert.ok(report.rendering.meshes.some(mesh => mesh.skinned && mesh.triangles > 5000),
    'The rendered crowd uses detailed skinned human meshes');
  assert.ok(report.rendering.meshes.every(mesh => mesh.dynamic && mesh.pedestrian && !mesh.staticArchitecture && mesh.autoUpdate),
    'Animated human meshes remain outside static architecture batching and culling');
  assert.ok(report.rendering.sharedGeometries < report.rendering.meshes.length,
    'Pooled characters share geometry instead of duplicating model buffers');
  assert.ok(report.rendering.heights.min >= .94 && report.rendering.heights.max <= 1.09,
    'Every resident uses a natural height relative to the player');

  report.persistentIdentity = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, renderer = g.pedestrians.renderer;
    const people = g.pedestrians.people.filter(person => person.appearance.outerwear === 'parka').slice(0, 2);
    const render = order => {
      renderer.beginFrame();
      order.forEach((person, index) => renderer.set(index, person.appearance, person.x, person.groundY,
        person.z, person.yaw, person.phase, person.walkingSpeed, 100));
      renderer.endFrame();
      return people.map(person => {
        const root = renderer.root.children.find(root => root.visible && root.userData.pedestrianId === person.appearance.seed);
        const coatColors = [], skeletons = new Set(), geometries = new Set();
        root.traverse(mesh => {
          if (!mesh.isMesh) return;
          geometries.add(mesh.geometry.uuid);
          if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton.uuid);
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            if (/coat/i.test(material.name)) coatColors.push(material.color.getHex());
        });
        return { id: person.appearance.seed, uuid: root.uuid, expectedCoat: person.appearance.coat,
          coatColors, skeletons: [...skeletons], geometries: [...geometries] };
      });
    };
    return { before: render(people), reordered: render([...people].reverse()) };
  });
  for (const [index, actor] of report.persistentIdentity.before.entries()) {
    assert.equal(actor.uuid, report.persistentIdentity.reordered[index].uuid,
      'Distance sorting retains a resident\'s actor and animation state');
    assert.ok(actor.coatColors.length > 0 && actor.coatColors.every(color => color === actor.expectedCoat),
      'Each visible coat uses its resident\'s independent material tint');
  }
  assert.notEqual(report.persistentIdentity.before[0].expectedCoat, report.persistentIdentity.before[1].expectedCoat,
    'The material check compares different clothing colors');
  assert.ok(report.persistentIdentity.before[0].skeletons.every(uuid =>
    !report.persistentIdentity.before[1].skeletons.includes(uuid)), 'Two residents never share mutable skeletons');
  assert.deepEqual(report.persistentIdentity.before[0].geometries, report.persistentIdentity.before[1].geometries,
    'Residents of the same authored variant share immutable mesh geometry');

  report.skeletalMotion = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, renderer = g.pedestrians.renderer;
    const person = g.pedestrians.people[0];
    const setPose = (phase, speed, time) => {
      renderer.beginFrame();
      renderer.set(0, person.appearance, person.x, person.groundY, person.z, person.yaw, phase, speed, time);
      renderer.endFrame();
      const root = renderer.root.children.find(root => root.visible && root.userData.pedestrianId === person.appearance.seed);
      const pose = [];
      root.traverse(object => { if (object.isBone) pose.push(...object.position.toArray(), ...object.quaternion.toArray()); });
      return pose;
    };
    const before = setPose(0, 1, 0), moving = setPose(Math.PI / 2, 1, .5);
    const paused = setPose(Math.PI / 2, 1, .5);
    let idle;
    for (let tick = 1; tick <= 24; tick++) idle = setPose(Math.PI / 2, 0, .5 + tick / 30);
    const idlePaused = setPose(Math.PI / 2, 0, 1.3);
    const difference = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
    return { boneValues: before.length, walkDifference: difference(before, moving),
      pausedDrift: difference(moving, paused), yieldingPoseDifference: difference(moving, idle),
      yieldingDrift: difference(idle, idlePaused) };
  });
  assert.ok(report.skeletalMotion.boneValues > 50 && report.skeletalMotion.walkDifference > .01,
    'Walking animates the imported skeleton');
  assert.equal(report.skeletalMotion.pausedDrift, 0, 'Paused frames preserve the actual skeletal pose');
  assert.ok(report.skeletalMotion.yieldingPoseDifference > .01, 'Yielding switches to a standing pose');
  assert.equal(report.skeletalMotion.yieldingDrift, 0, 'A paused yielding character preserves its standing pose');

  report.walkGrounding = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, renderer = g.pedestrians.renderer;
    const person = g.pedestrians.people[0];
    const ground = Math.max(.24, g.roadSnow.sample(person.x, person.z).height);
    const samples = [];
    for (const [index, phase] of [0, Math.PI / 2, Math.PI, Math.PI * 1.5].entries()) {
      renderer.beginFrame();
      renderer.set(0, { ...person.appearance, signature: `${person.appearance.signature}/grounding` },
        person.x, ground, person.z, person.yaw, phase, 1, 200 + index);
      renderer.endFrame();
      const root = renderer.root.children.find(root => root.visible && root.userData.pedestrianId === person.appearance.seed);
      root.updateWorldMatrix(true, false); root.updateMatrixWorld(true);
      const vertex = g.camera.position.clone();
      let minimumY = Infinity, vertices = 0;
      root.traverse(mesh => {
        if (!mesh.isMesh || !(Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          .some(material => /boots/i.test(material.name))) return;
        mesh.skeleton?.update();
        for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
          mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
          minimumY = Math.min(minimumY, vertex.y); vertices++;
        }
      });
      samples.push({ phase, vertices, minimumY, ground, contactOffset: minimumY - ground });
    }
    return samples;
  });
  assert.ok(report.walkGrounding.every(sample => sample.vertices > 1000 && sample.contactOffset >= -.015 && sample.contactOffset <= .035),
    'Actual animated boot soles remain in contact with the snow through the walking cycle');

  console.log('Capturing the player and four Blender variants on the same pavement');
  report.comparison = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, crowd = g.pedestrians;
    const variants = ['parka', 'puffer', 'wool-coat', 'anorak'];
    const people = variants.map(variant => crowd.people.find(person => person.appearance.outerwear === variant));
    const anchor = [...crowd.people].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    const lx = anchor.x - anchor.route.blockX, lz = anchor.z - anchor.route.blockZ;
    const outward = Math.abs(lx) > Math.abs(lz) ? { x: Math.sign(lx), z: 0 } : { x: 0, z: Math.sign(lz) };
    const tangent = { x: outward.z, z: -outward.x };
    const ground = Math.max(.24, g.roadSnow.sample(anchor.x, anchor.z).height);
    const yaw = Math.atan2(outward.x, outward.z);
    // Measure the posed skin, rather than broad bind-pose bounds or metadata.
    const bounds = root => {
      root.updateWorldMatrix(true, false);
      // SkinnedMesh.updateMatrixWorld also refreshes the attached bind inverse;
      // updateWorldMatrix alone leaves it at the actor's previous streamed location.
      root.updateMatrixWorld(true);
      const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
      const vertex = g.camera.position.clone();
      let vertices = 0, skinnedMeshes = 0;
      root.traverse(mesh => {
        if (!mesh.isMesh || !mesh.visible) return;
        if (mesh.isSkinnedMesh) { mesh.skeleton.update(); skinnedMeshes++; }
        const position = mesh.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
          for (const axis of ['x', 'y', 'z']) { min[axis] = Math.min(min[axis], vertex[axis]); max[axis] = Math.max(max[axis], vertex[axis]); }
        }
        vertices += position.count;
      });
      return { min, max, height: max.y - min.y, vertices, skinnedMeshes };
    };
    g.person.steeringMotion?.restore(); g.person.idleMotion?.restore(); g.person.seatMotion?.restore();
    g.person.setDriverView(false); g.person.mode = 'walking'; g.person.play('Idle', 0); g.person.mixer.update(0);
    g.person.root.visible = true; g.person.model.visible = true;
    g.person.root.rotation.set(0, yaw, 0);
    g.person.position.set(anchor.x - tangent.x * 1.7, ground, anchor.z - tangent.z * 1.7);
    const playerInitialBounds = bounds(g.person.root);
    g.person.position.y += ground - playerInitialBounds.min.y;
    const player = bounds(g.person.root);
    crowd.renderer.beginFrame();
    people.forEach((person, index) => {
      const offset = -.85 + index * .85;
      crowd.renderer.set(index, { ...person.appearance, signature: `${person.appearance.signature}/comparison` }, anchor.x + tangent.x * offset, ground,
        anchor.z + tangent.z * offset, yaw, 0, 0, 0);
    });
    crowd.renderer.endFrame();
    const actors = crowd.renderer.root.children.filter(root => root.visible && root.userData.pedestrianId !== undefined);
    const samples = actors.map(root => ({ ...root.userData, bounds: bounds(root) }));
    g.camera.fov = 44; g.camera.updateProjectionMatrix();
    g.camera.position.set(anchor.x + outward.x * 4.6 + tangent.x * .3, ground + 1.15,
      anchor.z + outward.z * 4.6 + tangent.z * .3);
    g.camera.lookAt(anchor.x, ground + .83, anchor.z); g.camera.updateMatrixWorld(true);
    g.updateCityVisibility(g.camera.position); g.scene.updateMatrixWorld(true); g.composer.render();
    window.__pedestrianCapture = { people: people.map(person => person.appearance.seed),
      anchor: { x: anchor.x, z: anchor.z }, outward, tangent, ground };
    return { player, samples, ground, contextLost: g.renderer.getContext().isContextLost() };
  });
  await page.screenshot({ path: 'artifacts/pedestrian-player-height-comparison.png' });
  report.garmentTextureNeutrality = await page.evaluate(() => {
    const renderer = document.querySelector('canvas').__drive.pedestrians.renderer;
    const samples = [];
    for (const actor of renderer.root.children.filter(root => root.visible && root.userData.pedestrianId !== undefined)) {
      const materials = new Set();
      actor.traverse(mesh => {
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          if (/coat|trousers/i.test(material.name)) materials.add(material);
      });
      for (const material of materials) {
        const image = material.map?.image;
        if (!image?.width || !image?.height) {
          samples.push({ variant: actor.userData.outerwear, material: material.name, missingTexture: true });
          continue;
        }
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data, totals = [0, 0, 0];
        let weight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] / 255;
          for (let channel = 0; channel < 3; channel++) totals[channel] += pixels[i + channel] * alpha;
          weight += alpha;
        }
        const meanRGB = totals.map(total => total / weight);
        samples.push({ variant: actor.userData.outerwear, material: material.name, pixels: weight,
          meanRGB, channelDifference: Math.max(...meanRGB) - Math.min(...meanRGB) });
      }
    }
    return samples;
  });
  assert.equal(report.garmentTextureNeutrality.length, 8, 'Each authored coat and trouser fabric has a texture check');
  assert.ok(report.garmentTextureNeutrality.every(sample => !sample.missingTexture && sample.pixels > 1000 &&
    sample.channelDifference <= 5), 'Coat and trouser texture albedo remains neutral before individual identity tints');
  assert.equal(report.comparison.samples.length, 4, 'The comparison includes every winter coat variant');
  for (const sample of report.comparison.samples) {
    assert.ok(sample.bounds.skinnedMeshes > 0 && sample.bounds.vertices > 5000,
      'The visible character contains real rigged human geometry');
    assert.ok(sample.bounds.height / report.comparison.player.height >= .92 &&
      sample.bounds.height / report.comparison.player.height <= 1.14,
    'Actual clothed characters have the same human scale as the player, including hats');
    assert.ok(Math.abs(sample.bounds.min.y - report.comparison.ground) < .06,
      'The comparison places feet on the same pavement');
  }
  report.portraits = [];
  for (let index = 0; index < 4; index++) {
    report.portraits.push(await page.evaluate(index => {
      const g = document.querySelector('canvas').__drive, capture = window.__pedestrianCapture;
      const root = g.pedestrians.renderer.root.children.find(root => root.visible &&
        root.userData.pedestrianId === capture.people[index]);
      const { outward, tangent, ground } = capture;
      g.camera.position.set(root.position.x + outward.x * 2.65 + tangent.x * .65,
        ground + 1.18, root.position.z + outward.z * 2.65 + tangent.z * .65);
      g.camera.lookAt(root.position.x, ground + 1.03, root.position.z);
      g.camera.updateMatrixWorld(true); g.updateCityVisibility(g.camera.position);
      g.scene.updateMatrixWorld(true); g.composer.render();
      return { ...root.userData, contextLost: g.renderer.getContext().isContextLost() };
    }, index));
    await page.screenshot({ path: `artifacts/pedestrian-winter-detail-${index + 1}.png` });
  }
  assert.equal(report.comparison.contextLost, false, 'WebGL remains healthy with detailed character models');
  assert.ok(report.portraits.every(portrait => !portrait.contextLost), 'Portrait rendering keeps WebGL healthy');

  report.disposal = await page.evaluate(() => {
    const crowd = document.querySelector('canvas').__drive.pedestrians, renderer = crowd.renderer;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    renderer.root.traverse(mesh => {
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
      if (mesh.skeleton?.boneTexture) textures.add(mesh.skeleton.boneTexture);
    });
    const disposed = { geometries: 0, materials: 0, textures: 0 };
    for (const [type, resources] of Object.entries({ geometries, materials, textures }))
      for (const resource of resources) resource.addEventListener('dispose', () => disposed[type]++);
    crowd.destroy();
    const once = { ...disposed };
    crowd.destroy();
    return { before: { geometries: geometries.size, materials: materials.size, textures: textures.size },
      disposed, once, parentDetached: !renderer.root.parent, children: renderer.root.children.length,
      diagnostics: renderer.diagnostics };
  });
  assert.equal(report.disposal.parentDetached, true, 'Teardown removes the crowd from the scene');
  assert.equal(report.disposal.children, 0, 'Teardown releases the pooled actors');
  assert.equal(report.disposal.diagnostics.poolSize, 0, 'Teardown empties the model pool');
  assert.equal(report.disposal.diagnostics.templateCount, 0, 'Teardown releases loaded templates');
  assert.equal(report.disposal.disposed.geometries, report.disposal.before.geometries, 'Shared character geometries dispose once');
  assert.equal(report.disposal.disposed.materials, report.disposal.before.materials, 'Character materials dispose once');
  assert.equal(report.disposal.disposed.textures, report.disposal.before.textures, 'Character textures and bone palettes dispose once');
  assert.deepEqual(report.disposal.disposed, report.disposal.once, 'Repeated teardown does not dispose resources twice');
  assert.deepEqual(errors, [], 'No browser runtime or shader errors');
  report.passed = true;
  console.log(JSON.stringify({ passed: true, population: report.appearances.population,
    blocks: report.routes.blocks, assets: report.assets.assets.map(({ name, triangles }) => ({ name, triangles })),
    playerHeight: report.comparison.player.height,
    pedestrianHeights: report.comparison.samples.map(sample => ({ variant: sample.outerwear, height: sample.bounds.height })),
    poolSize: report.rendering.diagnostics.poolSize, disposal: report.disposal.disposed,
    errors, report: 'artifacts/pedestrian-verification.json' }, null, 2));
} catch (error) {
  report.passed = false; report.failure = error.stack || error.message;
  await page.screenshot({ path: 'artifacts/pedestrian-verification-failure.png' }).catch(() => {});
  throw error;
} finally {
  report.errors = errors;
  await writeFile('artifacts/pedestrian-verification.json', JSON.stringify(report, null, 2));
  await browser.close();
}
