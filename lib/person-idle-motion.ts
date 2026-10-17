import * as THREE from 'three';

type Joint = 'Spine' | 'Spine1' | 'Spine2' | 'Neck' | 'Head';

type MotionBone = {
  bone: THREE.Bone;
  joint: Joint;
  base: THREE.Quaternion;
  modified: boolean;
};
type HierarchyNode = { object: THREE.Object3D; motion?: MotionBone };
export type LocomotionMotion = { speed: number; acceleration: number; turnRate: number };

const JOINTS: readonly Joint[] = [
  'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
];
const ease = (t: number) => t * t * (3 - 2 * t);

/** An occasional gesture with a gradual start, brief hold, and gradual release. */
function gesture(time: number, period: number, start: number, rise: number, hold: number, fall: number) {
  const t = time % period - start;
  if (t <= 0 || t >= rise + hold + fall) return 0;
  if (t < rise) return ease(t / rise);
  if (t < rise + hold) return 1;
  return 1 - ease((t - rise - hold) / fall);
}

/** Head glances, seated breathing, and torso support for travel and doorways. */
export class PersonIdleMotion {
  private readonly bones: MotionBone[] = [];
  private readonly hierarchy: HierarchyNode[] = [];
  private readonly modelRotation = new THREE.Quaternion();
  private readonly boneRotation = new THREE.Quaternion();
  private readonly localBasis = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly localRotation = new THREE.Quaternion();
  private readonly angles = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private time = 0;
  private idleTime = 0;
  private wasStanding = false;
  private standingWeight = 0;
  private seatedWeight = 0;
  private travelPitch = 0;
  private travelRoll = 0;

  constructor(private readonly model: THREE.Group) {
    const motions = new Map<THREE.Object3D, MotionBone>();
    const ancestors = new Set<THREE.Object3D>();
    model.traverse(object => {
      if (!(object instanceof THREE.Bone)) return;
      // GLTFLoader removes punctuation from Mixamo's original bone names.
      const name = object.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const joint = JOINTS.find(candidate => name.endsWith(candidate.toLowerCase()));
      if (!joint) return;
      const motion: MotionBone = { bone: object, joint, base: new THREE.Quaternion(), modified: false };
      this.bones.push(motion);
      motions.set(object, motion);
      for (let node: THREE.Object3D | null = object; node && node !== model; node = node.parent) {
        ancestors.add(node);
      }
    });
    // Traversal order puts every ancestor before its children, including the
    // imported armature's intermediate transforms and unmodified bones.
    model.traverse(object => {
      if (ancestors.has(object)) this.hierarchy.push({ object, motion: motions.get(object) });
    });
  }

  /** Call before advancing the mixer so procedural rotations never accumulate. */
  restore() {
    for (const motion of this.bones) {
      if (!motion.modified) continue;
      motion.bone.quaternion.copy(motion.base);
      motion.modified = false;
    }
  }

