import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH, type ColliderGrid, type WorldCollider } from './city-collision';
import { CITY_EDGE } from './city-layout';
import { PersonIdleMotion } from './person-idle-motion';
import { PersonSeatMotion } from './person-seat-motion';

export type PersonMode = 'driving' | 'walking' | 'entering' | 'exiting';
export type VehicleBlocker = { x: number; z: number; yaw: number; hx: number; hz: number };
export type PersonTelemetry = {
  mode: PersonMode;
  ready: boolean;
  loadingError?: string;
  canInteract: boolean;
  interactionLabel: string;
  /** Walking or running speed in metres per second. */
  speed: number;
};

type Point = { x: number; z: number };
type Contact = { time: number; nx: number; nz: number };
type Transition = {
  elapsed: number;
  outside: THREE.Vector3;
  doorway: THREE.Vector3;
  fromYaw: number;
  carYaw: number;
};

const PERSON_SCALE = .92 * .92;
const RADIUS = .30, HEIGHT = 1.8 * PERSON_SCALE, WALK_SPEED = 1.65, RUN_SPEED = 4.3;
const TRANSITION_SECONDS = 3.2, INTERACT_DISTANCE = 2.05, INTERACT_SPEED = 1;
const ROAD_ANKLE_CLEARANCE = .145, CABIN_ANKLE_HEIGHT = .55;
// The authored seated pelvis is .95m above the feet-centred model root.
// Align it with the low cushion, leaving clearance below the inner headliner.
const SEAT = new THREE.Vector3(-.32, .50 - .95 * PERSON_SCALE, .107);
const EXIT_CANDIDATES = [
  [-2.50, .30], [-2.50, -.48], [-2.50, .85], [-1.75, 1.22],
] as const;
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const smooth = (t: number) => { const a = THREE.MathUtils.clamp(t, 0, 1); return a * a * (3 - 2 * a); };

/** Swept point against a radius-expanded box, including its contact normal. */
function boxContact(from: Point, to: Point, x: number, z: number, hx: number, hz: number): Contact | null {
  const sx = from.x - x, sz = from.z - z, dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) + Math.abs(dz) < 1e-10) return null;
  if (Math.abs(sx) < hx && Math.abs(sz) < hz) {
    // A moving traffic car may overlap the capsule; let the person step away.
    const before = Math.min(hx - Math.abs(sx), hz - Math.abs(sz));
    const after = Math.min(hx - Math.abs(sx + dx), hz - Math.abs(sz + dz));
    if (after < before) return null;
    return hx - Math.abs(sx) < hz - Math.abs(sz)
      ? { time: 0, nx: Math.sign(sx) || -Math.sign(dx), nz: 0 }
      : { time: 0, nx: 0, nz: Math.sign(sz) || -Math.sign(dz) };
  }
  let enter = 0, exit = 1, nx = 0, nz = 0;
  for (const [start, motion, extent, axis] of [[sx, dx, hx, 0], [sz, dz, hz, 1]]) {
    if (Math.abs(motion) < 1e-10) { if (Math.abs(start) >= extent) return null; continue; }
    const a = (-extent - start) / motion, b = (extent - start) / motion;
    const near = Math.min(a, b);
    if (near > enter || near === enter && nx === 0 && nz === 0) {
      enter = near;
      nx = axis === 0 ? -Math.sign(motion) : 0;
      nz = axis === 1 ? -Math.sign(motion) : 0;
    }
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter >= 0 && enter <= 1 && exit >= 0 ? { time: enter, nx, nz } : null;
}

