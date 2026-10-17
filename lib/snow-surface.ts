import { CITY_EDGE, ROAD_COORDS, ROAD_WIDTH, nearestRoad, isCitySquare } from './city-layout';
import {
  ISLAND_HALF_SIZE,
  ISLAND_CORNER_CUT,
  OCEAN_LEVEL,
  isIslandLand,
} from './island-layout';

export const SNOW_CLEAR_HALF_WIDTH = 6.3;
export const WINTER_GROUND_EDGE = ISLAND_HALF_SIZE;
export const BORDER_SNOW_START =
  ROAD_COORDS[ROAD_COORDS.length - 1] + SNOW_CLEAR_HALF_WIDTH;
export type SnowContact = {
  x: number;
  z: number;
  height: number;
  coverage: number;
  depth: number;
  grip: number;
};
export const makeSnowContact = (): SnowContact => ({
  x: 0,
  z: 0,
  height: 0.009,
  coverage: 0,
  depth: 0,
  grip: 0.95,
});
export function smooth01(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
export function groundHeight(x: number, z: number) {
  if (isCitySquare(x, z)) return 0.016;
  if (!isIslandLand(x, z)) return OCEAN_LEVEL;
  const nx = nearestRoad(x),
    nz = nearestRoad(z);
  const dx = Math.abs(nx) <= CITY_EDGE ? Math.abs(x - nx) : 1e6;
  const dz = Math.abs(nz) <= CITY_EDGE ? Math.abs(z - nz) : 1e6;
  if (
    Math.max(Math.abs(x), Math.abs(z)) <= 396 &&
    Math.min(dx, dz) < ROAD_WIDTH / 2
  )
    return 0.009;
  if (
    Math.max(Math.abs(x), Math.abs(z)) < 365 &&
    Math.min(dx, dz) >= ROAD_WIDTH / 2
  )
    return 0.24;
  return -0.19;
}
export function borderSnowCoverage(x: number, z: number) {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const coverage = smooth01((edge - BORDER_SNOW_START) / 3.1);
  if (coverage === 0 || !isIslandLand(x, z)) return 0;
  const nx = nearestRoad(x),
    nz = nearestRoad(z);
  const dx = Math.abs(nx) <= CITY_EDGE ? Math.abs(x - nx) : 1e6;
  const dz = Math.abs(nz) <= CITY_EDGE ? Math.abs(z - nz) : 1e6;
  const plowed = smooth01((Math.min(dx, dz) - SNOW_CLEAR_HALF_WIDTH) / 2.5);
  return coverage * (plowed + (1 - plowed) * smooth01((edge - 396) / 5));
}
export function borderSnowHeight(x: number, z: number) {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  return (
    0.032 +
    smooth01((edge - BORDER_SNOW_START) / 4.5) * 0.108 +
    Math.sin(x * 0.09) * Math.sin(z * 0.075) * 0.014
  );
}
export function finishSnowContact(
  contact: SnowContact,
  x: number,
  z: number,
  height: number,
  coverage: number,
) {
  contact.x = x;
  contact.z = z;
  contact.coverage = coverage;
  contact.height = height;
  contact.depth = Math.max(0, height - groundHeight(x, z)) * coverage;
  const snow = smooth01(contact.depth / 0.065) * coverage;
  contact.grip = 0.95 + (0.32 - 0.95) * snow;
  return contact;
}

/** Same cleared-road mask used by the perimeter material and wheel contacts. */
export const BORDER_SNOW_GLSL = `
  float snowSmooth(float v) { return smoothstep(0., 1., v); }
  float borderSnowCoverage(vec2 p) {
    float edge = max(abs(p.x), abs(p.y));
    if (edge > ${ISLAND_HALF_SIZE.toFixed(3)} || abs(p.x) + abs(p.y) > ${(ISLAND_HALF_SIZE * 2 - ISLAND_CORNER_CUT).toFixed(3)}) return 0.;
    float coverage = snowSmooth((edge - ${BORDER_SNOW_START.toFixed(3)}) / 3.1);
    vec2 road = floor((p - 22.) / 44. + .5) * 44. + 22.;
    vec2 d = abs(p - road);
    if (abs(road.x) > ${CITY_EDGE}.) d.x = 1000000.;
    if (abs(road.y) > ${CITY_EDGE}.) d.y = 1000000.;
    float plowed = snowSmooth((min(d.x, d.y) - ${SNOW_CLEAR_HALF_WIDTH}) / 2.5);
    return coverage * mix(plowed, 1., snowSmooth((edge - 396.) / 5.));
  }
`;
