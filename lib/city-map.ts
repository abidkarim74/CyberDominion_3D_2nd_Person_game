import { CITY_SPAN } from './city-layout';

/** World +X points right and +Z points down on the north-up city map.
 * The car faces (-sin(yaw), -cos(yaw)), so SVG heading is -yaw.
 */
export function carMapTransform(x: number, z: number, yaw: number) {
  return `translate(${x + CITY_SPAN / 2} ${z + CITY_SPAN / 2}) rotate(${-yaw * 180 / Math.PI})`;
}