/** Grounded character, animated seat transfers, and camera-relative pedestrian controls. */
export class PersonController {
  readonly root = new THREE.Group();
  mode: PersonMode = 'driving';
  /** Orbit camera azimuth; the camera sits on the positive local Z side of its target. */
  cameraYaw = 0;
  doorOpenAmount = 0;
  private model?: THREE.Group;
  private mixer?: THREE.AnimationMixer;
  private idleMotion?: PersonIdleMotion;
  private seatMotion?: PersonSeatMotion;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private activeAction?: THREE.AnimationAction;
  private transition?: Transition;
  private readonly velocity = new THREE.Vector3();
  private readonly input = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly seatWorld = new THREE.Vector3();
  private readonly doorWorld = new THREE.Vector3();
  private readonly transferWorld = new THREE.Vector3();
  private readonly cabinInverse = new THREE.Matrix4();
  private readonly seatedFacing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  private readonly lastCarPosition = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly driverBlocker: VehicleBlocker = { x: 0, z: 0, yaw: 0, hx: CAR_HALF_WIDTH, hz: CAR_HALF_LENGTH };
  private blockers: readonly VehicleBlocker[] = [];
  private lastCarYaw = 0;
  private lastCarSpeed = 0;
  private loaded = false;
  private disposed = false;
  private loadingError?: string;
  private speed = 0;
  private transferDuck = 0;
  private interactionAvailable = false;
  private interactionLabel = 'Loading character…';
  private readonly diagnosticState: {
    asset: string; animations: string[]; height: number; scale: number; meshes: number; triangles: number;
    collisionRadius: number; transitionSeconds: number; loadingError?: string;
  } = { asset: '/models/person/person.glb?v=relaxed-idle-v2', animations: [], height: 0, scale: PERSON_SCALE, meshes: 0,
    triangles: 0, collisionRadius: RADIUS, transitionSeconds: TRANSITION_SECONDS };
  private readonly ankleFloor = (ankle: THREE.Vector3) => {
    if (this.mode === 'driving' && this.cabin) {
      // Solve the tilted cabin floor plane at this ankle's world X/Z.
      const e = this.cabinInverse.elements;
      return (CABIN_ANKLE_HEIGHT - e[1] * ankle.x - e[9] * ankle.z - e[13]) / e[5];
    }
    const dx = ankle.x - this.lastCarPosition.x, dz = ankle.z - this.lastCarPosition.z;
    const side = dx * Math.cos(this.lastCarYaw) - dz * Math.sin(this.lastCarYaw);
    // Lift the leading foot before it crosses the sill, then place both soles
    // on the cabin floor. The trailing foot can stay planted on the road.
    const inside = smooth((side + 1.30) / .24);
    const street = this.getGroundHeight(ankle.x, ankle.z) + ROAD_ANKLE_CLEARANCE;
    return THREE.MathUtils.lerp(street, this.lastCarPosition.y + CABIN_ANKLE_HEIGHT, inside);
  };

  constructor(private readonly scene: THREE.Scene, private readonly collisionWorld: ColliderGrid,
    private readonly getGroundHeight: (x: number, z: number) => number,
    private readonly cabin?: THREE.Object3D) {
    this.root.name = 'Player / realistic animated person';
    this.root.rotation.order = 'YXZ';
    this.root.userData.dynamic = true;
    this.root.visible = false;
    scene.add(this.root);
    new GLTFLoader().load(this.diagnosticState.asset, gltf => {
      if (this.disposed) { this.disposeModel(gltf.scene); return; }
      this.model = gltf.scene;
      this.model.name = 'Blender / rigged person';
      this.model.scale.multiplyScalar(PERSON_SCALE);
      this.model.traverse(object => {
        object.userData.dynamic = true;
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        // Animated limbs can leave the mesh's bind-pose bounds.
        if (object instanceof THREE.SkinnedMesh) object.frustumCulled = false;
        this.diagnosticState.meshes++;
        this.diagnosticState.triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
      });
      this.root.add(this.model);
      this.mixer = new THREE.AnimationMixer(this.model);
      this.diagnosticState.animations = gltf.animations.map(clip => clip.name);
      for (const clip of gltf.animations) {
        const name = this.canonicalClipName(clip.name);
        if (name) this.actions.set(name, this.mixer.clipAction(clip));
      }
      const missing = ['Idle', 'Walk', 'Run', 'Seated', 'EnterCar', 'ExitCar'].filter(name => !this.actions.has(name));
      if (missing.length) {
        this.failLoad(`Character animations are missing: ${missing.join(', ')}.`);
        return;
      }
      this.loaded = true;
      this.root.visible = true;
      // Measure the skinned standing pose, rather than the imported bind bounds.
      this.play('Idle', 0);
      this.mixer.update(0);
      this.root.updateWorldMatrix(true, false);
      this.model.updateMatrixWorld(true);
      this.diagnosticState.height = new THREE.Box3().setFromObject(this.model, true).getSize(new THREE.Vector3()).y;
      this.play('Seated', 0);
      this.mixer.update(0);
      this.idleMotion = new PersonIdleMotion(this.model);
      this.seatMotion = new PersonSeatMotion(this.model);
      this.refreshInteraction();
    }, undefined, error => {
      if (!this.disposed) this.failLoad(error instanceof Error ? error.message : 'The character model could not be loaded.');
    });
  }

