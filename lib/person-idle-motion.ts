import * as THREE from 'three';

type Joint = 'Spine' | 'Spine1' | 'Spine2' | 'Neck' | 'Head'
  | 'LeftShoulder' | 'RightShoulder' | 'LeftArm' | 'RightArm'
  | 'LeftForeArm' | 'RightForeArm' | 'LeftHand' | 'RightHand';

type MotionBone = {
  bone: THREE.Bone;
  joint: Joint;
  base: THREE.Quaternion;
  modified: boolean;
};
type HierarchyNode = { object: THREE.Object3D; motion?: MotionBone };

const JOINTS: readonly Joint[] = [
  'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm',
  'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand',
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

/** Small human idle gestures layered over the model's existing animation. */
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
  update(dt: number, standing: boolean, seated: boolean, duck = 0) {
    const delta = Math.max(0, dt);
    const bend = THREE.MathUtils.clamp(duck, 0, 1);
    this.time += delta;
    if (standing && !this.wasStanding) this.idleTime = 0;
    if (standing) this.idleTime += delta;
    this.wasStanding = standing;
    this.standingWeight += (Number(standing) - this.standingWeight)
      * (1 - Math.exp(-delta * (standing ? 3.8 : 12)));
    // A doorway motion takes over immediately from standing gestures. Clearing
    // the weight also prevents a fading hand adjustment returning on release.
    if (bend > 0 && !standing) this.standingWeight = 0;
    this.seatedWeight += (Number(seated) - this.seatedWeight)
      * (1 - Math.exp(-delta * (seated ? 3.5 : 12)));
    const stand = this.standingWeight, sit = this.seatedWeight;
    if (stand + sit + bend < .0001) return;

    const t = this.time;
    // Start a new idle sequence after each stop. A glance and a hand adjustment
    // arrive within the first few seconds, then alternate with relaxed pauses.
    const gestureTime = standing || stand > .01 ? this.idleTime : t;
    const glance = .68 * gesture(gestureTime, 19.8, .8, 1.2, 1.4, 1.9)
      - .62 * gesture(gestureTime, 19.8, 7.4, 1.4, 1.2, 2.0)
      + .035 * Math.sin(t * .49 + .7);
    const lookDown = gesture(gestureTime, 23.7, 14.0, 1.0, .7, 1.5);
    const leftAdjust = gesture(gestureTime, 17.4, 2.6, 1.1, .9, 1.8);
    const rightAdjust = gesture(gestureTime, 21.2, 9.0, 1.3, .9, 1.9);
    const breath = Math.sin(t * Math.PI * 2 / 4.8)
      + .24 * Math.sin(t * Math.PI * 2 / 7.2 + 1.1);
    const sway = .025 * Math.sin(t * .63) + .010 * Math.sin(t * .29 + 1.4);
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
          pitch = stand * (.008 * breath + .006 * Math.sin(t * .23)) + bend * .23;
          yaw = stand * .07 * glance;
          roll = stand * sway * .40;
          break;
        case 'Spine1':
          pitch = stand * .010 * breath + sit * .0015 * breath + bend * .24;
          yaw = stand * .09 * glance;
          roll = stand * sway * .32;
          break;
        case 'Spine2':
          pitch = stand * .012 * breath + sit * .0015 * breath + bend * .18;
          yaw = stand * .13 * glance;
          roll = stand * sway * .28;
          break;
        case 'Neck':
          pitch = headWeight * (.035 * lookDown + .013 * Math.sin(t * .37 + 1.3)) + bend * .055;
          yaw = headWeight * .28 * glance;
          roll = headWeight * .007 * Math.sin(t * .31 + .5);
          break;
        case 'Head':
          pitch = headWeight * (.14 * lookDown + .022 * Math.sin(t * .37 + .8)) + bend * .075;
          yaw = headWeight * .69 * glance;
          roll = headWeight * .012 * Math.sin(t * .31 + 1.1);
          break;
        case 'LeftShoulder':
          pitch = stand * (.015 * breath - .025 * leftAdjust);
          roll = stand * .025 * leftAdjust;
          break;
        case 'RightShoulder':
          pitch = stand * (.012 * breath - .028 * rightAdjust);
          roll = -stand * .026 * rightAdjust;
          break;
        case 'LeftArm':
          pitch = stand * (-.16 * leftAdjust + .018 * Math.sin(t * .63 + 1.7));
          roll = stand * (.065 * leftAdjust + .012 * Math.sin(t * .47));
          break;
        case 'RightArm':
          pitch = stand * (-.20 * rightAdjust + .016 * Math.sin(t * .59 + .4));
          roll = -stand * (.070 * rightAdjust + .012 * Math.sin(t * .44 + .8));
          break;
        case 'LeftForeArm':
          pitch = -stand * .75 * leftAdjust;
          yaw = stand * .07 * leftAdjust;
          break;
        case 'RightForeArm':
          pitch = -stand * .95 * rightAdjust;
          yaw = -stand * .08 * rightAdjust;
          break;
        case 'LeftHand':
          pitch = stand * (.14 * leftAdjust + .018 * Math.sin(t * .63 + 2.1));
          yaw = stand * .13 * leftAdjust;
          roll = stand * .070 * leftAdjust;
          break;
        case 'RightHand':
          pitch = stand * (.17 * rightAdjust + .016 * Math.sin(t * .59 + .9));
          yaw = -stand * .13 * rightAdjust;
          roll = -stand * .080 * rightAdjust;
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
