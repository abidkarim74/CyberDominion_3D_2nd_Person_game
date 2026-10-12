import * as THREE from 'three';

type MotionJoint = { bone: THREE.Bone; base: THREE.Quaternion; modified: boolean };
type Leg = { upper: MotionJoint; lower: MotionJoint; foot: MotionJoint };

/** Fits the authored legs above the road or cabin footwell without moving the hips. */
export class PersonSeatMotion {
  private readonly legs: Leg[] = [];
  private readonly hip = new THREE.Vector3();
  private readonly knee = new THREE.Vector3();
  private readonly ankle = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly desiredKnee = new THREE.Vector3();
  private readonly before = new THREE.Vector3();
  private readonly after = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly worldRotation = new THREE.Quaternion();
  private readonly parentRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly footRotation = new THREE.Quaternion();
  private readonly modelRotation = new THREE.Quaternion();

  constructor(private readonly model: THREE.Group) {
    const bones = new Map<string, THREE.Bone>();
    model.traverse(object => {
      if (!(object instanceof THREE.Bone)) return;
      const name = object.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const side of ['left', 'right']) for (const joint of ['upleg', 'leg', 'foot']) {
        if (name.endsWith(`${side}${joint}`)) bones.set(`${side}${joint}`, object);
      }
    });
    const motion = (bone: THREE.Bone): MotionJoint => ({ bone, base: new THREE.Quaternion(), modified: false });
    for (const side of ['left', 'right']) {
      const upper = bones.get(`${side}upleg`), lower = bones.get(`${side}leg`), foot = bones.get(`${side}foot`);
      if (upper && lower && foot) this.legs.push({ upper: motion(upper), lower: motion(lower), foot: motion(foot) });
    }
  }

  /** Restore before the animation mixer writes the next pose. */
  restore() {
    for (const leg of this.legs) for (const joint of [leg.upper, leg.lower, leg.foot]) {
      if (!joint.modified) continue;
      joint.bone.quaternion.copy(joint.base);
      joint.modified = false;
    }
  }

  /** Apply after animation and torso overlays; minAnkleY is a world-space height. */
  update(minAnkleY: number | ((anklePosition: THREE.Vector3) => number), weight = 1) {
    const blend = THREE.MathUtils.clamp(weight, 0, 1);
    if (typeof minAnkleY === 'number' && !Number.isFinite(minAnkleY) || blend < .000001) return;
    this.model.updateWorldMatrix(true, true);
    this.model.getWorldQuaternion(this.modelRotation);
    for (const leg of this.legs) {
      const upper = leg.upper.bone, lower = leg.lower.bone, foot = leg.foot.bone;
      upper.getWorldPosition(this.hip);
      lower.getWorldPosition(this.knee);
      foot.getWorldPosition(this.ankle);
      const floor = typeof minAnkleY === 'number' ? minAnkleY : minAnkleY(this.ankle);
      if (!Number.isFinite(floor)) continue;
      const lift = (floor - this.ankle.y) * blend;
      if (lift <= .000001) continue;
      const thighLength = this.hip.distanceTo(this.knee), shinLength = this.knee.distanceTo(this.ankle);
      if (thighLength < .00001 || shinLength < .00001) continue;
      for (const joint of [leg.upper, leg.lower, leg.foot]) {
        joint.base.copy(joint.bone.quaternion);
        joint.modified = true;
      }
      foot.getWorldQuaternion(this.footRotation);
      this.target.copy(this.ankle); this.target.y += lift;
      this.axis.subVectors(this.target, this.hip);
      const requestedReach = this.axis.length();
      if (requestedReach < .000001) continue;
      this.axis.multiplyScalar(1 / requestedReach);
      const reach = THREE.MathUtils.clamp(requestedReach,
        Math.abs(thighLength - shinLength) + .00001, thighLength + shinLength - .00001);
      this.target.copy(this.hip).addScaledVector(this.axis, reach);
      // Retain the captured knee's bending side. Near a straight leg, use the
      // character's forward direction instead of choosing an unstable plane.
      this.before.subVectors(this.ankle, this.hip).normalize();
      this.bend.subVectors(this.knee, this.hip);
      this.bend.addScaledVector(this.before, -this.bend.dot(this.before));
      if (this.bend.lengthSq() < .000001) {
        this.forward.set(0, 0, 1).applyQuaternion(this.modelRotation);
        this.bend.copy(this.forward).addScaledVector(this.before, -this.forward.dot(this.before));
      }
      if (this.bend.lengthSq() < .000001) {
        this.bend.set(1, 0, 0).addScaledVector(this.before, -this.before.x);
      }
      this.rotation.setFromUnitVectors(this.before, this.axis);
      this.bend.applyQuaternion(this.rotation);
      this.bend.normalize();
      const along = (thighLength * thighLength - shinLength * shinLength + reach * reach) / (2 * reach);
      const perpendicular = Math.sqrt(Math.max(0, thighLength * thighLength - along * along));
      this.desiredKnee.copy(this.hip).addScaledVector(this.axis, along).addScaledVector(this.bend, perpendicular);
      this.before.subVectors(this.knee, this.hip);
      this.after.subVectors(this.desiredKnee, this.hip);
      this.aim(upper, this.before, this.after);
      upper.updateWorldMatrix(true, true);
      lower.getWorldPosition(this.knee);
      foot.getWorldPosition(this.ankle);
      this.before.subVectors(this.ankle, this.knee);
      this.after.subVectors(this.target, this.knee);
      this.aim(lower, this.before, this.after);
      lower.updateWorldMatrix(true, true);
      // Raising an ankle must not pitch or roll the sole with the new shin pose.
      foot.parent!.getWorldQuaternion(this.parentRotation);
      foot.quaternion.copy(this.parentRotation.invert()).multiply(this.footRotation);
      foot.updateWorldMatrix(true, true);
    }
  }

  private aim(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) {
    bone.getWorldQuaternion(this.worldRotation);
    bone.parent!.getWorldQuaternion(this.parentRotation);
    this.rotation.setFromUnitVectors(from.normalize(), to.normalize());
    this.worldRotation.premultiply(this.rotation);
    bone.quaternion.copy(this.parentRotation.invert()).multiply(this.worldRotation);
  }
}
