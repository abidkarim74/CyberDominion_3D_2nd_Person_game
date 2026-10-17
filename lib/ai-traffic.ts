import * as THREE from 'three';
import type { makeCar } from './cinematic-car';
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH, type ColliderGrid } from './city-collision';
import { makeSnowContact, type SnowContact } from './snow-surface';
import { stepVehicle, WHEEL_CONTACTS, type VehicleInput, type VehicleMotion } from './vehicle-dynamics';

export type TrafficMarker = { x: number; z: number; yaw: number; color: string };
type CarRig = ReturnType<typeof makeCar>;
type RoutePoint = { x: number; z: number; distance: number; curvature: number };
type Route = { points: RoutePoint[]; length: number };
type TrafficCar = {
  id: number; rig: Pick<CarRig, 'car' | 'body' | 'wheels' | 'steering' | 'brakeLights' | 'reverseLights'>;
  motion: VehicleMotion; previous: THREE.Vector3; contacts: SnowContact[];
  route: Route; progress: number; cruiseSpeed: number; input: VehicleInput;
  start: { position: THREE.Vector3; yaw: number; progress: number; wheelAngles: number[] };
  marker: TrafficMarker; stuckTime: number; reverseTime: number; laps: number;
};

// A compact turn leaves clearance for the full car footprint at inside block corners.
const LANE = 4.4, TURN_RADIUS = 4, WHEELBASE = 2.86;
const clamp = THREE.MathUtils.clamp;
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Rounded intersections keep the route on the street through each 90-degree turn. */
function streetLoop(west: number, north: number, east: number, south: number, clockwise: boolean): Route {
  const offset = clockwise ? LANE : -LANE;
  const left = west + offset, right = east - offset, top = north + offset, bottom = south - offset;
  const points: RoutePoint[] = [];
  function line(x0: number, z0: number, x1: number, z1: number) {
    const count = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2);
    for (let i = 0; i < count; i++) points.push({ x: x0 + (x1 - x0) * i / count, z: z0 + (z1 - z0) * i / count, distance: 0, curvature: 0 });
  }
  function turn(x: number, z: number, start: number) {
    for (let i = 0; i < 16; i++) {
      const angle = start + i / 16 * Math.PI / 2;
      points.push({ x: x + Math.cos(angle) * TURN_RADIUS, z: z + Math.sin(angle) * TURN_RADIUS, distance: 0, curvature: 1 / TURN_RADIUS });
    }
  }
  line(left + TURN_RADIUS, top, right - TURN_RADIUS, top);
  turn(right - TURN_RADIUS, top + TURN_RADIUS, -Math.PI / 2);
  line(right, top + TURN_RADIUS, right, bottom - TURN_RADIUS);
  turn(right - TURN_RADIUS, bottom - TURN_RADIUS, 0);
  line(right - TURN_RADIUS, bottom, left + TURN_RADIUS, bottom);
  turn(left + TURN_RADIUS, bottom - TURN_RADIUS, Math.PI / 2);
  line(left, bottom - TURN_RADIUS, left, top + TURN_RADIUS);
  turn(left + TURN_RADIUS, top + TURN_RADIUS, Math.PI);
  if (!clockwise) points.reverse();
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    points[i].distance = length;
    const next = points[(i + 1) % points.length];
    length += Math.hypot(next.x - points[i].x, next.z - points[i].z);
  }
  return { points, length };
}

function routeSample(route: Route, distance: number) {
  const at = ((distance % route.length) + route.length) % route.length;
  const points = route.points;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].distance <= at) low = mid; else high = mid - 1;
  }
  const a = points[low], b = points[(low + 1) % points.length];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const t = (at - a.distance) / length;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
    yaw: Math.atan2(a.x - b.x, a.z - b.z), curvature: a.curvature };
}

function routeProjection(route: Route, position: THREE.Vector3) {
  let best = Infinity, progress = 0;
  for (let i = 0; i < route.points.length; i++) {
    const a = route.points[i], b = route.points[(i + 1) % route.points.length];
    const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
    const t = clamp(((position.x - a.x) * dx + (position.z - a.z) * dz) / lengthSquared, 0, 1);
    const error = (position.x - a.x - dx * t) ** 2 + (position.z - a.z - dz * t) ** 2;
    if (error < best) { best = error; progress = a.distance + Math.sqrt(lengthSquared) * t; }
  }
  return progress;
}

