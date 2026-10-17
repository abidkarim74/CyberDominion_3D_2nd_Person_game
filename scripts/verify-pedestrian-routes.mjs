import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');
const layout = moduleUrl(await readFile('lib/city-layout.ts', 'utf8'));
const source = (await readFile('lib/pedestrian-routes.ts', 'utf8')).replace("'./city-layout'", JSON.stringify(layout));
const { buildPedestrianRoutes, samplePedestrianRoute, PEDESTRIAN_RADIUS, PEDESTRIAN_ROUTE_OFFSET } = await import(moduleUrl(source));

const colliders = [];
for (let ix = -8; ix <= 8; ix++) for (let iz = -8; iz <= 8; iz++) {
  const x = ix * 44, z = iz * 44;
  colliders.push({ x, z, hx: 12.24, hz: 12.24, minY: .22, maxY: 4.1, label: 'retail' });
  // The curb overlaps the shoulder envelope in plan, but its top is below the body.
  for (const side of [-1, 1]) {
    colliders.push({ x: x + side * 12.85, z, hx: .09, hz: 12.85, minY: .2, maxY: .4, label: 'curb' });
    colliders.push({ x, z: z + side * 12.85, hx: 12.85, hz: .09, minY: .2, maxY: .4, label: 'curb' });
    // Pilasters leave just enough room for the intended clothed body width.
    for (const along of [-11.1, -3.67, 3.67, 11.1]) {
      colliders.push({ x: x + along, z: z + side * 12.285, hx: .065, hz: .095, minY: .27, maxY: 3.59, label: 'pilaster' });
      colliders.push({ x: x + side * 12.285, z: z + along, hx: .095, hz: .065, minY: .27, maxY: 3.59, label: 'pilaster' });
    }
  }
  if ((ix + iz) % 2 === 0) colliders.push({ x: x + 10.48, z: z + 12.36, hx: .39, hz: .23, minY: .35, maxY: 2.27, label: 'vending' });
  if ((ix - iz) % 3 === 0) colliders.push({ x: x - 12.36, z: z + 3.57, hx: .28, hz: .28, minY: .34, maxY: 1.5, label: 'cabinet' });
}
// An obstruction across a corner must trim both adjoining path segments.
colliders.push({ x: 12.66, z: -12.66, hx: .48, hz: .6, minY: 0, maxY: 3, label: 'corner support' });
colliders.push({ x: -12.69, z: 0, hx: 1, hz: 5, minY: 4, maxY: 5, label: 'overhead canopy' });
const snapshot = JSON.stringify(colliders);
const routes = buildPedestrianRoutes(colliders);
assert.equal(JSON.stringify(colliders), snapshot, 'Route construction leaves shared colliders untouched');
assert.deepEqual(buildPedestrianRoutes(colliders), routes, 'Route generation is deterministic');
const blocks = new Set(routes.map(route => `${route.blockX},${route.blockZ}`));
assert.equal(blocks.size, 289, 'Pedestrians can walk on every city block, including all edges');
assert.ok(routes.some(route => route.closed), 'Unobstructed blocks use complete sidewalk loops');
assert.ok(routes.some(route => !route.closed), 'Furniture closes the route into safe returning runs');
let samples = 0;
const point = { x: 0, z: 0, yaw: 0 }, forward = { ...point }, backward = { ...point };
for (const route of routes) {
  const nearby = colliders.filter(collider =>
    collider.maxY > .45 && collider.minY < 2.4 &&
    Math.abs(collider.x - route.blockX) < collider.hx + 14 && Math.abs(collider.z - route.blockZ) < collider.hz + 14);
  assert.ok(route.length >= 7);
  assert.equal(route.points[0].distance, 0);
  assert.equal(route.points.at(-1).distance, route.length);
  for (let distance = -.5; distance < route.length * 2 + .5; distance += .19) {
    assert.equal(samplePedestrianRoute(route, distance, point), point, 'Sampler reuses the supplied target');
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z) && Number.isFinite(point.yaw));
    assert.ok(Math.abs(point.x - route.blockX) <= PEDESTRIAN_ROUTE_OFFSET + 1e-8);
    assert.ok(Math.abs(point.z - route.blockZ) <= PEDESTRIAN_ROUTE_OFFSET + 1e-8);
    assert.ok(Math.max(Math.abs(point.x - route.blockX), Math.abs(point.z - route.blockZ)) >= PEDESTRIAN_ROUTE_OFFSET - 1e-8,
      'Every sample remains on the actual pavement perimeter');
    for (const collider of nearby) assert.ok(
      Math.abs(point.x - collider.x) >= collider.hx + PEDESTRIAN_RADIUS - 1e-8 ||
      Math.abs(point.z - collider.z) >= collider.hz + PEDESTRIAN_RADIUS - 1e-8,
      `Body clears ${collider.label} on block ${route.blockX},${route.blockZ}`);
    samples++;
  }
  if (!route.closed) {
    samplePedestrianRoute(route, route.length * .37, forward);
    samplePedestrianRoute(route, route.length * 1.63, backward);
    assert.ok(Math.hypot(forward.x - backward.x, forward.z - backward.z) < 1e-7, 'Return trip retraces the safe sidewalk');
    assert.ok(Math.cos(forward.yaw - backward.yaw) < -.9999, 'Return trip faces the direction of travel');
  }
}
console.log(JSON.stringify({ routes: routes.length, blocks: blocks.size, loops: routes.filter(route => route.closed).length,
  shuttles: routes.filter(route => !route.closed).length, colliders: colliders.length, samples }, null, 2));
