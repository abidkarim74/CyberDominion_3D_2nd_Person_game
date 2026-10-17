import * as THREE from 'three';

type MotionJoint = { bone: THREE.Bone; base: THREE.Quaternion; modified: boolean };
type FingerJoint = MotionJoint & { axis: THREE.Vector3; angle: number };
export type HandContact = { position: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3; weight: number };
export type HandContacts = Partial<Record<'left' | 'right', HandContact>>;
type Arm = {
  side: 'left' | 'right'; sign: number;
  shoulder?: MotionJoint; upper: MotionJoint; lower: MotionJoint; hand: MotionJoint;
  joints: MotionJoint[]; fingers: FingerJoint[];
  palm: THREE.Vector3; handBasisInverse: THREE.Quaternion;
  target: THREE.Vector3; actual: THREE.Vector3; error: number;
};

/** Keeps the character's own rigged hands on the moving physical steering rim. */
export class PersonSteeringMotion {
  private readonly arms: Arm[] = [];
  private readonly shoulder = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly targetWrist = new THREE.Vector3();
  private readonly desiredElbow = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly long = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly parentRotation = new THREE.Quaternion();
  private readonly worldRotation = new THREE.Quaternion();
  private readonly wheelRotation = new THREE.Quaternion();
  private readonly columnRotation = new THREE.Quaternion();
  private readonly handRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly identity = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();
  private appliedWeight = 0;

  constructor(private readonly model: THREE.Group, private readonly steeringWheel: THREE.Object3D) {
    const bones = new Map<string, THREE.Bone>();
    model.traverse(object => {
      if ((object as THREE.Bone).isBone) bones.set(object.name.toLowerCase().replace(/[^a-z0-9]/g, ''), object as THREE.Bone);
    });
    const find = (suffix: string) => {
      for (const [name, bone] of bones) if (name.endsWith(suffix)) return bone;
      return undefined;
    };
    const joint = (bone: THREE.Bone): MotionJoint => ({ bone, base: new THREE.Quaternion(), modified: false });
    model.updateWorldMatrix(true, true);
    for (const side of ['left', 'right'] as const) {
      const upper = find(`${side}arm`), lower = find(`${side}forearm`), hand = find(`${side}hand`);
      if (!upper || !lower || !hand) continue;
      const middle = find(`${side}handmiddle1`), index = find(`${side}handindex1`), pinky = find(`${side}handpinky1`);
      const thumb = find(`${side}handthumb1`);
      // Build a palm frame from the rig, rather than assuming imported bone rolls.
      this.long.copy(middle?.position ?? new THREE.Vector3(0, 20, 0)).normalize();
      if (index && pinky) this.across.subVectors(index.position, pinky.position).normalize();
      else this.across.set(side === 'left' ? -1 : 1, 0, 0);
      this.normal.crossVectors(this.long, this.across).normalize();
      if (thumb && this.normal.dot(thumb.position) < 0) this.normal.negate();
      this.across.crossVectors(this.long, this.normal).normalize();
      this.normal.crossVectors(this.across, this.long).normalize();
      const palmLength = middle?.position.length() ?? 20;
      const palm = this.long.clone().multiplyScalar(palmLength * .57).addScaledVector(this.normal, palmLength * .095);
      this.basis.makeBasis(this.across, this.long, this.normal);
      const handBasisInverse = new THREE.Quaternion().setFromRotationMatrix(this.basis).invert();
      const shoulderBone = find(`${side}shoulder`);
      const shoulder = shoulderBone ? joint(shoulderBone) : undefined;
      const u = joint(upper), l = joint(lower), h = joint(hand);
      const fingers: FingerJoint[] = [];
      hand.getWorldQuaternion(this.worldRotation);
      this.normal.applyQuaternion(this.worldRotation);
      for (const [name, bone] of bones) {
        const match = name.match(new RegExp(`${side}hand(index|middle|ring|pinky|thumb)([123])$`));
        if (!match) continue;
        const child = bone.children.find(object => (object as THREE.Bone).isBone) as THREE.Bone | undefined;
        if (!child) continue;
        bone.getWorldQuaternion(this.parentRotation);
        const normal = this.normal.clone().applyQuaternion(this.parentRotation.invert());
        const axis = new THREE.Vector3().crossVectors(child.position, normal).normalize();
        const stage = Number(match[2]);
        // The fingers wrap over the front of the 38mm leather rim; the thumb
        // closes gently against its inner edge rather than forming a full fist.
        const angle = match[1] === 'thumb' ? (stage === 1 ? .28 : .55)
          : stage === 1 ? .56 : stage === 2 ? 1.05 : .82;
        fingers.push({ ...joint(bone), axis, angle });
      }
      const joints = [...(shoulder ? [shoulder] : []), u, l, h, ...fingers];
      this.arms.push({ side, sign: side === 'left' ? -1 : 1, shoulder, upper: u, lower: l, hand: h,
        joints, fingers, palm, handBasisInverse, target: new THREE.Vector3(), actual: new THREE.Vector3(), error: 0 });
    }
  }

