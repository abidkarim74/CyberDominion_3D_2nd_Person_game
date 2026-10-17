import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

function moduleUrl(source, dependencies = {}) {
  let javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [specifier, replacement] of Object.entries({ three: import.meta.resolve('three'), ...dependencies })) {
    javascript = javascript.replaceAll(`from '${specifier}'`, `from '${replacement}'`);
  }
  return 'data:text/javascript;base64,' + Buffer.from(javascript).toString('base64');
}

// Geometry and raycasting need no browser, GPU, or decoded campaign artwork.
// oxlint-disable-next-line typescript/no-deprecated -- This is a geometry-only DOM replacement.
globalThis.document = { createElement() { return {
  width: 0, height: 0,
  getContext: () => new Proxy({}, { get: (_target, property) => property === 'createLinearGradient'
    ? () => ({ addColorStop() {} }) : property === 'globalAlpha' ? 1 : () => {} }),
}; } };
globalThis.Image = class { set src(_value) { this.onerror?.(); } };

const [layoutSource, screenSource, buildingSource, collisionSource, districtSource] = await Promise.all([
  'city-layout', 'city-screens', 'cyberpunk-buildings', 'city-collision', 'cyberpunk-district',
].map(name => readFile(`lib/${name}.ts`, 'utf8')));
const layoutUrl = moduleUrl(layoutSource);
const screenUrl = moduleUrl(screenSource);
const dependencies = { './city-layout': layoutUrl, './city-screens': screenUrl };
const [layout, buildings, collision, district] = await Promise.all([
  import(layoutUrl), import(moduleUrl(buildingSource, dependencies)),
  import(moduleUrl(collisionSource, dependencies)), import(moduleUrl(districtSource, dependencies)),
]);
const { RETAIL_PODIUM_HALF_SIZE: halfSize, RETAIL_PODIUM_HEIGHT: shopHeight, ROAD_STEP, ROAD_WIDTH } = layout;
const { planSkylineBuilding, makeSkylineStyles, addSkylineBuilding } = buildings;
const { collectWorldColliders, sweptEntry } = collision;
const scene = new THREE.Scene(), colliders = [], signs = new Map(), styles = makeSkylineStyles();
const blocks = new Map();
let seed = 1;
for (let ix = -8; ix <= 8; ix++) for (let iz = -8; iz <= 8; iz++) {
  const plan = planSkylineBuilding(ix * ROAD_STEP, iz * ROAD_STEP, seed++);
  addSkylineBuilding(scene, styles, colliders, plan, signs);
  const group = scene.children.at(-1);
  const podium = group.getObjectByName('Cyberpunk / solid retail podium');
  assert.ok(podium instanceof THREE.Mesh, 'Each tower has a physical retail ground floor');
  assert.ok(!podium.material.transparent, 'The retail walls are opaque');
  blocks.set(`${plan.x}|${plan.z}`, { group, podium, plan });
}

const ray = new THREE.Raycaster();
let wallRays = 0, cornerRays = 0, storefrontRays = 0;
function cast(origin, direction, object, distance = 2) {
  ray.set(origin, direction); ray.near = 0; ray.far = distance;
  return ray.intersectObject(object, true)[0];
}
function worldPoint(group, x, y, z) { return group.localToWorld(new THREE.Vector3(x, y, z)); }

