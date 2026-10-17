import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH, type ColliderGrid, type WorldCollider } from './city-collision';
import { CITY_EDGE } from './city-layout';
import { PersonIdleMotion } from './person-idle-motion';
import { PersonFaceMotion } from './person-face-motion';
import { PersonSeatMotion, type FootContacts } from './person-seat-motion';
import { PersonGroundMotion } from './person-ground-motion';
import { PersonSteeringMotion, type HandContacts } from './person-steering-motion';
import { PersonDriverVisibility } from './person-driver-visibility';
import { PERSON_WORLD_SCALE } from './person-scale';

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
  duration: number;
};

const PERSON_SCALE = PERSON_WORLD_SCALE;
const RADIUS = .30, HEIGHT = 1.8 * PERSON_SCALE, WALK_SPEED = 1.65, RUN_SPEED = 4.3;
const TRANSITION_SECONDS = 4.4, INTERACT_DISTANCE = 2.05, INTERACT_SPEED = 1;
const ROAD_ANKLE_CLEARANCE = .145, CABIN_ANKLE_HEIGHT = .38;
const EXIT_PHASE_TIMES = [0, .10, .23, .43, .62, .70, .78, 1];
const EXIT_PHASES = [1, .85, .70, .52, .32, .27, .18, 0];
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
  private faceMotion?: PersonFaceMotion;
  private seatMotion?: PersonSeatMotion;
  private groundMotion?: PersonGroundMotion;
  private runGroundOffset = 0;
  private steeringMotion?: PersonSteeringMotion;
  private driverVisibility?: PersonDriverVisibility;
  private driverView = false;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly stridePhases = new Map<string, number>();
  private readonly locomotion = { speed: 0, acceleration: 0, turnRate: 0 };
  private activeAction?: THREE.AnimationAction;
  private transition?: Transition;
  private readonly velocity = new THREE.Vector3();
  private readonly input = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly velocityChange = new THREE.Vector3();
  private readonly seatWorld = new THREE.Vector3();
  private readonly doorWorld = new THREE.Vector3();
  private readonly transferWorld = new THREE.Vector3();
  private readonly cabinInverse = new THREE.Matrix4();
  private readonly cabinPoint = new THREE.Vector3();
  private readonly cabinRotation = new THREE.Quaternion();
  private readonly soleRotation = new THREE.Quaternion();
  private readonly soleAxis = new THREE.Vector3();
  private readonly soleScale = new THREE.Vector3();
  private readonly footContacts: FootContacts = Object.fromEntries(['left', 'right'].map(side => [side,
    { position: new THREE.Vector3(), rotation: new THREE.Quaternion(), weight: 0 }]));
  private readonly footRest = new Map<string, { bone: THREE.Bone; rotation?: THREE.Quaternion; probes?: THREE.Vector3[] }>();
  private readonly armBones = new Map<string, THREE.Bone>();
  private readonly shoulderPoint = new THREE.Vector3();
  private readonly doorStance = new THREE.Vector3();
  private readonly handContacts: HandContacts = Object.fromEntries(['left', 'right'].map(side => [side,
    { position: new THREE.Vector3(), normal: new THREE.Vector3(), up: new THREE.Vector3(), weight: 0 }]));
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
  } = { asset: '/models/person/person-detailed-hands.glb?v=articulated-hands-v1', animations: [], height: 0, scale: PERSON_SCALE, meshes: 0,
    triangles: 0, collisionRadius: RADIUS, transitionSeconds: TRANSITION_SECONDS };
  private readonly ankleFloor = (ankle: THREE.Vector3, side: 'left' | 'right') => {
    const rest = this.footRest.get(side), contact = this.footContacts[side];
    rest?.bone.getWorldQuaternion(this.soleRotation);
    if (contact) this.soleRotation.slerp(contact.rotation, contact.weight);
    const street = this.getGroundHeight(ankle.x, ankle.z) + this.soleClearance(side, this.soleRotation);
    if (this.mode === 'walking') return street;
    this.cabinPoint.copy(ankle).applyMatrix4(this.cabinInverse);
    const cabinHeight = THREE.MathUtils.lerp(CABIN_ANKLE_HEIGHT, .55, smooth((this.cabinPoint.z + .14) / .16));
    if (this.mode === 'driving' && this.cabin) {
      // Solve the tilted cabin floor plane at this ankle's world X/Z.
      const e = this.cabinInverse.elements;
      return (cabinHeight - e[1] * ankle.x - e[9] * ankle.z - e[13]) / e[5];
    }
    const dx = ankle.x - this.lastCarPosition.x, dz = ankle.z - this.lastCarPosition.z;
    const lateralPosition = dx * Math.cos(this.lastCarYaw) - dz * Math.sin(this.lastCarYaw);
    // Lift the leading foot before it crosses the sill, then place both soles
    // on the cabin floor. The trailing foot can stay planted on the road.
    const inside = smooth((lateralPosition + 1.30) / .24);
    return THREE.MathUtils.lerp(street, this.lastCarPosition.y + cabinHeight, inside);
  };

  constructor(private readonly scene: THREE.Scene, private readonly collisionWorld: ColliderGrid,
    private readonly getGroundHeight: (x: number, z: number) => number,
    private readonly cabin?: THREE.Object3D,
    private readonly steeringWheel?: THREE.Object3D,
    private readonly driverDoor?: THREE.Object3D) {
    this.root.name = 'Player / original civilian';
    this.root.rotation.order = 'YXZ';
    this.root.userData.dynamic = true;
    this.root.visible = false;
    scene.add(this.root);
    new GLTFLoader().load(this.diagnosticState.asset, gltf => {
      if (this.disposed) { this.disposeModel(gltf.scene); return; }
      this.model = gltf.scene;
      this.model.name = 'Blender / rigged original driver';
      this.model.scale.multiplyScalar(PERSON_SCALE);
      this.model.traverse(object => {
        object.userData.dynamic = true;
        if (object instanceof THREE.Bone) {
          const side = object.name.toLowerCase().match(/(left|right)foot$/)?.[1];
          if (side) this.footRest.set(side, { bone: object });
          const arm = object.name.toLowerCase().match(/(left|right)arm$/)?.[1];
          if (arm) this.armBones.set(arm, object);
        }
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
      // Boot skinning changes between standing and seated poses. Calibrate the
      // road sole in its planted pose, rather than carrying seated skin offsets
      // into a standing ankle target that would buckle both knees.
      this.calibrateSoles();
      this.calibrateStridePhases();
      this.groundMotion = new PersonGroundMotion(this.model);
      this.calibrateRunGrounding();
      this.play('Seated', 0);
      this.mixer.update(0);
      this.idleMotion = new PersonIdleMotion(this.model);
      this.faceMotion = new PersonFaceMotion(this.model);
      this.seatMotion = new PersonSeatMotion(this.model);
      if (this.steeringWheel) this.steeringMotion = new PersonSteeringMotion(this.model, this.steeringWheel);
      this.driverVisibility = new PersonDriverVisibility(this.model);
      this.driverVisibility.setDriverView(this.driverView);
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
      steering: this.steeringMotion?.diagnostics,
      grounding: this.groundMotion?.diagnostics,
      driverVisibility: this.driverVisibility?.diagnostics,
      transitionProgress: this.transition ? this.transition.elapsed / this.transition.duration : 0,
      transitionSeconds: this.transition?.duration ?? TRANSITION_SECONDS,
      doorOpenAmount: this.doorOpenAmount, position: { x: this.position.x, y: this.position.y, z: this.position.z } };
  }

  /** Cockpit view keeps the rigged arms while clearing the camera's head volume. */
  setDriverView(enabled: boolean) {
    this.driverView = enabled;
    this.driverVisibility?.setDriverView(enabled);
  }

  update(delta: number, pressed: ReadonlySet<string>, carPosition: THREE.Vector3, carYaw: number,
    carSpeed: number, blockers: readonly VehicleBlocker[] = []) {
    if (this.disposed) return;
    const dt = THREE.MathUtils.clamp(delta, 0, .1);
    // Remove the last procedural pose before the mixer writes this frame.
    this.steeringMotion?.restore();
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.groundMotion?.restore();
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
    this.faceMotion?.update(dt);
    if (this.mode !== 'walking') {
      this.locomotion.speed = this.locomotion.acceleration = this.locomotion.turnRate = 0;
    }
    this.idleMotion?.update(dt, this.mode === 'walking' && this.speed < .10,
      this.mode === 'driving', this.transferDuck, this.mode === 'walking' ? this.locomotion : undefined);
    this.updateContacts();
    if (this.mode === 'walking') {
      const run = this.actions.get('Run');
      this.groundMotion?.update(this.ankleFloor, this.runGroundOffset * (run?.enabled ? run.getEffectiveWeight() : 0));
    }
    this.seatMotion?.update(this.ankleFloor, 1, this.footContacts);
    const progress = this.transition ? this.transition.elapsed / this.transition.duration : 0;
    const grip = this.mode === 'driving' ? 1
      : this.mode === 'exiting' ? 1 - smooth(progress / .10)
      : this.mode === 'entering' ? smooth((progress - .92) / .08) : 0;
    this.steeringMotion?.update(grip, this.handContacts);
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
    const duration = TRANSITION_SECONDS + Math.max(0, outside.distanceTo(doorway) - 1.1) / WALK_SPEED;
    this.transition = { elapsed: 0, outside, doorway, fromYaw: this.yaw, carYaw, duration };
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
    this.steeringMotion?.restore();
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.groundMotion?.restore();
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
    this.steeringMotion?.restore();
    this.idleMotion?.restore();
    this.seatMotion?.restore();
    this.groundMotion?.restore();
    this.mixer?.stopAllAction();
    this.driverVisibility?.dispose();
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
    // Preserve the same supporting leg when accelerating into a run. Captured
    // clips may begin at different points in a stride, so align their measured
    // left-foot contact phases rather than restarting both at frame zero.
    if ((name === 'Walk' || name === 'Run') && previous) {
      const previousName = this.canonicalClipName(previous.getClip().name);
      if (previousName === 'Walk' || previousName === 'Run') {
        const phase = previous.time / previous.getClip().duration - (this.stridePhases.get(previousName) ?? 0);
        action.time = THREE.MathUtils.euclideanModulo(phase + (this.stridePhases.get(name) ?? 0), 1)
          * action.getClip().duration;
      }
    }
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
    transfer.elapsed = Math.min(transfer.duration, transfer.elapsed + dt);
    const t = transfer.elapsed / transfer.duration;
    const exiting = this.mode === 'exiting';
    const u = this.transferPhase(t, exiting);
    if (this.cabin) {
      this.cabin.updateWorldMatrix(true, false);
      this.cabinInverse.copy(this.cabin.matrixWorld).invert();
      this.seatWorld.copy(SEAT).applyMatrix4(this.cabin.matrixWorld);
    } else this.localToWorld(SEAT.x, SEAT.y, SEAT.z, this.seatWorld);
    this.doorOpenAmount = smooth((u - .18) / .14) * (1 - smooth((u - .85) / .15));
    this.doorStance.copy(transfer.doorway);
    if (this.driverDoor) {
      this.driverDoor.rotation.y = -.96 * this.doorOpenAmount;
      this.driverDoor.updateWorldMatrix(true, false);
      this.doorStance.set(-.04, 0, 1.23).applyMatrix4(this.driverDoor.matrixWorld);
      this.doorStance.x -= .44 * Math.cos(transfer.carYaw);
      this.doorStance.z += .44 * Math.sin(transfer.carYaw);
      this.doorStance.y = this.getGroundHeight(this.doorStance.x, this.doorStance.z);
    }
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
      if (transfer.outside.distanceToSquared(transfer.doorway) > .02) {
        this.play('Walk', .12);
        const stepSpeed = transfer.outside.distanceTo(transfer.doorway) / (transfer.duration * (exiting ? .22 : .18));
        this.activeAction?.setEffectiveTimeScale(THREE.MathUtils.clamp(stepSpeed / (WALK_SPEED * PERSON_SCALE), .4, 1.45));
      }
    } else {
      // Follow the opening door outward, then step back to the sill while ducking.
      // This keeps the release handle within arm's reach instead of through the torso.
      this.transferWorld.lerpVectors(transfer.doorway, this.doorStance, this.doorOpenAmount);
      this.transferWorld.lerp(transfer.doorway, crouch);
      // Duck outside the sill before the torso moves through the open doorway.
      this.transferWorld.y = THREE.MathUtils.lerp(transfer.doorway.y,
        this.lastCarPosition.y - .14, crouch);
      this.position.lerpVectors(this.transferWorld, this.seatWorld, slide);
      this.yaw = doorwayYaw + Math.PI / 2 * smooth((u - .52) / .18);
      pose = u < .32 ? .25 * smooth((u - .18) / .14)
        : u < .46 ? .25 + .25 * crouch
          : u < .70 ? .50 + .34 * slide : .84 + .16 * settle;
      if (u < .32) {
        this.play('Walk', .12);
        this.activeAction?.setEffectiveTimeScale(exiting ? .9 : -.9);
      } else {
        const clip = exiting ? 'ExitCar' : 'EnterCar';
        if (this.activeAction !== this.actions.get(clip)) this.play(clip, .12, true);
        if (this.activeAction) {
          this.activeAction.setEffectiveTimeScale(0);
          this.activeAction.time = this.activeAction.getClip().duration * (exiting ? 1 - pose : pose);
        }
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

  /** Exit has time to release the wheel, push the door, stand, and step clear. */
  private transferPhase(t: number, exiting: boolean) {
    if (!exiting) return t;
    for (let i = 1; i < EXIT_PHASE_TIMES.length; i++) {
      if (t <= EXIT_PHASE_TIMES[i]) return THREE.MathUtils.lerp(EXIT_PHASES[i - 1], EXIT_PHASES[i],
        (t - EXIT_PHASE_TIMES[i - 1]) / (EXIT_PHASE_TIMES[i] - EXIT_PHASE_TIMES[i - 1]));
    }
    return 0;
  }

  /** Plant each foot independently and keep the reaching palm on the moving door. */
  private updateContacts() {
    for (const contact of Object.values(this.handContacts)) contact.weight = 0;
    for (const contact of Object.values(this.footContacts)) contact.weight = 0;
    if (this.mode === 'walking' || !this.cabin) return;
    this.cabin.updateWorldMatrix(true, false);
    this.cabinInverse.copy(this.cabin.matrixWorld).invert();
    this.cabin.getWorldQuaternion(this.cabinRotation);
    const transfer = this.transition;
    const u = transfer ? this.transferPhase(transfer.elapsed / transfer.duration, this.mode === 'exiting') : 1;
    for (const side of ['left', 'right'] as const) {
      const contact = this.footContacts[side]!;
      const rest = this.footRest.get(side);
      if (rest && !rest.rotation && this.mode === 'driving') {
        rest.rotation = rest.bone.getWorldQuaternion(new THREE.Quaternion())
          .premultiply(this.cabinRotation.clone().invert());
      }
      if (!rest?.rotation) continue;
      contact.rotation.copy(this.cabinRotation).multiply(rest.rotation);
      // Right foot leads into the footwell; the left remains outside for balance.
      const step = this.mode === 'driving' ? 1 : smooth((u - (side === 'right' ? .45 : .51)) / (side === 'right' ? .23 : .21));
      contact.position.set(side === 'left' ? -.435 : -.225, CABIN_ANKLE_HEIGHT, -.43).applyMatrix4(this.cabin.matrixWorld);
      if (transfer && step < 1) {
        this.localToWorld(-1.40, 0, .30 + (side === 'left' ? -.12 : .12), this.transferWorld);
        this.transferWorld.y = this.getGroundHeight(this.transferWorld.x, this.transferWorld.z) + this.soleClearance(side, contact.rotation);
        contact.position.lerpVectors(this.transferWorld, contact.position, step);
        contact.position.y += Math.sin(step * Math.PI) * .14;
      }
      contact.weight = this.mode === 'driving' ? 1 : smooth((u - .34) / .12);
    }
    if (!transfer || !this.driverDoor) return;
    // Update the hinge before sampling it: hands and door use the same frame.
    this.driverDoor.rotation.y = -.96 * this.doorOpenAmount;
    this.driverDoor.updateWorldMatrix(true, false);
    const left = this.handContacts.left!;
    const inside = u > .70;
    // Anchor offsets are in the authored hinge's local frame.
    left.position.set(inside ? .22 : -.04, .30, inside ? .80 : 1.23).applyMatrix4(this.driverDoor.matrixWorld);
    left.normal.set(inside ? 1 : -1, 0, 0).transformDirection(this.driverDoor.matrixWorld);
    left.up.set(0, 0, -1).transformDirection(this.driverDoor.matrixWorld);
    left.weight = inside ? smooth((u - .74) / .08) * (1 - smooth((u - .92) / .06))
      : smooth((u - .16) / .06) * (1 - smooth((u - .37) / .10));
    const right = this.handContacts.right!;
    right.position.set(-.12, .79, -.17).applyMatrix4(this.cabin.matrixWorld);
    right.normal.set(0, 1, 0).applyQuaternion(this.cabinRotation);
    right.up.set(0, 0, -1).applyQuaternion(this.cabinRotation);
    right.weight = smooth((u - .42) / .10) * (1 - smooth((u - .72) / .12)) * .85;
    this.model?.updateWorldMatrix(true, true);
    for (const side of ['left', 'right'] as const) {
      const contact = this.handContacts[side]!;
      const shoulder = this.armBones.get(side);
      if (shoulder && contact.weight > 0) {
        shoulder.getWorldPosition(this.shoulderPoint);
        // Release a contact as it leaves anatomical reach; never stretch an arm.
        contact.weight *= smooth((.62 - this.shoulderPoint.distanceTo(contact.position)) / .16);
      }
    }
  }

  /** Find the forward left-foot strike in each capture's cyclic timeline. */
  private calibrateStridePhases() {
    if (!this.model || !this.mixer) return;
    const left = this.footRest.get('left')?.bone;
    if (!left) return;
    for (const name of ['Walk', 'Run']) {
      this.play(name, 0);
      const action = this.actions.get(name);
      if (!action) continue;
      let forward = -Infinity, phase = 0;
      for (let sample = 0; sample < 64; sample++) {
        action.time = action.getClip().duration * sample / 64;
        this.mixer.update(0); this.model.updateWorldMatrix(true, true);
        left.getWorldPosition(this.soleAxis);
        this.model.worldToLocal(this.soleAxis);
        if (this.soleAxis.z > forward) { forward = this.soleAxis.z; phase = sample / 64; }
      }
      this.stridePhases.set(name, phase);
    }
  }

  /** Preserve the authored flight arc while bringing its lowest stance onto the road. */
  private calibrateRunGrounding() {
    if (!this.model || !this.mixer) return;
    this.play('Run', 0);
    const action = this.actions.get('Run');
    if (!action) return;
    const originY = this.model.getWorldPosition(this.from).y;
    let minimum = Infinity;
    for (let sample = 0; sample < 48; sample++) {
      action.time = action.getClip().duration * sample / 48;
      this.mixer.update(0); this.model.updateWorldMatrix(true, true);
      for (const [side, rest] of this.footRest) {
        rest.bone.getWorldPosition(this.soleAxis);
        const height = this.soleAxis.y - originY;
        rest.bone.getWorldQuaternion(this.soleRotation);
        minimum = Math.min(minimum, height - this.soleClearance(side, this.soleRotation));
      }
    }
    this.runGroundOffset = Number.isFinite(minimum) ? -Math.max(0, minimum) : 0;
  }

  /** Cache the planted boot silhouette once; runtime checks only a few points. */
  private calibrateSoles() {
    if (!this.model) return;
    this.model.updateWorldMatrix(true, true);
    const vertices = new Map<string, THREE.Vector3[]>([['left', []], ['right', []]]);
    const inverses = new Map([...this.footRest].map(([side, rest]) => [side, rest.bone.matrixWorld.clone().invert()]));
    this.model.traverse(mesh => {
      if (!(mesh instanceof THREE.SkinnedMesh)) return;
      const joints = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
      if (!joints || !weights) return;
      const sides = mesh.skeleton.bones.map(bone => bone.name.toLowerCase().match(/(left|right)(?:foot|toe)/)?.[1]);
      mesh.skeleton.update();
      for (let vertex = 0; vertex < joints.count; vertex++) {
        for (const side of ['left', 'right']) {
          let weight = 0;
          for (let component = 0; component < 4; component++) {
            if (sides[joints.getComponent(vertex, component)] === side) weight += weights.getComponent(vertex, component);
          }
          const inverse = inverses.get(side);
          if (weight < .5 || !inverse) continue;
          mesh.getVertexPosition(vertex, this.soleAxis).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
          vertices.get(side)!.push(this.soleAxis.clone());
        }
      }
    });
    for (const [side, points] of vertices) {
      const probes = new Set<THREE.Vector3>();
      for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
        if (!x && !y && !z || !points.length) continue;
        this.soleAxis.set(x, y, z);
        let extreme = points[0], distance = -Infinity;
        for (const point of points) {
          const value = point.dot(this.soleAxis);
          if (value > distance) { distance = value; extreme = point; }
        }
        probes.add(extreme);
      }
      const rest = this.footRest.get(side);
      if (rest) rest.probes = [...probes];
    }
  }

  private soleClearance(side: string, rotation: THREE.Quaternion) {
    const rest = this.footRest.get(side);
    if (!rest?.probes?.length) return ROAD_ANKLE_CLEARANCE;
    rest.bone.getWorldScale(this.soleScale);
    let lowest = Infinity;
    for (const point of rest.probes) {
      lowest = Math.min(lowest, this.soleAxis.copy(point).multiply(this.soleScale).applyQuaternion(rotation).y);
    }
    return Math.max(.04, -lowest + .010);
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
    const previousSpeed = this.speed, previousYaw = this.yaw;
    // Bounded acceleration gives starts, stops and reversals a brief weight
    // transfer, without letting an exponentially smoothed velocity creep on.
    const braking = !moving || this.velocity.dot(this.desiredVelocity) < 0
      || this.desiredVelocity.lengthSq() < this.velocity.lengthSq();
    const change = this.velocityChange.copy(this.desiredVelocity).sub(this.velocity);
    const maximumChange = (braking ? 12 : running ? 7.5 : 6.5) * dt;
    if (change.lengthSq() > maximumChange * maximumChange) change.setLength(maximumChange);
    this.velocity.add(change);
    this.from.copy(this.position);
    this.moveWithSlide(dt);
    this.speed = dt > 0 ? Math.hypot(this.position.x - this.from.x, this.position.z - this.from.z) / dt : 0;
    if (this.speed > .05) {
      // Face the travelled direction, including collision sliding. The torso
      // follows a bounded turn instead of snapping to a new input direction.
      const desiredYaw = Math.atan2(this.position.x - this.from.x, this.position.z - this.from.z);
      const maximumTurn = THREE.MathUtils.lerp(5.8, 4.3, Math.min(1, this.speed / RUN_SPEED)) * dt;
      this.yaw += THREE.MathUtils.clamp(angleDifference(desiredYaw, this.yaw) * (1 - Math.exp(-dt * 14)),
        -maximumTurn, maximumTurn);
    }
    this.locomotion.speed = this.speed;
    this.locomotion.acceleration = dt > 0 ? (this.speed - previousSpeed) / dt : 0;
    this.locomotion.turnRate = dt > 0 ? angleDifference(this.yaw, previousYaw) / dt : 0;
    this.resolveVehicleOverlap();
    this.position.y = this.getGroundHeight(this.position.x, this.position.z);
    const runThreshold = this.activeAction === this.actions.get('Run') ? 2.15 : 2.45;
    const animation = this.speed < .10 ? 'Idle' : this.speed > runThreshold ? 'Run' : 'Walk';
    this.play(animation, animation === 'Idle' ? .32 : .20);
    if (animation !== 'Idle') for (const name of ['Walk', 'Run']) {
      const action = this.actions.get(name);
      if (!action?.enabled || action.getEffectiveWeight() < .0001 && action !== this.activeAction) continue;
      // Both clips must follow distance during their overlap; otherwise the
      // fading walk keeps stepping at its old speed while the run accelerates.
      const strideSpeed = (name === 'Run' ? RUN_SPEED : WALK_SPEED) * PERSON_SCALE;
      action.setEffectiveTimeScale(THREE.MathUtils.clamp(this.speed / strideSpeed, .06, 2.0));
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
    if (!this.clearDoorSwing()) return undefined;
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

  private clearDoorSwing() {
    if (!this.driverDoor) return true;
    const hinge = this.driverDoor.position;
    const previous = this.localToWorld(-1.40, 0, .30, new THREE.Vector3());
    previous.y = this.getGroundHeight(previous.x, previous.z);
    const point = new THREE.Vector3();
    for (const angle of [.24, .48, .72, .96]) {
      this.localToWorld(hinge.x - .04 * Math.cos(angle) - 1.23 * Math.sin(angle) - .44, 0,
        hinge.z - .04 * Math.sin(angle) + 1.23 * Math.cos(angle), point);
      point.y = this.getGroundHeight(point.x, point.z);
      if (!this.clearStandingPosition(point) || this.firstContact(previous, point, false)) return false;
      previous.copy(point);
    }
    return true;
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
      this.interactionAvailable = this.clearStandingPosition(sill) && this.clearDoorSwing() && !this.firstContact(this.position, sill, false);
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
