import * as THREE from 'three';

const INTERVALS = [3.8, 4.6, 2.9, 5.2, 3.3, 4.1];
const ease = (value: number) => value * value * (3 - 2 * value);

/** Keep the authored eyelids and inset corneas together during a natural blink. */
export class PersonFaceMotion {
  private readonly lids: { mesh: THREE.Mesh; index: number }[] = [];
  private remaining = 2.6;
  private elapsed = -1;
  private count = 0;

  constructor(model: THREE.Group) {
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.morphTargetInfluences) return;
      const index = object.morphTargetDictionary?.Blink;
      if (index !== undefined) this.lids.push({ mesh: object, index });
    });
  }

  update(delta: number) {
    if (!this.lids.length) return;
    const dt = THREE.MathUtils.clamp(delta, 0, .1);
    let weight = 0;
    if (this.elapsed < 0) {
      this.remaining -= dt;
      if (this.remaining <= 0) this.elapsed = 0;
    }
    if (this.elapsed >= 0) {
      this.elapsed += dt;
      const t = this.elapsed / .18;
      weight = t < .35 ? ease(t / .35) : t < .48 ? 1 : 1 - ease(Math.min(1, (t - .48) / .52));
      if (t >= 1) {
        this.elapsed = -1;
        this.count++;
        this.remaining = this.count % 7 === 0 ? .24 : INTERVALS[this.count % INTERVALS.length];
      }
    }
    for (const { mesh, index } of this.lids) mesh.morphTargetInfluences![index] = weight;
  }
}