  get position() { return this.root.position; }
  get yaw() { return this.root.rotation.y; }
  set yaw(value: number) { this.root.rotation.y = value; }
  get ready() { return this.loaded && !this.disposed; }
  get telemetry(): PersonTelemetry {
    return { mode: this.mode, ready: this.ready, loadingError: this.loadingError,
      canInteract: this.interactionAvailable, interactionLabel: this.interactionLabel, speed: this.speed };
  }
  get diagnostics() {
    return { ...this.diagnosticState, mode: this.mode, ready: this.ready, speed: this.speed,
      doorOpenAmount: this.doorOpenAmount, position: { x: this.position.x, y: this.position.y, z: this.position.z } };
  }

  update(delta: number, pressed: ReadonlySet<string>, carPosition: THREE.Vector3, carYaw: number,
    carSpeed: number, blockers: readonly VehicleBlocker[] = []) {
    if (this.disposed) return;
    const dt = THREE.MathUtils.clamp(delta, 0, .1);
    // Remove the last procedural pose before the mixer writes this frame.
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.rememberCar(carPosition, carYaw, carSpeed);
    this.blockers = blockers;
    if (this.mode === 'driving') {
      if (this.cabin) {
        this.cabin.updateWorldMatrix(true, false);
        this.cabinInverse.copy(this.cabin.matrixWorld).invert();
        this.position.copy(SEAT).applyMatrix4(this.cabin.matrixWorld);
        this.cabin.getWorldQuaternion(this.root.quaternion);
        this.root.quaternion.multiply(this.seatedFacing);
      } else {
        this.localToWorld(SEAT.x, SEAT.y, SEAT.z, this.seatWorld);
        this.position.copy(this.seatWorld);
        this.yaw = carYaw + Math.PI;
      }
      this.speed = 0;
      this.doorOpenAmount = 0;
      this.transferDuck = 0;
    } else if (this.transition) this.updateTransition(dt);
    else if (this.ready) this.updateWalking(dt, pressed);
    this.mixer?.update(dt);
    this.idleMotion?.update(dt, this.mode === 'walking' && this.speed < .10,
      this.mode === 'driving', this.transferDuck);
    if (this.mode !== 'walking') this.seatMotion?.update(this.ankleFloor);
    this.refreshInteraction();
  }

  /** E transfers control only while stopped and at a clear driver's door. */
  interact(carPosition: THREE.Vector3, carYaw: number, carSpeed: number) {
    this.rememberCar(carPosition, carYaw, carSpeed);
    this.refreshInteraction();
    if (!this.interactionAvailable) return false;
    const outside = this.mode === 'driving' ? this.findExit() : this.position.clone();
    if (!outside) return false;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    const doorway = this.localToWorld(-1.40, 0, .30, new THREE.Vector3());
    doorway.y = this.getGroundHeight(doorway.x, doorway.z);
    this.transition = { elapsed: 0, outside, doorway, fromYaw: this.yaw, carYaw };
    this.mode = this.mode === 'driving' ? 'exiting' : 'entering';
    this.root.rotation.x = this.root.rotation.z = 0;
    this.play(this.mode === 'exiting' ? 'ExitCar' : 'EnterCar', .12, true);
    // Sample the authored pose to match the doorway path; the door-opening and
    // closing beats must not consume the character's whole sit-down animation.
    this.activeAction?.setEffectiveTimeScale(0);
    this.interactionAvailable = false;
    this.interactionLabel = this.mode === 'exiting' ? 'Getting out…' : 'Getting in…';
    return true;
  }

