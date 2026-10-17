import * as THREE from 'three';
import { isCitySquare } from './city-layout';
import type { WorldCollider } from './city-collision';
import type { GraphicsQuality } from './graphics-quality';
import type { VehicleBlocker } from './person-controller';
import { buildPedestrianRoutes, samplePedestrianRoute, type PedestrianRoute } from './pedestrian-routes';
import { createPedestrianAppearance, WinterPedestrianRenderer, type PedestrianAppearance } from './pedestrian-appearance';

type Position = { x: number; z: number };
export type Pedestrian = Position & {
  id: number; appearance: PedestrianAppearance; route: PedestrianRoute;
  progress: number; speed: number; walkingSpeed: number; yaw: number; phase: number;
  wait: number; groundY: number; distanceSquared: number;
  leaderId?: number;
};

const CROWD_BUDGET: Record<GraphicsQuality, { count: number; range: number }> = {
  low: { count: 12, range: 80 }, medium: { count: 32, range: 130 },
  high: { count: 32, range: 130 }, ultra: { count: 40, range: 155 },
};
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
function randomFor(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Persistent city residents follow surveyed pavement; only nearby bodies reach the GPU. */
export class AiPedestrians {
  readonly routes: PedestrianRoute[];
  readonly people: Pedestrian[] = [];
  readonly renderer: WinterPedestrianRenderer;
  private readonly nearby: Pedestrian[] = [];
  private readonly next = { x: 0, z: 0, yaw: 0 };
  private readonly ahead = { x: 0, z: 0, yaw: 0 };
  private time = 0;
  private visibleCount = 0;
  private capacity = CROWD_BUDGET.high.count;

  constructor(scene: THREE.Scene, colliders: readonly WorldCollider[],
    private readonly groundHeight: (x: number, z: number) => number) {
    this.routes = buildPedestrianRoutes(colliders);
    this.renderer = new WinterPedestrianRenderer(scene, CROWD_BUDGET.ultra.count);
    const blocks = new Map<string, PedestrianRoute[]>();
    for (const route of this.routes) {
      const key = `${route.blockX},${route.blockZ}`;
      const block = blocks.get(key);
      if (block) block.push(route); else blocks.set(key, [route]);
    }
    for (const routes of blocks.values()) {
      // One person per open run avoids head-on passing on the narrow shopfronts.
      // Spaced residents on complete loops all travel at the same pace.
      const selected = [...routes].sort((a, b) => b.length - a.length).slice(0, 8);
      for (const route of selected) {
        const count = route.closed ? Math.max(2, Math.min(5, Math.floor(route.length / 18))) : 1;
        const firstId = this.people.length;
        const random = randomFor(7853 + this.people.length * 107);
        const cruise = .88 + random() * .48;
        for (let i = 0; i < count; i++) {
          const id = this.people.length;
          const progress = route.closed ? (i + random() * .25) / count * route.length
            : route.length * (.08 + random() * 1.84);
          samplePedestrianRoute(route, progress, this.next);
          this.people.push({ id, appearance: createPedestrianAppearance(id + 1), route, progress,
            speed: cruise, walkingSpeed: cruise, x: this.next.x, z: this.next.z, yaw: this.next.yaw,
            phase: random() * Math.PI * 2, wait: 0,
            groundY: Math.max(isCitySquare(this.next.x, this.next.z) ? .016 : .24, groundHeight(this.next.x, this.next.z)), distanceSquared: Infinity });
        }
        if (route.closed) for (let i = 0; i < count; i++) this.people[firstId + i].leaderId = firstId + (i + 1) % count;
      }
    }
    scene.userData.pedestrians = { population: this.people.length, blocks: blocks.size, routes: this.routes.length };
  }

  get diagnostics() {
    return { population: this.people.length, routes: this.routes.length,
      blocks: new Set(this.routes.map(route => `${route.blockX},${route.blockZ}`)).size,
      visible: this.visibleCount, renderCapacity: this.capacity };
  }

  get visible() { return this.visibleCount; }

  /** Yield to a vehicle or player on the pavement without stepping into the road. */
  private obstructed(point: Position, blockers: readonly VehicleBlocker[], person?: Position | null) {
    if (person && (point.x - person.x) ** 2 + (point.z - person.z) ** 2 < .78 ** 2) return true;
    for (const blocker of blockers) {
      const dx = point.x - blocker.x, dz = point.z - blocker.z;
      if (dx * dx + dz * dz > 25) continue;
      const c = Math.cos(blocker.yaw), s = Math.sin(blocker.yaw);
      if (Math.abs(dx * c - dz * s) < blocker.hx + .45 && Math.abs(dx * s + dz * c) < blocker.hz + .45) return true;
    }
    return false;
  }

  update(delta: number, focus: Position, quality: GraphicsQuality = 'high',
    blockers: readonly VehicleBlocker[] = [], person?: Position | null) {
    const dt = Math.max(0, Math.min(delta, .1));
    this.time += dt;
    const budget = CROWD_BUDGET[quality];
    this.capacity = budget.count;
    this.nearby.length = 0;
    for (const pedestrian of this.people) {
      const route = pedestrian.route;
      if (dt > 0) {
        pedestrian.wait = Math.max(0, pedestrian.wait - dt);
        const period = route.closed ? route.length : route.length * 2;
        // Decelerate before a turnaround; a short pause lets the body turn naturally.
        const toEnd = route.length - pedestrian.progress % route.length;
        let pace = pedestrian.wait > 0 ? 0 : pedestrian.speed;
        if (!route.closed && toEnd < .65) pace *= .3 + .7 * toEnd / .65;
        samplePedestrianRoute(route, pedestrian.progress + .55, this.ahead);
        const nearFocus = (pedestrian.x - focus.x) ** 2 + (pedestrian.z - focus.z) ** 2 < 55 ** 2;
        if (nearFocus && this.obstructed(this.ahead, blockers, person)) pace = 0;
        if (pedestrian.leaderId !== undefined) {
          const leader = this.people[pedestrian.leaderId];
          const gap = (leader.progress - pedestrian.progress + route.length) % route.length;
          pace = Math.min(pace, Math.max(0, (gap - 1.05) * 1.5));
        }
        const oldProgress = pedestrian.progress;
        let progress = oldProgress + pace * dt;
        if (!route.closed && Math.floor(progress / route.length) > Math.floor(oldProgress / route.length)) {
          progress = Math.floor(progress / route.length) * route.length;
          pedestrian.wait = .65 + (pedestrian.id % 7) * .11;
        }
        pedestrian.progress = progress % period;
        samplePedestrianRoute(route, pedestrian.progress, this.next);
        const travelled = Math.hypot(this.next.x - pedestrian.x, this.next.z - pedestrian.z);
        pedestrian.walkingSpeed = travelled / dt;
        pedestrian.phase += travelled * Math.PI * 2 / (.91 + (pedestrian.id % 5) * .035);
        pedestrian.x = this.next.x; pedestrian.z = this.next.z;
        pedestrian.yaw += angleDifference(this.next.yaw, pedestrian.yaw) * (1 - Math.exp(-dt * 9));
      }
      pedestrian.distanceSquared = (pedestrian.x - focus.x) ** 2 + (pedestrian.z - focus.z) ** 2;
      if (pedestrian.distanceSquared <= budget.range ** 2) this.nearby.push(pedestrian);
    }
    this.nearby.sort((a, b) => a.distanceSquared - b.distanceSquared || a.id - b.id);
    this.visibleCount = Math.min(this.nearby.length, budget.count, this.renderer.maxVisible);
    this.renderer.beginFrame();
    for (let i = 0; i < this.visibleCount; i++) {
      const pedestrian = this.nearby[i];
      pedestrian.groundY = Math.max(isCitySquare(pedestrian.x, pedestrian.z) ? .016 : .24, this.groundHeight(pedestrian.x, pedestrian.z));
      this.renderer.set(i, pedestrian.appearance, pedestrian.x, pedestrian.groundY, pedestrian.z,
        pedestrian.yaw, pedestrian.phase, pedestrian.walkingSpeed, this.time);
    }
    this.renderer.endFrame();
  }

  destroy() { this.renderer.dispose(); this.nearby.length = 0; }
}