  /** Restore first, before other overlays restore and the animation mixer runs. */
  restore() {
    for (const arm of this.arms) for (const joint of arm.joints) {
      if (!joint.modified) continue;
      joint.bone.quaternion.copy(joint.base);
      joint.modified = false;
    }
    this.appliedWeight = 0;
  }

  /** Apply after the mixer and torso overlays, after the wheel's current rotation. */
  update(weight = 1, contacts?: HandContacts) {
    const wheelWeight = Number.isFinite(weight) ? THREE.MathUtils.clamp(weight, 0, 1) : 0;
    if (wheelWeight < .000001 && !contacts || !this.arms.length) return;
    this.appliedWeight = wheelWeight;
    this.model.updateWorldMatrix(true, true);
    this.steeringWheel.updateWorldMatrix(true, false);
    this.steeringWheel.getWorldQuaternion(this.wheelRotation);
    (this.steeringWheel.parent ?? this.steeringWheel).getWorldQuaternion(this.columnRotation);
    for (const arm of this.arms) {
      const contact = contacts?.[arm.side];
      const contactWeight = THREE.MathUtils.clamp(contact?.weight ?? 0, 0, 1);
      const blend = THREE.MathUtils.clamp(wheelWeight + contactWeight, 0, 1);
      if (blend < .000001) continue;
      const upper = arm.upper.bone, lower = arm.lower.bone, hand = arm.hand.bone;
      for (const joint of arm.joints) { joint.base.copy(joint.bone.quaternion); joint.modified = true; }
      // Grip slightly above nine and three o'clock. Local targets inherit the
      // actual wheel's steering, cabin pitch/roll, and vehicle world transform.
      arm.target.set(arm.sign * .155, .025, .019).applyMatrix4(this.steeringWheel.matrixWorld);
      this.long.set(-arm.sign * .12, .85, -.50).normalize().applyQuaternion(this.wheelRotation);
      this.normal.set(-arm.sign * .38, -.10, -1).normalize().applyQuaternion(this.wheelRotation);
      if (contact && contactWeight > 0) {
        const influence = contactWeight / (contactWeight + wheelWeight);
        arm.target.lerp(contact.position, influence);
        this.long.lerp(contact.up, influence).normalize();
        this.normal.lerp(contact.normal, influence).normalize();
      }
      this.normal.addScaledVector(this.long, -this.normal.dot(this.long)).normalize();
      this.across.crossVectors(this.long, this.normal).normalize();
      this.normal.crossVectors(this.across, this.long).normalize();
      this.basis.makeBasis(this.across, this.long, this.normal);
      this.handRotation.setFromRotationMatrix(this.basis).multiply(arm.handBasisInverse);
      hand.getWorldScale(this.scale);
      this.offset.copy(arm.palm).multiply(this.scale).applyQuaternion(this.handRotation);
      this.targetWrist.copy(arm.target).sub(this.offset);
      upper.getWorldPosition(this.shoulder); lower.getWorldPosition(this.elbow); hand.getWorldPosition(this.wrist);
      const upperLength = this.shoulder.distanceTo(this.elbow), lowerLength = this.elbow.distanceTo(this.wrist);
      if (upperLength < .00001 || lowerLength < .00001) continue;

      // A modest clavicle reach allows the outside arm to follow the high side
      // of a turned wheel. This rotates the authored bone and never stretches it.
      if (arm.shoulder) {
        const requested = this.shoulder.distanceTo(this.targetWrist);
        if (requested > (upperLength + lowerLength) * .91) {
          arm.shoulder.bone.getWorldPosition(this.wrist);
          this.from.subVectors(this.shoulder, this.wrist).normalize();
          this.to.subVectors(this.targetWrist, this.wrist).normalize();
          this.rotation.setFromUnitVectors(this.from, this.to);
          const angle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(this.rotation.w), 0, 1));
          const reachAngle = Math.min(.64, Math.max(0, requested / (upperLength + lowerLength) - .91) * 4);
          this.rotation.slerp(this.identity, 1 - Math.min(1, reachAngle / Math.max(.00001, angle)));
          this.rotateWorld(arm.shoulder.bone, this.rotation);
          arm.shoulder.bone.updateWorldMatrix(true, true);
          upper.getWorldPosition(this.shoulder);
        }
      }