  resetDriving(carPosition = this.lastCarPosition, carYaw = this.lastCarYaw) {
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.rememberCar(carPosition, carYaw, 0);
    this.mode = 'driving';
    this.transition = undefined;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.doorOpenAmount = 0;
    this.transferDuck = 0;
    this.localToWorld(SEAT.x, SEAT.y, SEAT.z, this.position);
    this.root.rotation.set(0, carYaw + Math.PI, 0);
    this.play('Seated', .12);
    this.refreshInteraction();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded = false;
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.mixer?.stopAllAction();
    if (this.model) {
      this.mixer?.uncacheRoot(this.model);
      this.disposeModel(this.model);
    }
    this.actions.clear();
    this.root.removeFromParent();
    this.root.clear();
    this.interactionAvailable = false;
  }

  private failLoad(message: string) {
    this.loadingError = message;
    this.diagnosticState.loadingError = message;
    this.root.visible = false;
    this.refreshInteraction();
  }

  private canonicalClipName(name: string) {
    const lower = name.toLowerCase().replace(/[^a-z]/g, '');
    if (lower.includes('enter') || lower.includes('getin')) return 'EnterCar';
    if (lower.includes('exit') || lower.includes('getout')) return 'ExitCar';
    if (lower.includes('seat') || lower.includes('sit') || lower.includes('driv')) return 'Seated';
    if (lower.includes('idle')) return 'Idle';
    if (lower.includes('walk')) return 'Walk';
    if (lower.includes('run')) return 'Run';
    return undefined;
  }

  private play(name: string, fade = .18, oneShot = false) {
    const action = this.actions.get(name);
    if (!action || action === this.activeAction && !oneShot) return;
    const previous = this.activeAction;
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
    action.clampWhenFinished = oneShot;
    if (oneShot) action.setDuration(TRANSITION_SECONDS);
    action.play();
    if (previous && fade > 0) action.crossFadeFrom(previous, fade, false);
    else previous?.stop();
    this.activeAction = action;
  }

  private rememberCar(position: THREE.Vector3, yaw: number, speed: number) {
    this.lastCarPosition.copy(position);
    this.lastCarYaw = yaw;
    this.lastCarSpeed = Math.abs(speed);
    this.driverBlocker.x = position.x;
    this.driverBlocker.z = position.z;
    this.driverBlocker.yaw = yaw;
  }

  private localToWorld(x: number, y: number, z: number, target: THREE.Vector3) {
    const c = Math.cos(this.lastCarYaw), s = Math.sin(this.lastCarYaw);
    return target.set(this.lastCarPosition.x + c * x + s * z, this.lastCarPosition.y + y,
      this.lastCarPosition.z - s * x + c * z);
  }

