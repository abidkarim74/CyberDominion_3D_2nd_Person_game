/** Shared street grid for scenery, collision clearance and weather. */
export const CITY_SPAN = 792;
export const CITY_EDGE = 390;
export const ROAD_WIDTH = 18;
export const ROAD_STEP = 44;
export const ROAD_OFFSET = ROAD_STEP / 2;
export const ROAD_COORDS = Array.from({ length: 18 }, (_, i) => (i - 8.5) * ROAD_STEP);

export function nearestRoad(value: number) {
  return Math.round((value - ROAD_OFFSET) / ROAD_STEP) * ROAD_STEP + ROAD_OFFSET;
}

export function nearestBlock(value: number) {
  return Math.round(value / ROAD_STEP) * ROAD_STEP;
}

export function roadDistance(value: number) {
  return Math.abs(value - nearestRoad(value));
}

/** Include a support's full footprint when checking road clearance. */
export function occupiesRoad(x: number, z: number, margin = 0) {
  return Math.min(roadDistance(x), roadDistance(z)) < ROAD_WIDTH / 2 + margin;
}