      this.axis.subVectors(this.targetWrist, this.shoulder);
      const requested = this.axis.length();
      if (requested < .000001) continue;
      this.axis.multiplyScalar(1 / requested);
      const reach = THREE.MathUtils.clamp(requested,
        Math.abs(upperLength - lowerLength) + .00001, upperLength + lowerLength - .00001);
      this.targetWrist.copy(this.shoulder).addScaledVector(this.axis, reach);
      // Elbows stay down and out relative to the column, independently of the
      // wheel's own spin, so steering does not flip an elbow's bend plane.
      this.pole.set(arm.sign * .42, -.86, .28).applyQuaternion(this.columnRotation);
      this.pole.addScaledVector(this.axis, -this.pole.dot(this.axis));
      if (this.pole.lengthSq() < .000001) this.pole.set(1, 0, 0).addScaledVector(this.axis, -this.axis.x);
      this.pole.normalize();
      const along = (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach);
      const bend = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
      this.desiredElbow.copy(this.shoulder).addScaledVector(this.axis, along).addScaledVector(this.pole, bend);
      lower.getWorldPosition(this.elbow);
      this.from.subVectors(this.elbow, this.shoulder); this.to.subVectors(this.desiredElbow, this.shoulder);
      this.aim(upper, this.from, this.to);
      upper.updateWorldMatrix(true, true);
      lower.getWorldPosition(this.elbow); hand.getWorldPosition(this.wrist);
      this.from.subVectors(this.wrist, this.elbow); this.to.subVectors(this.targetWrist, this.elbow);
      this.aim(lower, this.from, this.to);
      lower.updateWorldMatrix(true, true);
      hand.parent!.getWorldQuaternion(this.parentRotation);
      hand.quaternion.copy(this.parentRotation.invert()).multiply(this.handRotation).normalize();
      for (const finger of arm.fingers) {
        const curl = 1 - .60 * contactWeight / Math.max(.000001, contactWeight + wheelWeight);
        this.rotation.setFromAxisAngle(finger.axis, finger.angle * curl);
        finger.bone.quaternion.copy(finger.base).multiply(this.rotation).normalize();
      }
      // Blend complete local rotations to/from the authored enter/exit pose.
      // All sources are saved before any parent changes its children.
      if (blend < 1) for (const joint of arm.joints) joint.bone.quaternion.slerp(joint.base, 1 - blend);
      upper.parent!.updateWorldMatrix(true, true);
      arm.actual.copy(arm.palm).applyMatrix4(hand.matrixWorld);
      arm.error = arm.actual.distanceTo(arm.target);
    }
  }

  get diagnostics() {
    return { weight: this.appliedWeight, maximumGripError: this.appliedWeight
      ? Math.max(0, ...this.arms.map(arm => arm.error)) : 0,
    grips: this.arms.map(arm => ({ side: arm.side, target: arm.target.toArray(), actual: arm.actual.toArray(), error: arm.error })) };
  }

  private aim(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) {
    this.rotation.setFromUnitVectors(from.normalize(), to.normalize());
    this.rotateWorld(bone, this.rotation);
  }

  private rotateWorld(bone: THREE.Bone, delta: THREE.Quaternion) {
    bone.getWorldQuaternion(this.worldRotation);
    bone.parent!.getWorldQuaternion(this.parentRotation);
    this.worldRotation.premultiply(delta);
    bone.quaternion.copy(this.parentRotation.invert()).multiply(this.worldRotation).normalize();
  }
}