  private updateTransition(dt: number) {
    const transfer = this.transition!;
    transfer.elapsed = Math.min(TRANSITION_SECONDS, transfer.elapsed + dt);
    const t = transfer.elapsed / TRANSITION_SECONDS;
    const exiting = this.mode === 'exiting';
    // One reversible path keeps entry and exit aligned with the actual opening.
    const u = exiting ? 1 - t : t;
    this.localToWorld(SEAT.x, SEAT.y, SEAT.z, this.seatWorld);
    this.doorOpenAmount = smooth((u - .18) / .14) * (1 - smooth((u - .85) / .15));
    const crouch = smooth((u - .32) / .14);
    const slide = smooth((u - .46) / .24);
    const settle = smooth((u - .70) / .12);
    this.transferDuck = crouch * (1 - settle);
    const outsideYaw = exiting ? transfer.carYaw + Math.PI : transfer.fromYaw;
    const doorwayYaw = transfer.carYaw + Math.PI / 2;
    let pose = 0;
    if (u < .18) {
      const approach = smooth(u / .18);
      this.position.lerpVectors(transfer.outside, transfer.doorway, approach);
      this.position.y = this.getGroundHeight(this.position.x, this.position.z);
      this.yaw = outsideYaw + angleDifference(doorwayYaw, outsideYaw) * approach;
      // Take actual steps to/from the door rather than sliding a held pose.
      if (transfer.outside.distanceToSquared(transfer.doorway) > .02) this.play('Walk', .12);
    } else {
      this.transferWorld.copy(transfer.doorway);
      // Duck outside the sill before the torso moves through the open doorway.
      this.transferWorld.y = THREE.MathUtils.lerp(transfer.doorway.y,
        this.lastCarPosition.y - .14, crouch);
      this.position.lerpVectors(this.transferWorld, this.seatWorld, slide);
      this.yaw = doorwayYaw + Math.PI / 2 * smooth((u - .52) / .18);
      pose = u < .32 ? .25 * smooth((u - .18) / .14)
        : u < .46 ? .25 + .25 * crouch
          : u < .70 ? .50 + .34 * slide : .84 + .16 * settle;
      const clip = exiting ? 'ExitCar' : 'EnterCar';
      if (this.activeAction !== this.actions.get(clip)) this.play(clip, .12, true);
      if (this.activeAction) {
        this.activeAction.setEffectiveTimeScale(0);
        this.activeAction.time = this.activeAction.getClip().duration * (exiting ? 1 - pose : pose);
      }
    }
    if (t < 1) return;
    this.transition = undefined;
    this.mode = exiting ? 'walking' : 'driving';
    this.doorOpenAmount = 0;
    this.transferDuck = 0;
    this.position.copy(exiting ? transfer.outside : this.seatWorld);
    if (exiting) this.position.y = this.getGroundHeight(this.position.x, this.position.z);
    this.yaw = transfer.carYaw + Math.PI;
    this.play(exiting ? 'Idle' : 'Seated', exiting ? .32 : .16);
  }

  private updateWalking(dt: number, pressed: ReadonlySet<string>) {
    const right = Number(pressed.has('KeyD') || pressed.has('ArrowRight') || pressed.has('arrowright') || pressed.has('d'))
      - Number(pressed.has('KeyA') || pressed.has('ArrowLeft') || pressed.has('arrowleft') || pressed.has('a'));
    const forward = Number(pressed.has('KeyW') || pressed.has('ArrowUp') || pressed.has('arrowup') || pressed.has('w'))
      - Number(pressed.has('KeyS') || pressed.has('ArrowDown') || pressed.has('arrowdown') || pressed.has('s'));
    const c = Math.cos(this.cameraYaw), s = Math.sin(this.cameraYaw);
    this.input.set(right * c - forward * s, 0, -right * s - forward * c);
    const moving = this.input.lengthSq() > 0;
    if (moving) this.input.normalize();
    const running = pressed.has('ShiftLeft') || pressed.has('ShiftRight') || pressed.has('Shift') || pressed.has('shift');
    this.desiredVelocity.copy(this.input).multiplyScalar(running ? RUN_SPEED : WALK_SPEED);
    this.velocity.lerp(this.desiredVelocity, 1 - Math.exp(-dt * (moving ? 11 : 14)));
    if (!moving && this.velocity.lengthSq() < .0025) this.velocity.set(0, 0, 0);
    if (moving) {
      const desiredYaw = Math.atan2(this.input.x, this.input.z);
      this.yaw += angleDifference(desiredYaw, this.yaw) * (1 - Math.exp(-dt * 13));
    }
    this.from.copy(this.position);
    this.moveWithSlide(dt);
    this.speed = dt > 0 ? Math.hypot(this.position.x - this.from.x, this.position.z - this.from.z) / dt : 0;
    this.resolveVehicleOverlap();
    this.position.y = this.getGroundHeight(this.position.x, this.position.z);
    const animation = this.speed < .10 ? 'Idle' : this.speed > 2.3 ? 'Run' : 'Walk';
    this.play(animation, animation === 'Idle' ? .32 : .20);
    if (this.activeAction && animation !== 'Idle') {
      const strideSpeed = (animation === 'Run' ? RUN_SPEED : WALK_SPEED) * PERSON_SCALE;
      this.activeAction.setEffectiveTimeScale(THREE.MathUtils.clamp(this.speed / strideSpeed, .18, 1.3));
    }
  }