  /** Call after the mixer; ducking bends the authored pose to clear a doorway. */
  update(dt: number, standing: boolean, seated: boolean, duck = 0, locomotion?: LocomotionMotion) {
    const delta = Math.max(0, dt);
    const bend = THREE.MathUtils.clamp(duck, 0, 1);
    this.time += delta;
    if (standing && !this.wasStanding) this.idleTime = 0;
    if (standing) this.idleTime += delta;
    this.wasStanding = standing;
    this.standingWeight += (Number(standing) - this.standingWeight)
      * (1 - Math.exp(-delta * (standing ? 3.8 : 12)));
    // A doorway motion takes over immediately from the standing head glances.
    if (bend > 0 && !standing) this.standingWeight = 0;
    this.seatedWeight += (Number(seated) - this.seatedWeight)
      * (1 - Math.exp(-delta * (seated ? 3.5 : 12)));
    if (locomotion) {
      const movingWeight = THREE.MathUtils.smoothstep(locomotion.speed, .08, 1.2);
      // The capture supplies the leg mechanics. Only distribute a restrained
      // weight shift through the torso for acceleration and cornering, with a
      // stabilising neck response so the gaze does not bob with the chest.
      const pitch = movingWeight * (.025 * Math.min(1, locomotion.speed / 4.3)
        + THREE.MathUtils.clamp(locomotion.acceleration * .007, -.040, .055));
      const roll = movingWeight * THREE.MathUtils.clamp(-Math.atan(locomotion.speed * locomotion.turnRate / 9.81) * .23, -.12, .12);
      const response = 1 - Math.exp(-delta * 9);
      this.travelPitch += (pitch - this.travelPitch) * response;
      this.travelRoll += (roll - this.travelRoll) * response;
    } else {
      // Clear at once on entry so a road corner cannot affect the seated arms.
      this.travelPitch = this.travelRoll = 0;
    }
    const stand = this.standingWeight, sit = this.seatedWeight;
    if (stand + sit + bend + Math.abs(this.travelPitch) + Math.abs(this.travelRoll) < .0001) return;

    const t = this.time;
    // Start the head-glance sequence after each stop. Standing shoulders and
    // arms stay in the relaxed pose instead of performing idle gestures.
    const gestureTime = standing || stand > .01 ? this.idleTime : t;
    const glance = .68 * gesture(gestureTime, 19.8, .8, 1.2, 1.4, 1.9)
      - .62 * gesture(gestureTime, 19.8, 7.4, 1.4, 1.2, 2.0)
      + .035 * Math.sin(t * .49 + .7);
    const lookDown = gesture(gestureTime, 23.7, 14.0, 1.0, .7, 1.5);
    const breath = Math.sin(t * Math.PI * 2 / 4.8)
      + .24 * Math.sin(t * Math.PI * 2 / 7.2 + 1.1);
    const headWeight = stand + sit * .44;

    this.model.updateWorldMatrix(true, false);
    this.model.matrixWorld.decompose(this.position, this.modelRotation, this.scale);
    for (const node of this.hierarchy) {
      node.object.updateWorldMatrix(false, false);
      const motion = node.motion;
      if (!motion) continue;
      let pitch = 0, yaw = 0, roll = 0;
      switch (motion.joint) {
        case 'Spine':
          pitch = bend * .23 + this.travelPitch * .42;
          roll = this.travelRoll * .42;
          break;
        case 'Spine1':
          pitch = sit * .0015 * breath + bend * .24 + this.travelPitch * .33;
          roll = this.travelRoll * .33;
          break;
        case 'Spine2':
          pitch = sit * .0015 * breath + bend * .18 + this.travelPitch * .25;
          roll = this.travelRoll * .25;
          break;
        case 'Neck':
          pitch = headWeight * (.035 * lookDown + .013 * Math.sin(t * .37 + 1.3)) + bend * .055 - this.travelPitch * .25;
          yaw = headWeight * .28 * glance;
          roll = headWeight * .007 * Math.sin(t * .31 + .5) - this.travelRoll * .20;
          break;
        case 'Head':
          pitch = headWeight * (.14 * lookDown + .022 * Math.sin(t * .37 + .8)) + bend * .075 - this.travelPitch * .35;
          yaw = headWeight * .69 * glance;
          roll = headWeight * .012 * Math.sin(t * .31 + 1.1) - this.travelRoll * .30;
          break;
      }
      if (Math.abs(pitch) + Math.abs(yaw) + Math.abs(roll) < .000001) continue;
      this.apply(motion, pitch, yaw, roll);
    }
  }

  private apply(motion: MotionBone, pitch: number, yaw: number, roll: number) {
    const bone = motion.bone;
    motion.base.copy(bone.quaternion);
    motion.modified = true;
    bone.matrixWorld.decompose(this.position, this.boneRotation, this.scale);
    // Imported bone rolls differ. Conjugation converts character-space axes
    // into this bone's current local frame without assuming its Euler axes.
    this.localBasis.copy(this.boneRotation).invert().multiply(this.modelRotation);
    this.rotation.setFromEuler(this.angles.set(pitch, yaw, roll, 'YXZ'));
    this.localRotation.copy(this.localBasis).multiply(this.rotation);
    this.localRotation.multiply(this.localBasis.invert());
    bone.quaternion.multiply(this.localRotation).normalize();
    bone.updateWorldMatrix(false, false);
  }
}