// Test every generated width, depth and silhouette at every quarter turn. Rays
// sample the edges as well as the middle, so thin front panels or beveled/open
// corners cannot satisfy the street-level volume checks.
for (const { group, podium, plan } of blocks.values()) {
  for (let turn = 0; turn < 4; turn++) {
    group.rotation.y = turn * Math.PI / 2; group.updateMatrixWorld(true);
    for (let side = 0; side < 4; side++) {
      const angle = side * Math.PI / 2;
      const normal = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const tangent = new THREE.Vector3(normal.z, 0, -normal.x);
      for (const lateral of [-halfSize + .02, -11.1, 0, 11.1, halfSize - .02]) {
        for (const height of [.36, 1.6, 3.5, shopHeight - .05]) {
          const origin = new THREE.Vector3(plan.x, height, plan.z)
            .addScaledVector(normal, halfSize + .6).addScaledVector(tangent, lateral);
          const hit = cast(origin, normal.clone().negate(), podium);
          assert.ok(hit && hit.distance < .61, `Retail wall has no holes: block ${plan.seed}, rotation ${turn}, face ${side}`);
          wallRays++;
        }
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const origin = new THREE.Vector3(plan.x + sx * (halfSize + .5), 1.6, plan.z + sz * (halfSize + .5));
      const hit = cast(origin, new THREE.Vector3(-sx, 0, -sz).normalize(), podium);
      assert.ok(hit && hit.distance < .72, 'Corners close the space behind adjacent shop fronts');
      const underRoof = worldPoint(group, sx * (halfSize + .04), 3.8, sz * (halfSize + .04));
      assert.ok(cast(underRoof, new THREE.Vector3(0, 1, 0), group, .5), 'A solid roof closes the shop corner from below');
      cornerRays += 2;
    }
  }
  group.rotation.y = plan.quarterTurn * Math.PI / 2;
}
scene.updateMatrixWorld(true);
const world = collectWorldColliders(scene, colliders);

for (const { podium, plan } of blocks.values()) {
  const bounds = new THREE.Box3().setFromObject(podium);
  const lowCollider = world.query(bounds.min, bounds.max).find(solid =>
    solid.minY <= .36 && solid.maxY >= shopHeight - .05 && solid.maxY < shopHeight + .2 &&
    solid.x - solid.hx <= bounds.min.x + .001 && solid.x + solid.hx >= bounds.max.x - .001 &&
    solid.z - solid.hz <= bounds.min.z + .001 && solid.z + solid.hz >= bounds.max.z - .001);
  assert.ok(lowCollider, 'The complete shop footprint receives a collider limited to the ground floor');
  const highCorner = { x: plan.x + halfSize - .02, z: plan.z + halfSize - .02 };
  assert.ok(!world.query(highCorner).some(solid =>
    (solid.minY ?? 0) <= shopHeight + 1 && (solid.maxY ?? Infinity) >= shopHeight + 1 &&
    Math.abs(highCorner.x - solid.x) < solid.hx && Math.abs(highCorner.z - solid.z) < solid.hz),
  'The shop footprint does not create invisible walls above its roof');
  for (let side = 0; side < 4; side++) {
    const angle = side * Math.PI / 2, normal = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const tangent = new THREE.Vector3(normal.z, 0, -normal.x);
    const start = new THREE.Vector3(plan.x, 0, plan.z).addScaledVector(normal, halfSize + .46).addScaledVector(tangent, -12.7);
    const end = start.clone().addScaledVector(tangent, 25.4);
    assert.ok(!world.query(start, end).some(solid => sweptEntry(start, end, solid, .3, .3) !== null),
      'The retail walls leave a clear pedestrian-width path along the pavement');
    const roadEdge = ROAD_STEP / 2 - ROAD_WIDTH / 2;
    assert.ok(bounds.max.x < plan.x + roadEdge && bounds.max.z < plan.z + roadEdge &&
      bounds.min.x > plan.x - roadEdge && bounds.min.z > plan.z - roadEdge, 'Retail volume stays outside the road');
  }
}

district.addCyberpunkDistrict(scene);
scene.updateMatrixWorld(true);
let storefronts = 0;
scene.traverse(object => {
  if (!(object instanceof THREE.Mesh) || object.name !== 'Cyberpunk / shop storefront') return;
  storefronts++;
  let block = object.parent;
  while (block && block.name !== 'Cyberpunk mixed-use block') block = block.parent;
  const building = blocks.get(`${block.position.x}|${block.position.z}`);
  assert.ok(building, 'Every generated storefront belongs to a solid building');
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(object.matrixWorld);
  const vertices = object.geometry.getAttribute('position');
  const points = [new THREE.Vector3()];
  for (let i = 0; i < vertices.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(vertices, i));
  for (const point of points) {
    point.applyMatrix4(object.matrixWorld);
    const hit = cast(point, normal.clone().negate(), building.podium, .1);
    assert.ok(hit && hit.distance > .002 && hit.distance < .03,
      'Shop doors and window edges sit immediately in front of opaque building walls');
    storefrontRays++;
  }
});
assert.equal(storefronts, blocks.size * 4 * 3, 'All street-facing shops are checked');
console.log(JSON.stringify({ buildings: blocks.size, rotations: blocks.size * 4, storefronts,
  wallRays, cornerRays, storefrontRays, colliders: colliders.length, colliderStats: world.stats }, null, 2));
