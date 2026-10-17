import * as THREE from 'three';
import { nearestRoad, nearestBlock, isCitySquare } from './city-layout';

type Collider = { x: number; z: number; hx: number; hz: number };
export type CoveredRoad = Collider & { ceiling: number; label: string };

function surfaceTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#596064'; ctx.fillRect(0, 0, 256, 256);
  let seed = 81;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(12,17,19,${random() * .18})`;
    ctx.fillRect(random() * 256, random() * 256, 1 + random() * 3, 1 + random() * 4);
  }
  for (let i = 0; i < 12; i++) {
    const x = random() * 256;
    const stain = ctx.createLinearGradient(x, 0, x, 210);
    stain.addColorStop(0, 'rgba(4,10,13,.24)'); stain.addColorStop(1, 'rgba(4,10,13,0)');
    ctx.fillStyle = stain; ctx.fillRect(x, 0, 1 + random() * 8, 210);
  }
  ctx.strokeStyle = '#333b40'; ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 256, 256); ctx.beginPath(); ctx.moveTo(0, 128); ctx.lineTo(256, 128); ctx.stroke();
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 4;
  return map;
}

function roadSign(title: string, subtitle: string) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#101d23'; ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = '#729da5'; ctx.lineWidth = 3; ctx.strokeRect(4, 4, 504, 120);
  ctx.fillStyle = '#cfd9dc'; ctx.font = 'bold 36px Arial'; ctx.fillText(title, 24, 53);
  ctx.font = '18px monospace'; ctx.fillStyle = '#92a9af'; ctx.fillText(subtitle, 25, 98);
  ctx.fillStyle = '#80b8a2'; ctx.font = 'bold 56px Arial'; ctx.fillText('↓', 456, 80);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map, toneMapped: true });
}

/** Road-space tunnels and bridge underpasses. Supports never occupy the driveable lanes. */
export function addInfrastructure(scene: THREE.Scene, colliders: Collider[]) {
  const concreteMap = surfaceTexture();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x748087, map: concreteMap, bumpMap: concreteMap, bumpScale: .035, roughness: .91, metalness: .04 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x31383d, metalness: .65, roughness: .52 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101519, roughness: .88 });
  const warmLamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd9ac).multiplyScalar(1.45) });
  const coolLamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xc9dfed).multiplyScalar(1.3) });
  const amber = new THREE.MeshBasicMaterial({ color: 0xb99449 });
  const covered: CoveredRoad[] = [];
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const box = (parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = concrete) => {
    const mesh = new THREE.Mesh(cube, material); mesh.position.set(x, y, z); mesh.scale.set(w, h, d); parent.add(mesh); return mesh;
  };
  const beam = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, width: number, material: THREE.Material = steel) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(width, width, a.distanceTo(b), 6), material);
    m.position.copy(a).add(b).multiplyScalar(.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); parent.add(m);
  };
  const configurations = [
    { x: -88, z: -66, sideways: false, tunnel: true, label: 'WEST / SERVICE TUNNEL' },
    { x: 88, z: 22, sideways: false, tunnel: true, label: 'EAST / TRANSIT TUNNEL' },
    { x: 132, z: -110, sideways: false, tunnel: true, label: 'NORTH / UTILITY LINK' },
    { x: -22, z: 44, sideways: true, tunnel: false, label: 'LOWER / CANAL ROAD' },
    { x: 66, z: -88, sideways: true, tunnel: false, label: 'EAST / UNDERPASS' },
    { x: -110, z: 132, sideways: true, tunnel: false, label: 'SOUTH / FREIGHT LINE' },
    { x: -220, z: -154, sideways: false, tunnel: true, label: 'FAR WEST / DEEP TUNNEL' },
    { x: 220, z: 154, sideways: false, tunnel: true, label: 'FAR EAST / EXPRESS TUNNEL' },
    { x: -154, z: 220, sideways: true, tunnel: false, label: 'SOUTH / OUTER BYPASS' },
    { x: 264, z: -198, sideways: true, tunnel: false, label: 'NORTH / ORBITAL ROAD' },
    { x: -308, z: 0, sideways: false, tunnel: true, label: 'OUTER WEST / SUPPLY LINK' },
    { x: 0, z: -308, sideways: true, tunnel: false, label: 'NORTH / CARGO UNDERPASS' },
  ];
  for (const [index, config] of configurations.entries()) {
    const { sideways, tunnel, label } = config;
    const x = sideways ? nearestBlock(config.x) : nearestRoad(config.x);
    const z = sideways ? nearestRoad(config.z) : nearestBlock(config.z);
    // Roofs and crash barriers extend beyond their snapped street centers.
    if (isCitySquare(x, z, 14)) continue;
    const group = new THREE.Group(); group.position.set(x, 0, z); group.rotation.y = sideways ? Math.PI / 2 : 0; scene.add(group);
    const length = 25, half = length / 2, ceiling = tunnel ? 7.8 : 7.2;
    covered.push({ x, z, hx: sideways ? half : 9.5, hz: sideways ? 9.5 : half, ceiling: ceiling + .5, label });
    for (const side of [-1, 1]) {
      if (tunnel) box(group, side * 9.35, 1.5, 0, .7, 3, length);
      else for (const end of [-1, 1]) {
        box(group, side * 10, 3.6, end * 8.3, 1.6, 7.2, 2.4);
        box(group, side * 10, .65, end * 8.3, 2.1, 1.3, 2.8);
      }
      // Low roadside crash barriers leave 17.6m clear for driving.
      box(group, side * 9.05, .5, 0, .4, .65, length, concrete);
      box(group, side * 8.81, .62, 0, .025, .12, length, rubber);
      if (sideways) colliders.push({ x, z: z - side * 9.2, hx: half, hz: .45 });
      else colliders.push({ x: x + side * 9.2, z, hx: .45, hz: half });
      for (let at = -11; at <= 11; at += 3.6) {
        box(group, side * 8.8, .94, at, .04, .12, .36, amber);
        if (tunnel) {
          box(group, side * 8.96, 2.2, at, .03, .07, 3.4, steel);
          box(group, side * 8.92, 2.1, at, .055, .3, .065, steel);
        }
      }
    }
    if (tunnel) {
      const arch = new THREE.Shape(); arch.moveTo(-9.7, 2.95);
      for (let j = 0; j <= 32; j++) { const a = Math.PI - j / 32 * Math.PI; arch.lineTo(Math.cos(a) * 9.7, 3 + Math.sin(a) * 5.45); }
      arch.lineTo(9, 3);
      for (let j = 0; j <= 32; j++) { const a = j / 32 * Math.PI; arch.lineTo(Math.cos(a) * 9, 3 + Math.sin(a) * 4.8); }
      arch.closePath();
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(arch, { depth: length, bevelEnabled: false, steps: 1, curveSegments: 24 }), concrete);
      roof.position.z = -half; group.add(roof);
      for (let at = -half; at <= half; at += 3.125) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(8.94, .08, 6, 32, Math.PI), steel);
        rib.scale.y = .53; rib.position.set(0, 3, at); group.add(rib);
      }
      for (const side of [-1, 1]) {
        beam(group, new THREE.Vector3(side * 7.8, 5, -half), new THREE.Vector3(side * 7.8, 5, half), .08);
        beam(group, new THREE.Vector3(side * 7.5, 5.3, -half), new THREE.Vector3(side * 7.5, 5.3, half), .045);
      }
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(.58, .58, 1.7, 20, 1, true), steel);
      vent.rotation.x = Math.PI / 2; vent.position.set(0, 6.75, 0); group.add(vent);
      for (let j = 0; j < 4; j++) box(group, (j - 1.5) * .24, 6.75, -.86, .03, .9, .04, rubber);
      // Inset maintenance door and emergency panel on one wall.
      box(group, -8.97, 1.6, 4, .06, 2.4, 1.15, steel);
      box(group, -8.91, 1.6, 4.4, .06, .06, .13, amber);
    } else {
      box(group, 0, 7.65, 0, 27, .9, length);
      box(group, 0, 8.15, 0, 27, .14, length - 1, rubber);
      for (let at = -10; at <= 10; at += 4) {
        box(group, 0, 7.05, at, 25, .55, .3, steel);
        for (const side of [-1, 1]) box(group, side * 4.9, 8.24, at, .09, .02, 2.2, amber);
      }
      for (const side of [-1, 1]) {
        box(group, 0, 8.75, side * (half - .25), 27, 1.1, .32);
        box(group, 0, 9.35, side * (half - .25), 27, .1, .12, steel);
      }
    }
    for (let at = -9; at <= 9; at += 6) for (const side of [-1, 1]) {
      box(group, side * 3.8, 6.7, at, .38, .16, 1.6, steel);
      box(group, side * 3.8, 6.6, at, .28, .035, 1.35, index % 2 ? coolLamp : warmLamp);
    }
    for (const end of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 1.65), roadSign(label, 'CLEARANCE 6.0 M   /   KEEP LEFT'));
      sign.position.set(0, tunnel ? 8.5 : 8, end * (half + .08)); sign.rotation.y = end < 0 ? Math.PI : 0; group.add(sign);
      box(group, 0, sign.position.y, end * half, 6.85, 1.85, .15, steel);
      for (const side of [-1, 1]) for (let j = 0; j < 5; j++) {
        const stripe = box(group, side * 9.25, .4 + j * .31, end * (half + .05), .43, .13, .06, j % 2 ? amber : rubber);
        stripe.rotation.z = side * .3;
      }
      const light = new THREE.PointLight(index % 2 ? 0xc8d8ec : 0xffc691, 65, 16, 2);
      light.position.set(0, 5.8, end * 6); group.add(light);
    }
  }
  // Street furniture is set behind the kerb: shelters, seats, cabinets and drain gratings.
  for (const [x, z] of [[-10.8, -22], [54.8, 22], [-98.8, 66], [142.8, -66], [10.8, 110], [-54.8, -110], [-186.8, 154], [230.8, -154], [-142.8, -198], [274.8, 110], [-318.8, 22], [10.8, -286]]) {
    if (isCitySquare(x + 22, z - 22, 4)) continue;
    const shelter = new THREE.Group(); shelter.position.set(x + 22, 0, z - 22); scene.add(shelter);
    const side = x < 0 ? -1 : 1;
    for (const end of [-1, 1]) box(shelter, side * .65, 1.55, end * 2.3, .08, 2.8, .08, steel);
    box(shelter, side * .35, 3, 0, 1.6, .13, 5.1, steel);
    box(shelter, side * .4, 2.91, 0, .07, .025, 3.8, coolLamp);
    const glazing = new THREE.MeshStandardMaterial({ color: 0x213039, metalness: .45, roughness: .24 });
    box(shelter, side * 1.1, 1.6, 0, .045, 2.5, 4.8, glazing);
    box(shelter, side * .5, .75, 0, .58, .09, 3.2, steel);
    for (const at of [-1.2, 1.2]) box(shelter, side * .5, .5, at, .06, .5, .07, steel);
    box(shelter, 0, 1.05, 3.5, .6, 1.55, .7, steel);
    box(shelter, -side * .31, 1.35, 3.5, .025, .12, .46, rubber);
    box(shelter, .3, .24, -3.1, 1.1, .025, 1.2, rubber);
    for (let j = 0; j < 9; j++) box(shelter, -.15 + j * .11, .26, -3.1, .032, .02, 1.1, steel);
  }
  const manholeMat = new THREE.MeshStandardMaterial({ color: 0x343a3e, metalness: .45, roughness: .78 });
  for (let i = 0; i < 22; i++) {
    const x = ((i % 7) - 3) * 44 + 22 + 6.8, z = (Math.floor(i / 7) - 2) * 44;
    if (isCitySquare(x, z)) continue;
    const cover = new THREE.Mesh(new THREE.CylinderGeometry(.48, .48, .026, 24), manholeMat);
    cover.position.set(x, .05, z); scene.add(cover);
    for (let j = 0; j < 4; j++) box(scene, x + (j - 1.5) * .15, .067, z, .027, .007, .62, rubber);
  }
  // Small, localized neutral pools replace unmotivated expanses of saturated light.
  for (const x of [-308, -220, -132, -88, 0, 88, 132, 220, 308]) for (const z of [-286, -198, -110, -22, 66, 154, 242, 330]) for (const side of [-1, 1]) {
    const sx = nearestRoad(x) + side * 9.6;
    const blockZ = nearestBlock(z);
    if (isCitySquare(sx, blockZ, 2)) continue;
    box(scene, sx, 3.9, blockZ, .12, 7.8, .12, steel);
    box(scene, sx - side * .6, 7.7, blockZ, 1.3, .1, .12, steel);
    box(scene, sx - side * 1.16, 7.6, blockZ, .48, .075, .7, coolLamp);
    if (side > 0) {
      const lamp = new THREE.PointLight(0xc7d5e3, 55, 21, 2); lamp.position.set(sx - side * 1.16, 7.4, blockZ); scene.add(lamp);
    }
  }
  return covered;
}
