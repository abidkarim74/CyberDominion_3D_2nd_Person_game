import * as THREE from 'three';
import model from './blender-car-model.json';
import { splitSideMirrorSurface } from './driving-mirrors';

type CarMaterials = Record<'paint' | 'secondaryPaint' | 'carbon' | 'alloy' | 'glass' | 'amber' | 'trim' | 'redAccent' | 'white' | 'red', THREE.Material>;

/** Blender authored panels, with baked bevel normals and shared game materials. */
export function addBlenderCarBody(body: THREE.Group, materials: CarMaterials) {
  const headlights: THREE.Mesh[] = [], brakeLights: THREE.Mesh[] = [];
  const sideMirrors: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  const textures = new THREE.TextureLoader();
  const materialMap: Record<string, THREE.Material> = { ...materials };
  // Dark intake/grille surrounds match the reference's black front fascia;
  // retain a polished edge only around the cabin and sculpted side doors.
  const bodyTrim = new THREE.MeshStandardMaterial({
    color: 0x17191b, metalness: .55, roughness: .24, envMapIntensity: 1.35,
  });
  bodyTrim.name = 'Bugatti / gloss black grille and bumper trim';
  const cabinTrim = bodyTrim.clone();
  cabinTrim.color.setHex(0xdde1e6);
  cabinTrim.name = 'Bugatti / polished aluminum cabin surround';
  materialMap.alloy = bodyTrim;
  for (const [key, file] of Object.entries({ badge: 'badge.png', grille: 'grill1.png', grilleFine: 'grill2.png', grilleDense: 'grill3.png', lights: 'lights.png', interior: 'interior.png' })) {
    const map = textures.load(`/models/bugatti/${file}`);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.flipY = true;
    map.anisotropy = 4;
    const grille = key.startsWith('grille');
    const material = new THREE.MeshStandardMaterial({
      color: grille ? 0x30353c : key === 'interior' ? 0x666666 : 0xffffff,
      map, metalness: grille || key === 'badge' ? .55 : .1,
      roughness: grille ? .50 : key === 'lights' ? .17 : .52,
      alphaTest: key === 'badge' ? .35 : 0,
      side: grille || key === 'badge' ? THREE.DoubleSide : THREE.FrontSide,
      envMapIntensity: 1.1,
    });
    material.name = `Bugatti / source ${key}`;
    materialMap[key] = material;
  }
  function bytes(encoded: string) {
    const raw = atob(encoded);
    const buffer = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    return buffer;
  }
  function attribute(encoded: string, scale: number, components: number) {
    const packed = new Int16Array(bytes(encoded));
    const values = new Float32Array(packed.length);
    for (let i = 0; i < values.length; i++) values[i] = packed[i] / scale;
    return new THREE.BufferAttribute(values, components);
  }
  for (const panel of model.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', attribute(panel.position, model.positionScale, 3));
    geometry.setAttribute('normal', attribute(panel.normal, model.normalScale, 3));
    geometry.setAttribute('uv', attribute(panel.uv, 'uvScale' in panel ? Number(panel.uvScale) : model.uvScale, 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(bytes(panel.index)), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (panel.material === 'alloy' && (panel.part === 'driverDoor' || panel.part === 'passengerDoor')) {
      const mirror = splitSideMirrorSurface(geometry, panel.part === 'driverDoor' ? -1 : 1);
      if (mirror) { body.add(mirror); sideMirrors.push(mirror); }
    }
    const material = panel.material === 'alloy' && /Door|doorSurround/.test(panel.name)
      ? cabinTrim : materialMap[panel.material];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = panel.name;
    mesh.userData.carPart = panel.part;
    if (panel.material === 'glass') {
      // The artist's outward-facing windows need a clear inner laminate when
      // viewed from the seat. Keep the exterior tint on its original face.
      // Interior glazing only needs a clear tint and environment sheen. The
      // exterior retains its physical clearcoat; evaluating a second clearcoat
      // layer across the driver's windshield adds substantial fragment work.
      const interiorGlass = new THREE.MeshStandardMaterial({
        color: 0x9eb9c6, side: THREE.BackSide, transparent: true, opacity: .15,
        metalness: 0, roughness: .2, depthWrite: false, envMapIntensity: .34,
      });
      interiorGlass.name = 'Bugatti cabin / clear inner laminated windows';
      interiorGlass.userData.cockpitDetail = true;
      interiorGlass.userData.noCastShadow = true;
      const innerWindows = new THREE.Mesh(geometry, interiorGlass);
      innerWindows.name = 'Bugatti cabin / windshield and side glass inner surface';
      innerWindows.userData.carPart = panel.part;
      innerWindows.userData.cockpitDetail = true;
      body.add(innerWindows);
    }
    if (panel.material === 'white') {
      mesh.userData.dynamic = true;
      headlights.push(mesh);
    } else if (panel.material === 'red') {
      mesh.userData.dynamic = true;
      brakeLights.push(mesh);
    }
    body.add(mesh);
  }
  body.userData.bodyModel = 'Blender / Bugatti Chiron';
  body.userData.driverDoorHinge = model.driverDoorHinge;
  return { headlights, brakeLights, sideMirrors };
}
