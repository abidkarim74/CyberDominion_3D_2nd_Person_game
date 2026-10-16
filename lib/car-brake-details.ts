import * as THREE from 'three';

/** Shared castings and hardware for the four carbon-ceramic brake assemblies. */
export function createBugattiBrakeAssets() {
  const caliperShape = new THREE.Shape();
  const outline = [[-.038, -.067], [-.027, -.086], [.026, -.084], [.043, -.062], [.050, .052], [.032, .084], [-.030, .084], [-.044, .054]];
  outline.forEach(([x, y], i) => { if (i === 0) caliperShape.moveTo(x, y); else caliperShape.lineTo(x, y); });
  caliperShape.closePath();

  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.font = 'bold 29px Arial'; context.fillStyle = '#f5f1e8';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText('BUGATTI', 128, 33);
  const wordmarkMap = new THREE.CanvasTexture(canvas);
  wordmarkMap.colorSpace = THREE.SRGBColorSpace;
  const wordmark = new THREE.MeshStandardMaterial({ map: wordmarkMap, transparent: true, alphaTest: .2, depthWrite: false, roughness: .45, metalness: .1 });
  wordmark.name = 'Bugatti / ivory caliper wordmark';

  return {
    rotor: new THREE.CylinderGeometry(.244, .244, .018, 48),
    hat: new THREE.CylinderGeometry(.093, .108, .024, 24),
    hatLip: new THREE.RingGeometry(.094, .111, 32),
    mountingButton: new THREE.CylinderGeometry(.0042, .0042, .004, 8),
    caliper: new THREE.ExtrudeGeometry(caliperShape, { depth: .032, bevelEnabled: true, bevelSize: .003, bevelThickness: .003, bevelSegments: 1, curveSegments: 1, steps: 1 }),
    pad: new THREE.BoxGeometry(.014, .119, .019),
    rib: new THREE.BoxGeometry(.065, .007, .006),
    boss: new THREE.CylinderGeometry(.0115, .013, .004, 10),
    fastener: new THREE.CylinderGeometry(.0034, .0034, .004, 6),
    badge: new THREE.PlaneGeometry(.066, .014),
    wordmark,
  };
}

/** Wheel hardware spins with the disc; the six-piston casting stays on its steering pivot. */
export function addBugattiBrakes(
  wheel: THREE.Group,
  pivot: THREE.Group,
  side: number,
  face: number,
  materials: { rotor: THREE.Material; caliper: THREE.Material; alloy: THREE.Material; carbon: THREE.Material; trim: THREE.Material },
  assets: ReturnType<typeof createBugattiBrakeAssets>,
) {
  const disc = new THREE.Mesh(assets.rotor, materials.rotor);
  disc.name = 'Bugatti / floating carbon-ceramic brake rotor';
  disc.rotation.z = Math.PI / 2;
  disc.position.x = face - side * .047;
  disc.userData.dynamic = true;
  wheel.add(disc);

  const rotatingHardware = new THREE.Group();
  rotatingHardware.name = 'Bugatti / rotor bell and floating mounts';
  rotatingHardware.rotation.y = side * Math.PI / 2;
  rotatingHardware.position.x = face; wheel.add(rotatingHardware);
  const hat = new THREE.Mesh(assets.hat, materials.trim);
  hat.rotation.x = Math.PI / 2; hat.position.z = -.029; rotatingHardware.add(hat);
  const hatLip = new THREE.Mesh(assets.hatLip, materials.alloy);
  hatLip.position.z = -.0165; rotatingHardware.add(hatLip);
  for (let i = 0; i < 10; i++) {
    const angle = i * Math.PI * 2 / 10;
    const button = new THREE.Mesh(assets.mountingButton, materials.alloy);
    button.rotation.x = Math.PI / 2;
    button.position.set(Math.cos(angle) * .102, Math.sin(angle) * .102, -.014);
    rotatingHardware.add(button);
  }

  const fixedHardware = new THREE.Group();
  fixedHardware.name = 'Bugatti / fixed monobloc brake caliper';
  fixedHardware.rotation.y = side * Math.PI / 2;
  fixedHardware.position.x = face; pivot.add(fixedHardware);
  const caliper = new THREE.Group();
  // Long axis follows the rotor tangent, clear of the forged spoke faces.
  caliper.position.set(-side * .191, .079, -.060);
  caliper.rotation.z = Math.atan2(.079, -side * .191);
  fixedHardware.add(caliper);
  caliper.add(new THREE.Mesh(assets.caliper, materials.caliper));
  const pad = new THREE.Mesh(assets.pad, materials.trim);
  pad.position.set(-.036, 0, .008); caliper.add(pad);
  for (const y of [-.056, .056]) {
    const rib = new THREE.Mesh(assets.rib, materials.caliper);
    rib.position.set(.002, y, .035); caliper.add(rib);
    for (const x of [-.026, .027]) {
      const fastener = new THREE.Mesh(assets.fastener, materials.alloy);
      fastener.rotation.x = Math.PI / 2;
      fastener.position.set(x, y, .039); caliper.add(fastener);
    }
  }
  for (const y of [-.043, 0, .043]) {
    const boss = new THREE.Mesh(assets.boss, materials.caliper);
    boss.rotation.x = Math.PI / 2;
    boss.position.set(-.029, y, .035); caliper.add(boss);
  }
  const badge = new THREE.Mesh(assets.badge, assets.wordmark);
  badge.name = 'Bugatti / caliper lettering';
  badge.position.set(.012, 0, .0355); badge.rotation.z = Math.PI / 2;
  caliper.add(badge);

  return disc;
}
