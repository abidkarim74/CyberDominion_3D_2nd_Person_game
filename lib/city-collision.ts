import * as THREE from 'three';
import { CITY_EDGE, ROAD_STEP } from './city-layout';

export type WorldCollider = { x: number; z: number; hx: number; hz: number; minY?: number; maxY?: number; label?: string };
export const CAR_HALF_WIDTH = 1.05;
export const CAR_HALF_LENGTH = 2.65;
const CAR_HEIGHT = 1.6;
const BROAD_PHASE_MARGIN = Math.hypot(CAR_HALF_WIDTH, CAR_HALF_LENGTH);

type Position = { x: number; z: number };

/** Nearby solid objects, shared by swept car collisions and projectile hits. */
export class ColliderGrid {
  private readonly cells = new Map<string, WorldCollider[]>();
  private readonly candidates: WorldCollider[] = [];
  private readonly seen = new Set<WorldCollider>();
  readonly stats = { geometryChecked: 0, geometryAdded: 0 };

  constructor(colliders: readonly WorldCollider[]) { for (const collider of colliders) this.add(collider); }

  add(collider: WorldCollider) {
    for (let x = Math.floor((collider.x - collider.hx - BROAD_PHASE_MARGIN) / ROAD_STEP); x <= Math.floor((collider.x + collider.hx + BROAD_PHASE_MARGIN) / ROAD_STEP); x++) {
      for (let z = Math.floor((collider.z - collider.hz - BROAD_PHASE_MARGIN) / ROAD_STEP); z <= Math.floor((collider.z + collider.hz + BROAD_PHASE_MARGIN) / ROAD_STEP); z++) {
        const key = `${x},${z}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(collider); else this.cells.set(key, [collider]);
      }
    }
  }

  query(from: Position, to: Position = from): readonly WorldCollider[] {
    this.candidates.length = 0; this.seen.clear();
    for (let x = Math.floor(Math.min(from.x, to.x) / ROAD_STEP); x <= Math.floor(Math.max(from.x, to.x) / ROAD_STEP); x++) {
      for (let z = Math.floor(Math.min(from.z, to.z) / ROAD_STEP); z <= Math.floor(Math.max(from.z, to.z) / ROAD_STEP); z++) {
        for (const collider of this.cells.get(`${x},${z}`) ?? []) {
          if (!this.seen.has(collider)) { this.seen.add(collider); this.candidates.push(collider); }
        }
      }
    }
    return this.candidates;
  }

  sweep(from: Position, to: Position, yaw: number) {
    const cosine = Math.abs(Math.cos(yaw)), sine = Math.abs(Math.sin(yaw));
    const hx = cosine * CAR_HALF_WIDTH + sine * CAR_HALF_LENGTH;
    const hz = sine * CAR_HALF_WIDTH + cosine * CAR_HALF_LENGTH;
    let time = Infinity;
    let hit: WorldCollider | undefined;
    for (const collider of this.query(from, to)) {
      const entry = sweptEntry(from, to, collider, hx, hz);
      if (entry !== null && entry < time) { time = entry; hit = collider; }
    }
    return hit ? { time, collider: hit } : null;
  }
}

/** Segment against an expanded box prevents jumping across thin posts at boost speed. */
export function sweptEntry(from: Position, to: Position, collider: WorldCollider, paddingX = 0, paddingZ = 0) {
  const hx = collider.hx + paddingX, hz = collider.hz + paddingZ;
  const sx = from.x - collider.x, sz = from.z - collider.z;
  const dx = to.x - from.x, dz = to.z - from.z;
  if (dx === 0 && dz === 0) return null;
  if (Math.abs(sx) < hx && Math.abs(sz) < hz) {
    // Allow escape if turning or a reset placed part of the footprint inside a box.
    const before = Math.min(hx - Math.abs(sx), hz - Math.abs(sz));
    const after = Math.min(hx - Math.abs(sx + dx), hz - Math.abs(sz + dz));
    if (after < before) return null;
    return 0;
  }
  let enter = 0, exit = 1;
  for (const [start, motion, extent] of [[sx, dx, hx], [sz, dz, hz]]) {
    if (Math.abs(motion) < 1e-10) { if (Math.abs(start) >= extent) return null; continue; }
    const a = (-extent - start) / motion, b = (extent - start) / motion;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter >= 0 && enter <= 1 ? enter : null;
}

/** Curved arches have two solid feet with empty space between them at car height. */
function archFootprints(mesh: THREE.Mesh, matrix: THREE.Matrix4) {
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
  const boxes: THREE.Box3[] = [];
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const count = index?.count ?? position.count;
  for (let i = 0; i < count; i += 3) {
    for (let j = 0; j < 3; j++) vertices[j].fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(matrix);
    if (vertices.every(v => v.y > CAR_HEIGHT) || vertices.every(v => v.y <= .35)) continue;
    const points: THREE.Vector3[] = [];
    for (let j = 0; j < 3; j++) {
      const a = vertices[j], b = vertices[(j + 1) % 3];
      if (a.y <= CAR_HEIGHT) points.push(a.clone());
      if ((a.y <= CAR_HEIGHT) !== (b.y <= CAR_HEIGHT)) points.push(a.clone().lerp(b, (CAR_HEIGHT - a.y) / (b.y - a.y)));
    }
    const footprint = new THREE.Box3().setFromPoints(points);
    // Merge touching projected triangles; disconnected arch feet remain separate.
    for (let j = boxes.length - 1; j >= 0; j--) {
      const other = boxes[j];
      if (footprint.min.x <= other.max.x + 1e-5 && footprint.max.x >= other.min.x - 1e-5 &&
          footprint.min.z <= other.max.z + 1e-5 && footprint.max.z >= other.min.z - 1e-5) {
        footprint.union(other); boxes.splice(j, 1);
      }
    }
    boxes.push(footprint);
  }
  return boxes;
}

/** Register physical footprints before static meshes are merged for rendering. */
export function collectWorldColliders(scene: THREE.Scene, colliders: WorldCollider[]) {
  scene.updateMatrixWorld(true);
  const grid = new ColliderGrid(colliders);
  const box = new THREE.Box3(), transform = new THREE.Matrix4(), instance = new THREE.Matrix4();
  function registerBox(object: THREE.Mesh, bounds: THREE.Box3) {
    const solid: WorldCollider = { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2,
      hx: (bounds.max.x - bounds.min.x) / 2, hz: (bounds.max.z - bounds.min.z) / 2,
      minY: bounds.min.y, maxY: bounds.max.y, label: object.name || object.geometry.type };
    const contained = grid.query(bounds.min, bounds.max).some(c =>
      c.x - c.hx <= bounds.min.x + .01 && c.x + c.hx >= bounds.max.x - .01 &&
      c.z - c.hz <= bounds.min.z + .01 && c.z + c.hz >= bounds.max.z - .01);
    if (contained) return;
    colliders.push(solid); grid.add(solid); grid.stats.geometryAdded++;
  }
  function register(object: THREE.Mesh, matrix: THREE.Matrix4) {
    object.geometry.computeBoundingBox();
    if (!object.geometry.boundingBox) return;
    box.copy(object.geometry.boundingBox).applyMatrix4(matrix);
    // Flat road markings and low pavement are drivable; overhead structures clear the car.
    if (box.max.y <= .35 || box.min.y > CAR_HEIGHT || box.max.x - box.min.x < .01 || box.max.z - box.min.z < .01) return;
    if (box.min.x > CITY_EDGE + BROAD_PHASE_MARGIN || box.max.x < -CITY_EDGE - BROAD_PHASE_MARGIN ||
        box.min.z > CITY_EDGE + BROAD_PHASE_MARGIN || box.max.z < -CITY_EDGE - BROAD_PHASE_MARGIN) return;
    grid.stats.geometryChecked++;
    if (object.geometry.type === 'TorusGeometry') {
      for (const footprint of archFootprints(object, matrix)) registerBox(object, footprint);
    } else registerBox(object, box);
  }
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.dynamic || object.userData.driveThrough) return;
    if (object instanceof THREE.InstancedMesh) {
      for (let i = 0; i < object.count; i++) { object.getMatrixAt(i, instance); transform.multiplyMatrices(object.matrixWorld, instance); register(object, transform); }
    } else register(object, object.matrixWorld);
  });
  return grid;
}
