import * as THREE from 'three';

type MaskedMesh = {
  mesh: THREE.SkinnedMesh;
  original: THREE.BufferGeometry;
  driver: THREE.BufferGeometry;
};

const HEAD_WEIGHT_CUTOFF = .5;
const normalizedName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Keep the rigged clothes and hands in view while clearing the seated camera's head volume. */
export class PersonDriverVisibility {
  private readonly masked: MaskedMesh[] = [];
  private readonly hidden: { mesh: THREE.Mesh; visible: boolean }[] = [];
  readonly diagnostics = {
    driverView: false,
    headWeightCutoff: HEAD_WEIGHT_CUTOFF,
    hiddenMeshes: [] as string[],
    geometries: [] as { name: string; originalTriangles: number; driverTriangles: number; removedTriangles: number }[],
  };

  constructor(model: THREE.Group) {
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = normalizedName(object.name);
      if (/(?:hair|eyes|eyelashes)$/.test(name) || object.userData.first_person_hidden === true) {
        this.hidden.push({ mesh: object, visible: object.visible });
        this.diagnostics.hiddenMeshes.push(object.name);
        return;
      }
      // Winter headwear and high collars are separate skinned garments. Use
      // their bone weights so the same mask covers every fitted layer.
      if (!(object instanceof THREE.SkinnedMesh)) return;
      const driver = this.withoutHead(object);
      if (!driver) return;
      this.masked.push({ mesh: object, original: object.geometry, driver });
      const originalTriangles = object.geometry.index!.count / 3;
      const driverTriangles = driver.index!.count / 3;
      this.diagnostics.geometries.push({ name: object.name, originalTriangles, driverTriangles,
        removedTriangles: originalTriangles - driverTriangles });
    });
  }

  /** Reuse cached indices for the driver's eyes or the complete body in an optical reflection. */
  setDriverView(enabled: boolean) {
    if (enabled === this.diagnostics.driverView) return;
    this.diagnostics.driverView = enabled;
    for (const part of this.masked) part.mesh.geometry = enabled ? part.driver : part.original;
    for (const part of this.hidden) part.mesh.visible = enabled ? false : part.visible;
  }

  dispose() {
    this.setDriverView(false);
    for (const part of this.masked) part.driver.dispose();
  }

  private withoutHead(mesh: THREE.SkinnedMesh) {
    const original = mesh.geometry, index = original.index;
    const joints = original.getAttribute('skinIndex'), weights = original.getAttribute('skinWeight');
    if (!index || !joints || !weights) return;
    const headBones = mesh.skeleton.bones.map(bone =>
      /(?:neck|head|headtopend|lefteye|righteye)$/.test(normalizedName(bone.name)));
    const headVertex = new Uint8Array(joints.count);
    for (let vertex = 0; vertex < joints.count; vertex++) {
      let headWeight = 0;
      for (let component = 0; component < 4; component++) {
        if (headBones[joints.getComponent(vertex, component)]) headWeight += weights.getComponent(vertex, component);
      }
      headVertex[vertex] = Number(headWeight >= HEAD_WEIGHT_CUTOFF);
    }
    const retained: number[] = [];
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    const sourceGroups = original.groups.length ? original.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
    for (const group of sourceGroups) {
      const start = retained.length;
      for (let triangle = group.start; triangle < Math.min(index.count, group.start + group.count); triangle += 3) {
        const a = index.getX(triangle), b = index.getX(triangle + 1), c = index.getX(triangle + 2);
        // Drop boundary triangles too, so no sliver of the neck remains by the eye.
        if (!headVertex[a] && !headVertex[b] && !headVertex[c]) retained.push(a, b, c);
      }
      groups.push({ start, count: retained.length - start, materialIndex: group.materialIndex ?? 0 });
    }
    if (retained.length === index.count) return;
    const driver = new THREE.BufferGeometry();
    driver.name = `${original.name || mesh.name} / first person without head`;
    // Only the index differs. Skinning, normals, UVs and morphs use the authored buffers.
    for (const [name, attribute] of Object.entries(original.attributes)) driver.setAttribute(name, attribute);
    driver.morphAttributes = original.morphAttributes;
    driver.morphTargetsRelative = original.morphTargetsRelative;
    driver.boundingBox = original.boundingBox?.clone() ?? null;
    driver.boundingSphere = original.boundingSphere?.clone() ?? null;
    driver.setIndex(retained);
    if (original.groups.length) for (const group of groups) driver.addGroup(group.start, group.count, group.materialIndex);
    return driver;
  }
}
