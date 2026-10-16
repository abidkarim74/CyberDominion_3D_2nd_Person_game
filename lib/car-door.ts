import * as THREE from 'three';

/** Move the complete authored door, glazing and mirror on their original hinge. */
export function addDriverDoor(body: THREE.Group) {
  const hinge = new THREE.Group();
  hinge.name = 'Bugatti / hinged driver door';
  hinge.position.fromArray(body.userData.driverDoorHinge);
  hinge.userData.dynamic = true;
  body.add(hinge);
  body.updateWorldMatrix(true, true);

  const doorPanels: THREE.Mesh[] = [];
  const doorMaterials = new Map<THREE.Material, THREE.Material>();
  body.traverse(object => {
    if (object instanceof THREE.Mesh && object.userData.carPart === 'driverDoor') doorPanels.push(object);
  });
  for (const panel of doorPanels) {
    const material = panel.material as THREE.Material;
    if (!material.transparent && material.side !== THREE.DoubleSide) {
      let innerVisible = doorMaterials.get(material);
      if (!innerVisible) {
        innerVisible = material.clone();
        innerVisible.name = `${material.name} / two sided hinged door`;
        innerVisible.side = THREE.DoubleSide;
        doorMaterials.set(material, innerVisible);
      }
      panel.material = innerVisible;
    }
    // Reparent whole panels. Preserve the artist's boundary, normals and UVs;
    // cutting triangles by their centers leaves torn edges and chassis shards.
    hinge.attach(panel);
    panel.name = `Driver door / ${panel.name}`;
    panel.userData.dynamic = true;
    panel.receiveShadow = true;
  }

  return hinge;
}
