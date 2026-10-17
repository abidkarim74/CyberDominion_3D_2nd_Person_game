import * as THREE from 'three';

type FinishMaterials = { metal: THREE.Material; dark: THREE.Material; leather: THREE.Material; carbon: THREE.Material };

/** Small manufactured details share the cabin's existing material batches. */
export function addCabinFinish(cabin: THREE.Group, dashboard: THREE.Group, materials: FinishMaterials) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const grain = context.createRadialGradient(94, 70, 8, 128, 128, 135);
  grain.addColorStop(0, '#737f88'); grain.addColorStop(.72, '#424e58'); grain.addColorStop(1, '#28323c');
  context.fillStyle = grain; context.fillRect(0, 0, 256, 256);
  // A dense perforated metal grille is texture detail, avoiding hundreds of tiny meshes.
  for (let row = -1; row < 29; row++) for (let column = -1; column < 29; column++) {
    const x = column * 10 + (row % 2 ? 5 : 0), y = row * 9;
    context.fillStyle = '#101820'; context.beginPath(); context.arc(x, y, 2.6, 0, Math.PI * 2); context.fill();
    context.strokeStyle = 'rgba(190,208,220,.18)'; context.lineWidth = .7;
    context.beginPath(); context.arc(x, y + .4, 3.1, .12, Math.PI - .12); context.stroke();
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const grille = new THREE.MeshStandardMaterial({ name: 'Bugatti cabin / perforated acoustic metal',
    map, bumpMap: map, bumpScale: .00025, color: 0xb5bdc7, roughness: .54, metalness: .64, envMapIntensity: .65 });
  Object.assign(grille.userData, { cockpitDetail: true, noCastShadow: true });

  const parts: THREE.Mesh[] = [];
  function add(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, material: THREE.Material,
    position: [number, number, number], driverDoor = false) {
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `Bugatti cabin / ${name}`; mesh.position.set(...position);
    Object.assign(mesh.userData, { cockpitDetail: true, noCastShadow: true, cabinFinish: true });
    if (driverDoor) mesh.userData.carPart = 'driverDoor';
    parent.add(mesh); parts.push(mesh); return mesh;
  }
  for (const side of [-1, 1]) {
    for (const [radius, y, z] of [[.046, .602, .245], [.017, .869, -.475]]) {
      const x = side * .630, driverDoor = side < 0;
      const surround = add(cabin, 'machined acoustic speaker surround', new THREE.TorusGeometry(radius, .0018, 5, 36), materials.metal,
        [x, y, z], driverDoor); surround.rotation.y = -side * Math.PI / 2;
      const recess = add(cabin, 'recessed acoustic speaker mounting', new THREE.CircleGeometry(radius * .97, 36), materials.dark,
        [x + side * .001, y, z], driverDoor); recess.rotation.y = -side * Math.PI / 2;
      const face = add(cabin, 'precision perforated speaker grille', new THREE.CircleGeometry(radius * .90, 36), grille,
        [x - side * .0006, y, z], driverDoor); face.rotation.y = -side * Math.PI / 2;
    }
  }
  // The glovebox seam and its recessed lock give the wide lower cowl a fitted finish.
  const seam = add(dashboard, 'glovebox lower fitted shadow line', new THREE.BoxGeometry(.420, .0015, .0015), materials.dark,
    [.36, .619, -.484]);
  seam.rotation.z = -.012;
  const lock = add(dashboard, 'glovebox inset key cylinder', new THREE.CircleGeometry(.006, 16), materials.metal, [.411, .702, -.475]);
  lock.scale.y = .82;
  add(dashboard, 'glovebox cylinder keyway', new THREE.BoxGeometry(.0011, .0043, .0004), materials.dark, [.411, .702, -.4745]);

  // Fine mechanical ribs make the selector boot and handrest read at close range.
  for (let row = 0; row < 4; row++) {
    const fold = add(dashboard, 'selector boot stitched leather fold', new THREE.TorusGeometry(.026 + row * .0028, .0011, 4, 20),
      materials.leather, [0, .692 - row * .008, -.067]); fold.rotation.x = -Math.PI / 2 - .11; fold.scale.z = .65;
  }
  return { speakerMaterial: grille, parts };
}
