import * as THREE from 'three';

/** Give the existing authored shell a hinged driver's door, retaining its UVs. */
export function addDriverDoor(body: THREE.Group) {
  body.updateWorldMatrix(true, true);
  const hinge = new THREE.Group();
  hinge.name = 'Bugatti / hinged driver door';
  hinge.position.set(-.86, .50, -.82);
  hinge.userData.dynamic = true;
  const candidates: THREE.Mesh[] = [];
  const replacedGeometries = new Set<THREE.BufferGeometry>();
  const doorMaterials = new Map<THREE.Material, THREE.Material>();
  body.traverse(object => {
    if (object instanceof THREE.Mesh && !object.userData.dynamic &&
      !(object instanceof THREE.InstancedMesh) && !Array.isArray(object.material)) candidates.push(object);
  });
  const inverse = body.matrixWorld.clone().invert();
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const center = new THREE.Vector3();
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const mesh of candidates) {
    // Only the imported outer skin and its clear inner window laminate are split.
    if (!mesh.name.startsWith('Blender Chiron /') && !mesh.name.includes('windshield and side glass inner surface')) continue;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const moving: number[] = [], fixed: number[] = [];
    matrix.multiplyMatrices(inverse, mesh.matrixWorld);
    const innerDoorSkin = ['Blender Chiron / carbon', 'Blender Chiron / trim', 'Blender Chiron / interior'].includes(mesh.name);
    for (let i = 0, count = index?.count ?? position.count; i < count; i += 3) {
      center.set(0, 0, 0);
      for (let j = 0; j < 3; j++) {
        point.fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(matrix);
        corners[j].copy(point); center.add(point);
      }
      center.multiplyScalar(1 / 3);
      // The sill and roof remain attached to the chassis. The pane follows the door.
      const pane = mesh.name.includes('glass') || mesh.name.includes('inner surface');
      // The source door's inward return sits closer to the seats than its outer
      // skin. Move its low panels too, without taking the rear pillar or cabin.
      const innerPanel = innerDoorSkin && corners.every(p =>
        p.x < -.66 && p.y > .42 && p.y < .94 && p.z > -.85 && p.z < .50);
      const inside = pane
        ? center.x < -.52 && center.y > .90 && center.y < 1.24 && center.z > -.78 && center.z < .47
        : center.x < -.73 && center.y > .43 && center.y < 1.05 && center.z > -.79 && center.z < .66 || innerPanel;
      const target = inside && corners.every(p => p.x < -.48) ? moving : fixed;
      for (let j = 0; j < 3; j++) target.push(index ? index.getX(i + j) : i + j);
    }
    if (!moving.length) continue;
    const selected = geometry.clone();
    selected.setIndex(moving);
    // Compact the selected triangles so bounds and vertex buffers describe only
    // the door, rather than including all unused vertices from the whole car.
    const doorGeometry = selected.toNonIndexed();
    selected.dispose();
    doorGeometry.applyMatrix4(matrix);
    doorGeometry.translate(-hinge.position.x, -hinge.position.y, -hinge.position.z);
    doorGeometry.computeBoundingBox(); doorGeometry.computeBoundingSphere();
    const material = mesh.material as THREE.Material;
    let doorMaterial = material;
    if (!material.transparent && material.side !== THREE.DoubleSide) {
      let visibleFromInside = doorMaterials.get(material);
      if (!visibleFromInside) {
        visibleFromInside = material.clone();
        visibleFromInside.name = `${material.name} / two sided hinged door`;
        visibleFromInside.side = THREE.DoubleSide;
        doorMaterials.set(material, visibleFromInside);
      }
      doorMaterial = visibleFromInside;
    }
    // Imported panels are a thin outer skin. The opened door exposes their
    // reverse faces; keep those opaque while retaining the paired glass faces.
    const door = new THREE.Mesh(doorGeometry, doorMaterial);
    door.name = `Driver door / ${mesh.name}`;
    door.userData.dynamic = true;
    door.castShadow = mesh.castShadow; door.receiveShadow = true;
    hinge.add(door);
    // Preserve the original vertex buffers. Only triangle ownership changes.
    // The outer tinted pane and inner laminate share one source geometry.
    // Give each its own indices before splitting, so both surfaces move together.
    const fixedGeometry = geometry.clone();
    fixedGeometry.setIndex(fixed);
    fixedGeometry.computeBoundingBox(); fixedGeometry.computeBoundingSphere();
    mesh.geometry = fixedGeometry;
    replacedGeometries.add(geometry);
  }
  body.add(hinge);
  const trim = body.getObjectByName('Bugatti cabin / driver door trim');
  if (trim) {
    // The handle, armrest and padded inner card are part of the same physical
    // door. Mark every mesh so the static body batch cannot take them away.
    hinge.attach(trim);
    trim.traverse(object => { object.userData.dynamic = true; });
  }
  body.traverse(object => { if (object instanceof THREE.Mesh) replacedGeometries.delete(object.geometry); });
  replacedGeometries.forEach(geometry => geometry.dispose());
  return hinge;
}
