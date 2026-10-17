import type { WorldCollider } from './city-collision';
import { ROAD_COORDS, ROAD_STEP } from './city-layout';

/** Shoulder clearance; feet stay inside the 26 m raised sidewalk slabs. */
export const PEDESTRIAN_RADIUS = .285;
export const PEDESTRIAN_ROUTE_OFFSET = 12.69;
export const PEDESTRIAN_FOOTPATH_HEIGHT = .24;

export type PedestrianRoutePoint = { x: number; z: number; distance: number };
export type PedestrianRoute = {
  points: PedestrianRoutePoint[];
  /** One-way length. Open routes are traversed in both directions. */
  length: number;
  blockX: number;
  blockZ: number;
  closed: boolean;
};
export type PedestrianRouteSample = { x: number; z: number; yaw: number };

const SIDE_LENGTH = PEDESTRIAN_ROUTE_OFFSET * 2;
const PERIMETER = SIDE_LENGTH * 4;
const END_CLEARANCE = .08;
const MIN_ROUTE_LENGTH = 7;
const CORNERS = [
  { x: -PEDESTRIAN_ROUTE_OFFSET, z: -PEDESTRIAN_ROUTE_OFFSET },
  { x: PEDESTRIAN_ROUTE_OFFSET, z: -PEDESTRIAN_ROUTE_OFFSET },
  { x: PEDESTRIAN_ROUTE_OFFSET, z: PEDESTRIAN_ROUTE_OFFSET },
  { x: -PEDESTRIAN_ROUTE_OFFSET, z: PEDESTRIAN_ROUTE_OFFSET },
];
type Interval = { start: number; end: number };

function routePoint(blockX: number, blockZ: number, distance: number, start: number): PedestrianRoutePoint {
  const perimeterDistance = ((distance % PERIMETER) + PERIMETER) % PERIMETER;
  const side = Math.min(3, Math.floor(perimeterDistance / SIDE_LENGTH));
  const from = CORNERS[side], to = CORNERS[(side + 1) % 4];
  const t = (perimeterDistance - side * SIDE_LENGTH) / SIDE_LENGTH;
  return { x: blockX + from.x + (to.x - from.x) * t, z: blockZ + from.z + (to.z - from.z) * t, distance: distance - start };
}

function addRoute(routes: PedestrianRoute[], blockX: number, blockZ: number, start: number, end: number, closed: boolean) {
  if (end - start < MIN_ROUTE_LENGTH) return;
  const points = [routePoint(blockX, blockZ, start, start)];
  for (let corner = Math.floor(start / SIDE_LENGTH) + 1; corner * SIDE_LENGTH < end - 1e-7; corner++) {
    points.push(routePoint(blockX, blockZ, corner * SIDE_LENGTH, start));
  }
  points.push(routePoint(blockX, blockZ, end, start));
  routes.push({ points, length: end - start, blockX, blockZ, closed });
}

/**
 * Build routes from the actual static footprints, before architecture is batched.
 * The shop podiums leave a narrow pavement strip: where a cabinet, shelter or
 * support closes that strip, pedestrians turn back along a safe run instead of
 * cutting through the shop or stepping into traffic to complete a block loop.
 */
export function buildPedestrianRoutes(colliders: readonly WorldCollider[]): PedestrianRoute[] {
  // Curbs are only 16 cm above the sidewalk; a shoulder-sized disc must not treat
  // them as full-height walls. All head-height and taller street furniture stays solid.
  const solids = colliders.filter(collider => (collider.maxY ?? Infinity) > .45 && (collider.minY ?? 0) < 2.4);
  const routes: PedestrianRoute[] = [];
  for (const xRoad of ROAD_COORDS.slice(0, -1)) for (const zRoad of ROAD_COORDS.slice(0, -1)) {
    const blockX = xRoad + ROAD_STEP / 2, blockZ = zRoad + ROAD_STEP / 2;
    const nearby = solids.filter(collider =>
      Math.abs(collider.x - blockX) <= collider.hx + PEDESTRIAN_ROUTE_OFFSET + PEDESTRIAN_RADIUS &&
      Math.abs(collider.z - blockZ) <= collider.hz + PEDESTRIAN_ROUTE_OFFSET + PEDESTRIAN_RADIUS);
    const blocked: Interval[] = [];
    for (let side = 0; side < 4; side++) {
      const from = CORNERS[side], to = CORNERS[(side + 1) % 4];
      const horizontal = side % 2 === 0;
      const direction = horizontal ? Math.sign(to.x - from.x) : Math.sign(to.z - from.z);
      const fixed = horizontal ? blockZ + from.z : blockX + from.x;
      const origin = horizontal ? blockX + from.x : blockZ + from.z;
      for (const collider of nearby) {
        const across = horizontal ? collider.z : collider.x;
        const halfAcross = (horizontal ? collider.hz : collider.hx) + PEDESTRIAN_RADIUS;
        if (Math.abs(fixed - across) >= halfAcross) continue;
        const along = horizontal ? collider.x : collider.z;
        const halfAlong = (horizontal ? collider.hx : collider.hz) + PEDESTRIAN_RADIUS;
        const a = (along - halfAlong - origin) * direction;
        const b = (along + halfAlong - origin) * direction;
        const start = Math.max(0, Math.min(a, b)), end = Math.min(SIDE_LENGTH, Math.max(a, b));
        if (end > start) blocked.push({ start: side * SIDE_LENGTH + start, end: side * SIDE_LENGTH + end });
      }
    }
    if (!blocked.length) {
      addRoute(routes, blockX, blockZ, 0, PERIMETER, true);
      continue;
    }
    blocked.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of blocked) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end + END_CLEARANCE * 2) previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    for (let i = 0; i < merged.length; i++) {
      const current = merged[i], next = merged[(i + 1) % merged.length];
      const start = current.end + END_CLEARANCE;
      const end = next.start + (i === merged.length - 1 ? PERIMETER : 0) - END_CLEARANCE;
      addRoute(routes, blockX, blockZ, start, end, false);
    }
  }
  return routes;
}

/** Allocation-free arc-length sampling. Yaw assumes the character faces local +Z. */
export function samplePedestrianRoute<T extends PedestrianRouteSample>(route: PedestrianRoute, distance: number, target: T): T {
  const period = route.closed ? route.length : route.length * 2;
  let along = ((distance % period) + period) % period;
  const reverse = !route.closed && along >= route.length;
  if (reverse) along = period - along;
  let low = 0, high = route.points.length - 2;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (along >= route.points[middle + 1].distance) low = middle + 1;
    else high = middle;
  }
  const from = route.points[low], to = route.points[low + 1];
  const t = (along - from.distance) / (to.distance - from.distance);
  target.x = from.x + (to.x - from.x) * t;
  target.z = from.z + (to.z - from.z) * t;
  const direction = reverse ? -1 : 1;
  target.yaw = Math.atan2((to.x - from.x) * direction, (to.z - from.z) * direction);
  return target;
}
