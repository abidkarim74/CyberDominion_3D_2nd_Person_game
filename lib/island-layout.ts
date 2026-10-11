/** One shoreline shared by the land, water, snow mask, and live map. */
export const ISLAND_HALF_SIZE = 428;
export const ISLAND_CORNER_CUT = 28;
export const OCEAN_LEVEL = -4.5;
export const DISTANT_SHORE_Z = -1450;
export const DISTANT_CITY_Z = -1730;

export const ISLAND_OUTLINE: readonly (readonly [number, number])[] = [
  [-400, -428],
  [400, -428],
  [428, -400],
  [428, 400],
  [400, 428],
  [-400, 428],
  [-428, 400],
  [-428, -400],
];

export function isIslandLand(x: number, z: number) {
  return (
    Math.max(Math.abs(x), Math.abs(z)) <= ISLAND_HALF_SIZE &&
    Math.abs(x) + Math.abs(z) <= ISLAND_HALF_SIZE * 2 - ISLAND_CORNER_CUT
  );
}
