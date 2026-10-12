import type * as THREE from 'three';
import type { WorldCollider } from './city-collision';

/** Segment/AABB slab intersection catches a thin wall even across a long frame. */
export function projectileHitFraction(from: THREE.Vector3, to: THREE.Vector3, solid: WorldCollider): number | null {
  let enter = 0, exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = axis === 0 ? from.x : axis === 1 ? from.y : from.z;
    const end = axis === 0 ? to.x : axis === 1 ? to.y : to.z;
    const minimum = axis === 0 ? solid.x - solid.hx : axis === 1 ? solid.minY ?? 0 : solid.z - solid.hz;
    const maximum = axis === 0 ? solid.x + solid.hx : axis === 1 ? solid.maxY ?? Infinity : solid.z + solid.hz;
    const motion = end - start;
    if (Math.abs(motion) < 1e-9) { if (start < minimum || start > maximum) return null; continue; }
    const a = (minimum - start) / motion, b = (maximum - start) / motion;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter <= 1 && exit >= 0 ? enter : null;
}