/** Clone the player's assembled model, sharing its GPU geometry and textures. */
function trafficRig(source: CarRig, color: number): TrafficCar['rig'] {
  const car = source.car.clone(true);
  const copies = new Map<THREE.Object3D, THREE.Object3D>();
  function pair(original: THREE.Object3D, copy: THREE.Object3D) {
    copies.set(original, copy);
    original.children.forEach((child, i) => pair(child, copy.children[i]));
  }
  pair(source.car, car);
  const mutable = new Set<THREE.Material>();
  for (const mesh of [...source.brakeLights, ...source.reverseLights, ...source.brakeDiscs, ...source.exhausts]) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mutable.add(material);
  }
  const materials = new Map<THREE.Material, THREE.Material>();
  const removed: THREE.Object3D[] = [];
  car.traverse(object => {
    object.userData.dynamic = true;
    if (object instanceof THREE.Light || object.userData.cockpitDetail) removed.push(object);
    if (!(object instanceof THREE.Mesh)) return;
    function materialCopy(material: THREE.Material) {
      const paint = material.userData.vehiclePaint === true;
      if (!paint && !mutable.has(material)) return material;
      let copy = materials.get(material);
      if (!copy) {
        copy = material.clone();
        if (paint) (copy as THREE.MeshPhysicalMaterial).color.setHex(color);
        materials.set(material, copy);
      }
      return copy;
    }
    object.material = Array.isArray(object.material) ? object.material.map(materialCopy) : materialCopy(object.material);
  });
  for (const effect of [source.nitroEffects.mesh, source.miniguns.glow, source.underglow, ...source.muzzleFlashes]) {
    const copy = copies.get(effect);
    if (copy) removed.push(copy);
  }
  removed.forEach(object => object.removeFromParent());
  const copy = <T extends THREE.Object3D>(original: T) => copies.get(original) as T;
  return { car, body: copy(source.body), wheels: source.wheels.map(copy), steering: source.steering.map(copy),
    brakeLights: source.brakeLights.map(copy), reverseLights: source.reverseLights.map(copy) };
}

/** SAT also predicts crossing traffic without treating neighboring lanes as obstacles. */
function footprintContact(x0: number, z0: number, yaw0: number, x1: number, z1: number, yaw1: number, padding = 0) {
  const ax = Math.cos(yaw0), az = -Math.sin(yaw0), afx = -Math.sin(yaw0), afz = -Math.cos(yaw0);
  const bx = Math.cos(yaw1), bz = -Math.sin(yaw1), bfx = -Math.sin(yaw1), bfz = -Math.cos(yaw1);
  const dx = x1 - x0, dz = z1 - z0;
  if (dx * dx + dz * dz > (CAR_HALF_LENGTH * 2 + CAR_HALF_WIDTH * 2 + padding * 2) ** 2) return null;
  let depth = Infinity, nx = 0, nz = 0;
  for (const [x, z] of [[ax, az], [afx, afz], [bx, bz], [bfx, bfz]]) {
    const extentA = Math.abs(x * ax + z * az) * CAR_HALF_WIDTH + Math.abs(x * afx + z * afz) * CAR_HALF_LENGTH;
    const extentB = Math.abs(x * bx + z * bz) * CAR_HALF_WIDTH + Math.abs(x * bfx + z * bfz) * CAR_HALF_LENGTH;
    const separation = dx * x + dz * z;
    const overlap = extentA + extentB + padding - Math.abs(separation);
    if (overlap <= 0) return null;
    if (overlap < depth) { depth = overlap; const sign = separation < 0 ? -1 : 1; nx = x * sign; nz = z * sign; }
  }
  return { depth, nx, nz };
}

/** At 120 Hz even maximum nitro travel is shorter than the smallest footprint. */
function collideCars(a: VehicleMotion, b: VehicleMotion) {
  const contact = footprintContact(a.position.x, a.position.z, a.yaw, b.position.x, b.position.z, b.yaw);
  if (!contact) return 0;
  const { depth, nx, nz } = contact;
  const correction = (depth + .002) / 2;
  a.position.x -= nx * correction; a.position.z -= nz * correction;
  b.position.x += nx * correction; b.position.z += nz * correction;
  const closingSpeed = (a.velocity.x - b.velocity.x) * nx + (a.velocity.z - b.velocity.z) * nz;
  if (closingSpeed > 0) {
    const impulse = closingSpeed * .54;
    a.velocity.x -= nx * impulse; a.velocity.z -= nz * impulse;
    b.velocity.x += nx * impulse; b.velocity.z += nz * impulse;
    a.yawRate *= .65; b.yawRate *= .65;
  }
  return Math.max(.001, closingSpeed);
}