  private moveWithSlide(dt: number) {
    let dx = this.velocity.x * dt, dz = this.velocity.z * dt;
    for (let i = 0; i < 3 && Math.abs(dx) + Math.abs(dz) > 1e-7; i++) {
      this.to.set(this.position.x + dx, this.position.y, this.position.z + dz);
      const hit = this.firstContact(this.position, this.to);
      if (!hit) { this.position.x = this.to.x; this.position.z = this.to.z; break; }
      const safe = Math.max(0, hit.time - .002 / Math.max(.002, Math.hypot(dx, dz)));
      this.position.x += dx * safe;
      this.position.z += dz * safe;
      dx *= 1 - safe; dz *= 1 - safe;
      const into = dx * hit.nx + dz * hit.nz;
      if (into < 0) { dx -= into * hit.nx; dz -= into * hit.nz; }
      const velocityInto = this.velocity.x * hit.nx + this.velocity.z * hit.nz;
      if (velocityInto < 0) {
        this.velocity.x -= velocityInto * hit.nx;
        this.velocity.z -= velocityInto * hit.nz;
      }
    }
    this.position.x = THREE.MathUtils.clamp(this.position.x, -CITY_EDGE + RADIUS, CITY_EDGE - RADIUS);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -CITY_EDGE + RADIUS, CITY_EDGE - RADIUS);
  }

  private intersectsHeight(collider: WorldCollider, y: number) {
    return (collider.maxY ?? Infinity) > y + .20 && (collider.minY ?? -Infinity) < y + HEIGHT;
  }

  private firstContact(from: THREE.Vector3, to: THREE.Vector3, includeDriver = true) {
    let nearest: Contact | null = null;
    for (const collider of this.collisionWorld.query(from, to)) {
      if (!this.intersectsHeight(collider, from.y)) continue;
      const contact = boxContact(from, to, collider.x, collider.z, collider.hx + RADIUS, collider.hz + RADIUS);
      if (contact && (!nearest || contact.time < nearest.time)) nearest = contact;
    }
    for (const car of includeDriver ? [this.driverBlocker, ...this.blockers] : this.blockers) {
      const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
      const fx = from.x - car.x, fz = from.z - car.z, tx = to.x - car.x, tz = to.z - car.z;
      const contact = boxContact({ x: fx * c - fz * s, z: fx * s + fz * c },
        { x: tx * c - tz * s, z: tx * s + tz * c }, 0, 0, car.hx + RADIUS, car.hz + RADIUS);
      if (contact && (!nearest || contact.time < nearest.time)) {
        nearest = { time: contact.time, nx: contact.nx * c + contact.nz * s,
          nz: -contact.nx * s + contact.nz * c };
      }
    }
    return nearest;
  }

  /** Moving traffic can reach a stationary pedestrian between control updates. */
  private resolveVehicleOverlap() {
    for (let pass = 0; pass < 2; pass++) {
      for (const car of [this.driverBlocker, ...this.blockers]) {
        const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
        const dx = this.position.x - car.x, dz = this.position.z - car.z;
        const x = dx * c - dz * s, z = dx * s + dz * c;
        const hx = car.hx + RADIUS + .005, hz = car.hz + RADIUS + .005;
        if (Math.abs(x) >= hx || Math.abs(z) >= hz) continue;
        let pushX = 0, pushZ = 0;
        if (hx - Math.abs(x) < hz - Math.abs(z)) pushX = (Math.sign(x) || -1) * (hx - Math.abs(x));
        else pushZ = (Math.sign(z) || -1) * (hz - Math.abs(z));
        this.to.copy(this.position);
        this.to.x += pushX * c + pushZ * s;
        this.to.z += -pushX * s + pushZ * c;
        // Never resolve a traffic overlap by pushing the player through a wall.
        const hit = this.firstContact(this.position, this.to);
        if (!hit || hit.time >= .995) {
          this.position.copy(this.to);
          this.velocity.set(0, 0, 0);
        }
      }
    }
    this.position.x = THREE.MathUtils.clamp(this.position.x, -CITY_EDGE + RADIUS, CITY_EDGE - RADIUS);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -CITY_EDGE + RADIUS, CITY_EDGE - RADIUS);
  }

  private clearStandingPosition(position: THREE.Vector3) {
    if (Math.abs(position.x) > CITY_EDGE - RADIUS || Math.abs(position.z) > CITY_EDGE - RADIUS) return false;
    for (const collider of this.collisionWorld.query(position)) {
      if (this.intersectsHeight(collider, position.y) &&
        Math.abs(position.x - collider.x) < collider.hx + RADIUS + .03 &&
        Math.abs(position.z - collider.z) < collider.hz + RADIUS + .03) return false;
    }
    for (const car of [this.driverBlocker, ...this.blockers]) {
      const c = Math.cos(car.yaw), s = Math.sin(car.yaw), dx = position.x - car.x, dz = position.z - car.z;
      if (Math.abs(dx * c - dz * s) < car.hx + RADIUS + .03 &&
        Math.abs(dx * s + dz * c) < car.hz + RADIUS + .03) return false;
    }
    return true;
  }

  private findExit() {
    for (const [x, z] of EXIT_CANDIDATES) {
      const candidate = this.localToWorld(x, 0, z, new THREE.Vector3());
      candidate.y = this.getGroundHeight(candidate.x, candidate.z);
      if (!this.clearStandingPosition(candidate)) continue;
      const sill = this.localToWorld(-1.40, 0, .30, new THREE.Vector3());
      sill.y = this.getGroundHeight(sill.x, sill.z);
      // Check the path beyond the car so narrow walls cannot be stepped through.
      if (this.clearStandingPosition(sill) && !this.firstContact(sill, candidate, false)) return candidate;
    }
    return undefined;
  }

  private refreshInteraction() {
    this.interactionAvailable = false;
    if (!this.ready) {
      this.interactionLabel = this.loadingError ? 'Character unavailable' : 'Loading character…';
      return;
    }
    if (this.mode === 'entering' || this.mode === 'exiting') {
      this.interactionLabel = this.mode === 'entering' ? 'Getting in…' : 'Getting out…';
      return;
    }
    if (this.lastCarSpeed >= INTERACT_SPEED) {
      this.interactionLabel = this.mode === 'driving' ? 'Stop the car to get out' : 'Wait for the car to stop';
      return;
    }
    if (this.mode === 'driving') {
      this.interactionAvailable = !!this.findExit();
      this.interactionLabel = this.interactionAvailable ? 'Get out of car' : 'Driver’s door is blocked';
      return;
    }
    this.localToWorld(-1.45, 0, .107, this.doorWorld);
    const distance = Math.hypot(this.position.x - this.doorWorld.x, this.position.z - this.doorWorld.z);
    const dx = this.position.x - this.lastCarPosition.x, dz = this.position.z - this.lastCarPosition.z;
    const side = dx * Math.cos(this.lastCarYaw) - dz * Math.sin(this.lastCarYaw);
    this.interactionAvailable = distance <= INTERACT_DISTANCE && side < -.85;
    if (this.interactionAvailable) {
      const sill = this.localToWorld(-1.40, 0, .30, this.to);
      sill.y = this.getGroundHeight(sill.x, sill.z);
      this.interactionAvailable = this.clearStandingPosition(sill) && !this.firstContact(this.position, sill, false);
    }
    this.interactionLabel = this.interactionAvailable ? 'Get in car' : 'Walk to the driver’s door';
  }

  private disposeModel(model: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    textures.forEach(texture => texture.dispose());
    materials.forEach(material => material.dispose());
    geometries.forEach(geometry => geometry.dispose());
  }
}
