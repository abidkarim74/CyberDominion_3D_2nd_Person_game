import * as THREE from 'three';

type Side = 'left' | 'right';
type Floor = (ankle: THREE.Vector3, side: Side) => number;

/** Ground an authored gait by moving its body, without shortening either leg. */
export class PersonGroundMotion {
  private readonly feet: { side: Side; bone: THREE.Bone }[] = [];
  private readonly ankle = new THREE.Vector3();
  private readonly baseY: number;
  private applied = false;
  private offset = 0;

  constructor(private readonly model: THREE.Group) {
    this.baseY = model.position.y;
    model.traverse(object => {
      if (!(object instanceof THREE.Bone)) return;
      const side = object.name.toLowerCase().replace(/[^a-z0-9]/g, '').match(/(left|right)foot$/)?.[1] as Side | undefined;
      if (side) this.feet.push({ side, bone: object });
    });
  }

  /** Restore before the mixer and before returning to seated/transfer poses. */
  restore() {
    if (this.applied) this.model.position.y = this.baseY;
    this.applied = false; this.offset = 0;
  }

  /** A negative gait baseline retains the captured running flight phase. */
  update(floor: Floor, baseline = 0) {
    if (!this.feet.length) return;
    this.model.updateWorldMatrix(true, true);
    let offset = Number.isFinite(baseline) ? baseline : 0;
    for (const foot of this.feet) {
      foot.bone.getWorldPosition(this.ankle);
      const height = floor(this.ankle, foot.side);
      if (Number.isFinite(height)) offset = Math.max(offset, height - this.ankle.y);
    }
    // Convert the world-height correction to the model parent's vertical axis.
    const verticalScale = this.model.parent?.matrixWorld.elements[5] ?? 1;
    if (Math.abs(verticalScale) < .00001) return;
    this.offset = offset;
    this.model.position.y = this.baseY + offset / verticalScale;
    this.applied = true;
    this.model.updateWorldMatrix(true, true);
  }

  get diagnostics() { return { verticalOffset: this.offset }; }
}