export class AiTraffic {
  readonly cars: TrafficCar[];
  readonly markers: TrafficMarker[];
  collisions = 0;
  private pedestrian: THREE.Vector3 | null = null;

  setPedestrian(position: THREE.Vector3 | null) { this.pedestrian = position; }

  constructor(scene: THREE.Scene, source: CarRig, private readonly world: ColliderGrid,
    private readonly sample: (x: number, z: number, target: SnowContact) => SnowContact) {
    // Keep the southern turns on 66: the tunnel on z=88 leaves no safe corner
    // recovery space for the longer circuit that turns onto the street at z=110.
    const routes = [streetLoop(-22, -110, 110, 66, true), streetLoop(-110, -66, 22, 66, false),
      streetLoop(-22, -66, 66, 66, true), streetLoop(-66, -110, 22, 66, false)];
    const colors = [0x167bca, 0xf1c232, 0xeeeef3, 0x8650bd];
    // A north-facing launch grid in Nexus Square feeds four existing street circuits.
    const spawn = [ { x: -17.6, z: 36 }, { x: 26.4, z: 36 }, { x: -17.6, z: 48 }, { x: 26.4, z: 48 } ];
    this.cars = routes.map((route, id) => {
      const position = new THREE.Vector3(spawn[id].x, .015, spawn[id].z);
      const progress = routeProjection(route, position), start = routeSample(route, progress);
      position.set(start.x, .015, start.z);
      const rig = trafficRig(source, colors[id]);
      rig.car.name = `Traffic / AI Chiron ${id + 1}`;
      rig.car.position.copy(position); rig.car.rotation.y = start.yaw;
      scene.add(rig.car);
      return { id, rig, motion: { position, velocity: new THREE.Vector3(), yaw: start.yaw, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 },
        previous: position.clone(), contacts: WHEEL_CONTACTS.map(() => makeSnowContact()), route, progress, cruiseSpeed: 10.5 + id * .8,
        input: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false },
        start: { position: position.clone(), yaw: start.yaw, progress, wheelAngles: rig.wheels.map(wheel => wheel.rotation.x) },
        marker: { x: position.x, z: position.z, yaw: start.yaw, color: `#${colors[id].toString(16).padStart(6, '0')}` },
        stuckTime: 0, reverseTime: 0, laps: 0 };
    });
    this.markers = this.cars.map(car => car.marker);
  }

  /** Return the complete launch grid immediately, including minimap and visual state. */
  reset() {
    this.collisions = 0;
    for (const car of this.cars) {
      const { motion, rig, start } = car;
      motion.position.copy(start.position); motion.velocity.set(0, 0, 0);
      motion.yaw = start.yaw; motion.yawRate = 0; motion.steeringAngle = 0;
      motion.acceleration = 0; motion.grip = .95; motion.snow = 0;
      car.previous.copy(start.position); car.progress = start.progress;
      car.stuckTime = 0; car.reverseTime = 0; car.laps = 0;
      car.input.throttle = 0; car.input.brake = 0; car.input.steer = 0;
      car.input.handbrake = false; car.input.boost = false;
      for (const contact of car.contacts) Object.assign(contact, makeSnowContact());
      rig.car.position.copy(start.position); rig.car.rotation.y = start.yaw; rig.car.visible = true;
      rig.body.rotation.x = 0; rig.body.rotation.z = 0;
      rig.wheels.forEach((wheel, i) => { wheel.rotation.x = start.wheelAngles[i]; });
      for (const pivot of rig.steering) pivot.rotation.y = 0;
      for (const light of rig.brakeLights) (light.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6;
      for (const light of rig.reverseLights) (light.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      car.marker.x = start.position.x; car.marker.z = start.position.z; car.marker.yaw = start.yaw;
    }
  }

  private control(car: TrafficCar, player: VehicleMotion, dt: number) {
    const motion = car.motion, speed = motion.velocity.length();
    const before = car.progress;
    car.progress = routeProjection(car.route, motion.position);
    if (before > car.route.length * .9 && car.progress < car.route.length * .1) car.laps++;
    const lookahead = 3.4 + Math.min(speed * .5, 6);
    const target = routeSample(car.route, car.progress + lookahead);
    const dx = target.x - motion.position.x, dz = target.z - motion.position.z;
    const lateral = -Math.cos(motion.yaw) * dx + Math.sin(motion.yaw) * dz;
    const curvature = 2 * lateral / Math.max(1, dx * dx + dz * dz);
    const desiredWheelAngle = Math.atan(WHEELBASE * curvature);
    car.input.steer = clamp(desiredWheelAngle / (.76 / (1 + speed / 65)), -1, 1);
    let targetSpeed = car.cruiseSpeed;
    for (let distance = 0; distance <= 32; distance += 2) {
      const upcoming = routeSample(car.route, car.progress + distance);
      const cornerSpeed = Math.sqrt(2.6 / Math.max(.001, upcoming.curvature));
      targetSpeed = Math.min(targetSpeed, Math.sqrt(cornerSpeed * cornerSpeed + 2 * 3.2 * Math.max(0, distance - 3)));
    }
    // Slow down if a collision has left the car facing away from its route.
    targetSpeed *= clamp(1 - Math.abs(angleDifference(target.yaw, motion.yaw)) / 2.2, .15, 1);
    const fx = -Math.sin(motion.yaw), fz = -Math.cos(motion.yaw);
    for (const other of [player, ...this.cars.filter(other => other !== car).map(other => other.motion)]) {
      const ox = other.position.x - motion.position.x, oz = other.position.z - motion.position.z;
      const ahead = ox * fx + oz * fz, side = Math.abs(ox * Math.cos(motion.yaw) - oz * Math.sin(motion.yaw));
      const angle = other.yaw - motion.yaw;
      const width = CAR_HALF_WIDTH + Math.abs(Math.cos(angle)) * CAR_HALF_WIDTH + Math.abs(Math.sin(angle)) * CAR_HALF_LENGTH;
      if (ahead > 0 && ahead < 10 + speed * 2 && side < width + .5) {
        targetSpeed = Math.min(targetSpeed, Math.max(0, (ahead - 6.5) / 1.5));
      }
    }
    // Predict crossings on the curved route. The player has priority; NPC ID breaks ties.
    for (let i = -1; i < this.cars.length; i++) {
      const otherCar = i < 0 ? undefined : this.cars[i];
      if (otherCar && otherCar.id >= car.id) continue;
      const other = otherCar?.motion ?? player;
      if (other.position.distanceToSquared(motion.position) > 1600) continue;
      for (const seconds of [.6, 1.2, 1.8, 2.4]) {
        const future = routeSample(car.route, car.progress + Math.max(speed, 2) * seconds);
        const otherFuture = otherCar ? routeSample(otherCar.route, otherCar.progress + other.velocity.length() * seconds)
          : { x: other.position.x + other.velocity.x * seconds, z: other.position.z + other.velocity.z * seconds, yaw: other.yaw };
        if (footprintContact(future.x, future.z, future.yaw, otherFuture.x, otherFuture.z, otherFuture.yaw, .6)) {
          targetSpeed = Math.min(targetSpeed, Math.max(0, (Math.hypot(other.position.x - motion.position.x, other.position.z - motion.position.z) - 7) / 2.4));
        }
      }
    }
    if (this.pedestrian) {
      const dx = this.pedestrian.x - motion.position.x, dz = this.pedestrian.z - motion.position.z;
      const ahead = dx * fx + dz * fz;
      const side = Math.abs(dx * Math.cos(motion.yaw) - dz * Math.sin(motion.yaw));
      if (ahead > -1 && ahead < 9 + speed * 2 && side < CAR_HALF_WIDTH + .9) {
        targetSpeed = Math.min(targetSpeed, Math.max(0, (ahead - CAR_HALF_LENGTH - 1.2) / 1.8));
      }
    }
    car.stuckTime = speed < .6 && targetSpeed > 2 ? car.stuckTime + dt : 0;
    if (car.stuckTime > 5) { car.reverseTime = 1.5; car.stuckTime = 0; }
    if (car.reverseTime > 0) {
      car.reverseTime -= dt;
      let rearBlocked = [player, ...this.cars.filter(other => other !== car).map(other => other.motion)].some(other => {
        const ox = other.position.x - motion.position.x, oz = other.position.z - motion.position.z;
        return ox * fx + oz * fz < 0 && ox * ox + oz * oz < 64;
      });
      if (this.pedestrian) {
        const dx = this.pedestrian.x - motion.position.x, dz = this.pedestrian.z - motion.position.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * Math.cos(motion.yaw) - dz * Math.sin(motion.yaw));
        rearBlocked ||= ahead < 0 && ahead > -(6 + speed * 1.4) && side < CAR_HALF_WIDTH + .9;
      }
      car.input.throttle = rearBlocked ? 0 : -.45; car.input.brake = rearBlocked ? 1 : 0;
      car.input.steer = -clamp(angleDifference(target.yaw, motion.yaw), -1, 1);
      return;
    }
    const error = targetSpeed - speed;
    car.input.brake = targetSpeed < .35 ? 1 : clamp(-error * .32, 0, 1);
    car.input.throttle = car.input.brake > 0 ? 0 : clamp(error * .4 + .045, 0, 1);
  }

  private worldCollision(motion: VehicleMotion, previous: THREE.Vector3) {
    const hit = this.world.sweep(previous, motion.position, motion.yaw);
    if (!hit) return;
    const travel = previous.distanceTo(motion.position);
    motion.position.lerpVectors(previous, motion.position, Math.max(0, hit.time - .003 / Math.max(.003, travel)));
    motion.velocity.set(0, 0, 0); motion.yawRate = 0;
  }

  step(dt: number, player: VehicleMotion) {
    for (const car of this.cars) {
      car.previous.copy(car.motion.position);
      this.control(car, player, dt);
      const cosine = Math.cos(car.motion.yaw), sine = Math.sin(car.motion.yaw);
      WHEEL_CONTACTS.forEach((wheel, i) => this.sample(car.motion.position.x + cosine * wheel.x + sine * wheel.z,
        car.motion.position.z - sine * wheel.x + cosine * wheel.z, car.contacts[i]));
      stepVehicle(car.motion, car.input, car.contacts, dt);
      this.worldCollision(car.motion, car.previous);
    }
    let playerImpact = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const hit = collideCars(player, car.motion);
      if (hit > 0) { playerImpact = Math.max(playerImpact, hit); this.collisions++; }
      for (let j = i + 1; j < this.cars.length; j++) {
        if (collideCars(car.motion, this.cars[j].motion) > 0) this.collisions++;
      }
    }
    // Contact correction cannot push an NPC through roadside scenery.
    for (const car of this.cars) this.worldCollision(car.motion, car.previous);
    return playerImpact;
  }

  updateVisuals(delta: number, observer: THREE.Vector3) {
    for (const car of this.cars) {
      const { motion, rig } = car;
      motion.position.y = car.contacts.reduce((sum, c) => sum + c.height, 0) / 4 + .006;
      rig.car.position.copy(motion.position); rig.car.rotation.y = motion.yaw;
      rig.car.visible = motion.position.distanceToSquared(observer) < 190 * 190;
      const forwardSpeed = -motion.velocity.x * Math.sin(motion.yaw) - motion.velocity.z * Math.cos(motion.yaw);
      for (const wheel of rig.wheels) wheel.rotation.x -= forwardSpeed * delta / .378;
      for (const pivot of rig.steering) pivot.rotation.y = motion.steeringAngle;
      const ease = 1 - Math.exp(-delta * 8);
      rig.body.rotation.x += (clamp(motion.acceleration / 9.81 * .038, -.12, .12) - rig.body.rotation.x) * ease;
      rig.body.rotation.z += (clamp(-motion.yawRate * forwardSpeed / 9.81 * .055, -.12, .12) - rig.body.rotation.z) * ease;
      for (const light of rig.brakeLights) (light.material as THREE.MeshStandardMaterial).emissiveIntensity = (car.input.brake ?? 0) > .05 ? 4.5 : 1.6;
      for (const light of rig.reverseLights) (light.material as THREE.MeshStandardMaterial).emissiveIntensity = forwardSpeed < -.5 ? 2.2 : 0;
      car.marker.x = motion.position.x; car.marker.z = motion.position.z; car.marker.yaw = motion.yaw;
    }
  }
}
