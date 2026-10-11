import * as THREE from 'three';
import { ROAD_STEP } from './city-layout';

type AtlasTile = { x: number; y: number; width: number; height: number };
export type DistrictInstanceCell = { x: number; z: number; street: Float32Array; roof: Float32Array };

const SHOP_NAMES = ['NOODLE 24', 'MINDLINK', 'KAIRO MED', 'BYTE MARKET', 'VANTA HOTEL', 'GHOST ARCADE', 'NIGHT RAIL', 'AFTERHOURS'];
const SHOP_COPY = ['HOT FOOD / OPEN ALL NIGHT', 'LICENSED CYBERWARE CLINIC', 'TRAUMA CARE / WALK IN', 'PARTS / REPAIRS / EXCHANGE', 'ROOMS / 24H RECEPTION', 'PLAY BEYOND THE REAL', 'DISTRICT TRANSIT / GATE 08', 'RECORDS / AUDIO / SYNTH'];
const INKS = ['#ffa15b', '#59e7ed', '#f36aa2', '#ecba5a', '#7baeff', '#e970dc', '#6dddd6', '#fb737f'];

function randomFor(seed: number) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}

/** One opaque atlas serves every shop and commercial screen, including their baked interiors. */
function makeDistrictAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 1024;
  const c = canvas.getContext('2d')!;
  const shops: AtlasTile[] = [];
  const adverts: AtlasTile[] = [];
  c.fillStyle = '#11171a'; c.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < SHOP_NAMES.length; index++) {
    const tile = { x: index % 4 * 512, y: Math.floor(index / 4) * 256, width: 512, height: 256 };
    shops.push(tile);
    const random = randomFor(index + 119);
    const ink = INKS[index];
    c.save(); c.translate(tile.x, tile.y);
    // Cracked plaster, enamel lettering, deep door reveals and warm occupied rooms.
    c.fillStyle = '#393e40'; c.fillRect(0, 0, 512, 256);
    c.fillStyle = '#10191d'; c.fillRect(8, 8, 496, 75);
    c.fillStyle = ink; c.fillRect(13, 11, 6, 68);
    c.font = '900 45px Arial, sans-serif'; c.textBaseline = 'middle';
    c.fillText(SHOP_NAMES[index], 31, 39, 453);
    c.font = 'bold 14px monospace'; c.fillStyle = '#c6d2cd'; c.fillText(SHOP_COPY[index], 32, 68);
    for (let bay = 0; bay < 4; bay++) {
      const x = 15 + bay * 124;
      const interior = c.createLinearGradient(0, 92, 0, 249);
      interior.addColorStop(0, index % 3 === 0 ? '#786048' : '#2b555e');
      interior.addColorStop(.43, index % 3 === 0 ? '#514c40' : '#21343e');
      interior.addColorStop(1, '#10171b');
      c.fillStyle = '#080c0e'; c.fillRect(x - 3, 89, 120, 158);
      c.fillStyle = interior; c.fillRect(x, 94, 113, 150);
      // Shelves, light fixtures and a counter are baked instead of modeled behind every pane.
      c.fillStyle = '#cdb589'; c.globalAlpha = .8; c.fillRect(x + 9, 105, 88, 3); c.globalAlpha = 1;
      c.fillStyle = '#1a2225'; c.fillRect(x + 6, 178, 104, 9);
      for (let item = 0; item < 6; item++) {
        c.fillStyle = ['#82938c', '#a78063', '#526f70'][item % 3];
        c.fillRect(x + 8 + item * 17, 160 + random() * 5, 8, 15);
      }
      c.fillStyle = '#53696c'; c.globalAlpha = .3; c.fillRect(x + 84, 94, 8, 142); c.globalAlpha = 1;
      c.fillStyle = '#adb9b1'; c.fillRect(x + 99, 157, 3, 23);
      c.strokeStyle = 'rgba(137,190,194,.24)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 7, 111); c.lineTo(x + 96, 228); c.stroke();
      c.fillStyle = '#080d11'; c.fillRect(x, 223, 113, 21);
    }
    // Stickers and grime break the otherwise perfect procedural storefront grid.
    c.fillStyle = '#bcbca6'; c.fillRect(463, 109, 25, 36);
    c.fillStyle = '#263b3c'; c.font = 'bold 9px monospace'; c.fillText('08', 468, 127);
    for (let scuff = 0; scuff < 85; scuff++) {
      c.fillStyle = scuff % 3 ? 'rgba(8,13,14,.23)' : 'rgba(184,178,152,.14)';
      c.fillRect(random() * 512, 84 + random() * 172, 1 + random() * 12, 1 + random() * 3);
    }
    c.fillStyle = ink; c.fillRect(16, 251, 477, 2);
    c.restore();
  }

  for (let index = 0; index < 8; index++) {
    const tile = { x: index * 256, y: 512, width: 256, height: 512 };
    adverts.push(tile);
    const ink = INKS[index];
    c.save(); c.translate(tile.x, tile.y);
    const gradient = c.createLinearGradient(0, 0, 256, 512);
    gradient.addColorStop(0, '#182a39'); gradient.addColorStop(.55, '#111d2a'); gradient.addColorStop(1, '#070c16');
    c.fillStyle = gradient; c.fillRect(0, 0, 256, 512);
    c.fillStyle = ink; c.fillRect(15, 15, 46, 4);
    c.fillStyle = '#d9e3df'; c.font = 'bold 11px monospace'; c.fillText('KAIRO / CHANNEL 0' + index, 16, 40);
    c.strokeStyle = ink; c.lineWidth = 2;
    c.strokeRect(11, 57, 234, 320);
    if (index % 3 !== 1) {
      // A backlit prosthetic profile makes the advertising feel like a product campaign.
      const profile = c.createLinearGradient(65, 0, 196, 0);
      profile.addColorStop(0, '#c5d7d9'); profile.addColorStop(.45, '#657986'); profile.addColorStop(1, '#263c4c');
      c.fillStyle = profile;
      c.beginPath(); c.moveTo(70, 332); c.lineTo(77, 258); c.lineTo(58, 233);
      c.bezierCurveTo(36, 185, 61, 109, 123, 106); c.bezierCurveTo(171, 103, 188, 132, 190, 162);
      c.lineTo(205, 191); c.lineTo(189, 204); c.lineTo(187, 236); c.lineTo(165, 256);
      c.lineTo(146, 255); c.lineTo(153, 306); c.lineTo(192, 334); c.closePath(); c.fill();
      c.strokeStyle = '#12222d'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(112, 116); c.lineTo(96, 148); c.lineTo(106, 209); c.lineTo(150, 250); c.stroke();
      c.beginPath(); c.moveTo(78, 160); c.lineTo(120, 167); c.lineTo(143, 188); c.lineTo(181, 188); c.stroke();
      c.fillStyle = ink; c.fillRect(157, 169, 28, 5);
      c.strokeStyle = ink; c.lineWidth = 1;
      c.beginPath(); c.arc(98, 186, 17, 0, Math.PI * 2); c.stroke();
      for (let trace = 0; trace < 5; trace++) {
        c.beginPath(); c.moveTo(27, 270 + trace * 13); c.lineTo(61 + trace * 6, 270 + trace * 13); c.lineTo(75 + trace * 5, 243); c.stroke();
      }
      c.fillStyle = '#b9e4ea'; c.font = '9px monospace'; c.fillText('NEURAL RESPONSE // 99.8', 22, 361);
    } else {
      // Typography-led transit and entertainment campaigns add a different visual scale.
      c.strokeStyle = ink; c.lineWidth = 10;
      c.beginPath(); c.arc(128, 199, 75, -.8, Math.PI * 1.6); c.stroke();
      c.lineWidth = 2; c.beginPath(); c.arc(128, 199, 55, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#dbe8df'; c.textAlign = 'center'; c.font = '900 70px Arial'; c.fillText(index === 1 ? '08' : '24', 128, 225);
      c.font = 'bold 16px monospace'; c.fillStyle = ink; c.fillText('STAY CONNECTED', 128, 305); c.textAlign = 'left';
    }
    const titles = ['MINDLINK', 'NIGHT RAIL', 'SYNTH SKIN', 'KAIRO MED', 'AFTERHOURS', 'NEURAL+', 'VANTA', 'GHOST'];
    c.fillStyle = '#edf1e5'; c.font = '900 31px Arial'; c.fillText(titles[index], 16, 414, 224);
    c.fillStyle = ink; c.font = 'bold 14px monospace'; c.fillText(['UPGRADE YOURSELF', 'NEXT ARRIVAL / 00:08', 'A NEW HUMAN STANDARD', 'CARE WITHOUT LIMITS', 'THE NIGHT IS YOURS', 'LIVE BEYOND THE BODY', 'CHECK IN / FADE OUT', 'PLAY ANOTHER LIFE'][index], 16, 445, 224);
    c.fillStyle = '#9aacae'; c.font = '8px monospace'; c.fillText('DISTRICT NETWORK / AUTHORIZED BROADCAST', 16, 481, 224);
    // Baked scanlines stay steady while driving and add no animated draw calls.
    c.fillStyle = 'rgba(4,8,12,.11)'; for (let y = 60; y < 374; y += 5) c.fillRect(12, y, 232, 1);
    c.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.25, 1.25, 1.25), toneMapped: false });
  return { material, shops, adverts, width: canvas.width, height: canvas.height };
}

function makeIndustrialMaterial(vented: boolean) {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
  const c = canvas.getContext('2d')!;
  const random = randomFor(vented ? 718 : 902);
  c.fillStyle = vented ? '#797c77' : '#aaa79c'; c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 750; i++) {
    c.fillStyle = i % 2 ? 'rgba(31,36,33,.11)' : 'rgba(202,190,164,.1)';
    c.fillRect(random() * 128, random() * 128, 1 + random() * 4, 1 + random() * 3);
  }
  if (vented) {
    for (let y = 13; y < 116; y += 12) {
      c.fillStyle = '#282f2e'; c.fillRect(10, y, 108, 5);
      c.fillStyle = '#999b8c'; c.fillRect(11, y + 5, 106, 1);
    }
    c.fillStyle = '#a6935c'; c.fillRect(95, 97, 17, 11);
  } else {
    c.fillStyle = 'rgba(10,22,22,.2)'; c.fillRect(0, 62, 128, 2); c.fillRect(63, 0, 2, 128);
    for (let i = 0; i < 15; i++) {
      c.fillStyle = 'rgba(30,44,38,.12)'; c.fillRect(random() * 128, 0, 1 + random() * 5, 5 + random() * 95);
    }
    c.strokeStyle = 'rgba(50,47,36,.25)'; c.lineWidth = .5;
    c.beginPath(); c.moveTo(100, 1); c.lineTo(89, 37); c.lineTo(95, 43); c.lineTo(81, 73); c.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ color: vented ? 0x8a9997 : 0x848079, map: texture, metalness: vented ? .48 : .08, roughness: vented ? .73 : .93 });
}

/** All props are fixed to block islands; there are no street-level supports or animated screens. */
export function addCyberpunkDistrict(scene: THREE.Scene) {
  const atlas = makeDistrictAtlas();
  const concrete = makeIndustrialMaterial(false);
  const vents = makeIndustrialMaterial(true);
  const steel = new THREE.MeshStandardMaterial({ color: 0x28383c, metalness: .68, roughness: .64 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x66584c, metalness: .53, roughness: .82 });
  const neon = [0x30bed0, 0xe74485, 0xf2a35b].map(color => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), toneMapped: false }));
  // Building volumes provide the street shadows; fine hardware should not redraw in the shadow pass.
  for (const material of [atlas.material, concrete, vents, steel, rust, ...neon]) material.userData.noCastShadow = true;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitPipe = new THREE.CylinderGeometry(1, 1, 1, 6);
  const blocks: THREE.Group[] = [];

  const box = (parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = steel) => {
    const mesh = new THREE.Mesh(unitBox, material); mesh.position.set(x, y, z); mesh.scale.set(w, h, d); parent.add(mesh); return mesh;
  };
  const pipe = (parent: THREE.Object3D, x: number, y: number, z: number, radius: number, height: number) => {
    const mesh = new THREE.Mesh(unitPipe, rust); mesh.position.set(x, y, z); mesh.scale.set(radius, height, radius); parent.add(mesh); return mesh;
  };
  const makeScreen = (tile: AtlasTile, w: number, h: number) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    // A two-pixel inset prevents adjacent advertisements bleeding into one another in mipmaps.
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i,
      (tile.x + 2 + uv.getX(i) * (tile.width - 4)) / atlas.width,
      1 - (tile.y + tile.height - 2 - uv.getY(i) * (tile.height - 4)) / atlas.height);
    return new THREE.Mesh(geometry, atlas.material);
  };
  const panel = (parent: THREE.Object3D, tile: AtlasTile, x: number, y: number, z: number, w: number, h: number) => {
    const mesh = makeScreen(tile, w, h); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  };

  // Use the existing building mast to locate each roof; no second copy of the tower generator.
  const rooftops = new Map<string, number>();
  for (const object of scene.children) {
    if (!(object instanceof THREE.Group)) continue;
    const mast = object.children.find(child => child instanceof THREE.Mesh && child.geometry instanceof THREE.CylinderGeometry && child.geometry.parameters.radiusBottom === .52) as THREE.Mesh<THREE.CylinderGeometry> | undefined;
    if (mast) rooftops.set(`${object.position.x}|${object.position.z}`, mast.position.y - mast.geometry.parameters.height / 2);
  }

  for (let ix = 0; ix < 17; ix++) for (let iz = 0; iz < 17; iz++) {
    const x = (ix - 8) * ROAD_STEP; const z = (iz - 8) * ROAD_STEP;
    const seed = ix * 17 + iz;
    const block = new THREE.Group(); block.name = 'Cyberpunk mixed-use block'; block.position.set(x, 0, z); scene.add(block); blocks.push(block);
    for (let side = 0; side < 4; side++) {
      const face = new THREE.Group(); face.rotation.y = side * Math.PI / 2; block.add(face);
      const color = neon[(seed + side) % neon.length];
      // The maximum canopy edge is 12.48 m from a block center. Road lanes start at 13 m.
      box(face, 0, 1.98, 11.52, 22.55, 3.48, .16, concrete);
      box(face, 0, 3.84, 12.04, 22.55, .16, .88, steel);
      box(face, 0, 3.76, 12.41, 21.9, .036, .04, color);
      for (const division of [-11.1, -3.67, 3.67, 11.1]) box(face, division, 1.93, 11.69, .13, 3.32, .19, steel);
      for (let shop = 0; shop < 3; shop++) panel(face, atlas.shops[(seed + side * 3 + shop) % atlas.shops.length], (shop - 1) * 7.35, 1.97, 11.714, 7.14, 3.17);

      if (side === seed % 4 && seed % 3 === 0) {
        // AC cassettes, bolted service cabinets, parallel risers and a small security camera.
        box(face, -7.7, 5.17, 11.69, 2.15, 1.07, .49, vents);
        box(face, -4.9, 4.85, 11.64, .72, 1.4, .23, steel);
        box(face, -4.89, 5.28, 11.77, .38, .1, .015, color);
        for (const dx of [-3.7, -3.4]) {
          pipe(face, dx, 5.06, 11.7, .055, 2.1);
          box(face, dx, 4.25, 11.7, .19, .08, .19, steel);
          box(face, dx, 5.91, 11.7, .19, .08, .19, steel);
        }
        box(face, 7.8, 4.73, 11.85, .44, .21, .32, concrete).rotation.x = .24;
        box(face, 7.8, 4.68, 12.03, .12, .1, .035, steel);
        box(face, 7.8, 4.72, 11.64, .08, .12, .28, steel);
        const leads = [new THREE.Vector3(-7.8, 4.57, 11.82), new THREE.Vector3(-6.5, 4.33, 11.82), new THREE.Vector3(-4.8, 4.36, 11.82)];
        const conduit = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(leads), 8, .036, 4, false), steel);
        face.add(conduit);
      }
      if (side === (seed + 1) % 4 && seed % 3 === 0) {
        const tile = atlas.adverts[(seed + side) % atlas.adverts.length];
        box(face, 9.4, 7.75, 11.86, 1.92, 7.67, .27, steel);
        panel(face, tile, 9.4, 7.75, 12.01, 1.72, 7.35);
        box(face, 8.42, 7.75, 11.91, .045, 7.45, .08, color);
      }
      if (side === seed % 4 && seed % 11 === 0) {
        // Large screens are mounted above the street; their supports stay on the building face.
        box(face, .2, 18.7, 11.49, 5.98, 11.92, .32, steel);
        panel(face, atlas.adverts[(seed + 3) % atlas.adverts.length], .2, 18.7, 11.67, 5.68, 11.62);
        box(face, -2.84, 18.7, 11.68, .05, 11.92, .05, color);
        box(face, 3.24, 18.7, 11.68, .05, 11.92, .05, color);
        box(face, .2, 12.45, 11.36, 1.8, .25, .6, rust);
      }
    }
    const roof = rooftops.get(`${x}|${z}`);
    if (roof !== undefined && seed % 3 === 0) {
      const variant = (seed + 1) % 5;
      const roofX = variant === 0 ? 5.4 : variant === 3 ? -2 : variant === 1 ? 2.1 : 0;
      box(block, roofX, roof + .52, -.4, 2.3, 1, 1.3, vents);
      pipe(block, roofX + .4, roof + 3.4, .2, .08, 6.6);
      box(block, roofX + .4, roof + 4.1, .2, 2.1, .06, .06, steel);
      box(block, roofX + .4, roof + 6.1, .2, 1.35, .05, .05, steel);
      box(block, roofX + .4, roof + 6.75, .2, .13, .1, .13, neon[1]);
    }
    // These enter the existing four-light pool, so extra shop lamps do not increase shader cost.
    if (seed % 6 === 0 && Math.abs(x) <= 176 && Math.abs(z) <= 176) {
      const light = new THREE.PointLight(seed % 12 === 0 ? 0xffad68 : 0x47dbe4, 18, 21, 2);
      light.position.set(x, 3.1, z - 12); scene.add(light);
    }
  }

  // Repeated solid details use eight shared instance draws, rather than adding dozens of batches.
  const buckets = new Map<string, {
    material: THREE.Material; geometry: THREE.BufferGeometry; meshes: THREE.Mesh[];
    cells: Map<string, { x: number; z: number; street: number[]; roof: number[] }>;
  }>();
  for (const block of blocks) {
    block.updateWorldMatrix(true, true);
    block.traverse(object => {
      if (!(object instanceof THREE.Mesh) || (object.geometry !== unitBox && object.geometry !== unitPipe)) return;
      const material = object.material as THREE.Material;
      const key = `${object.geometry.uuid}|${material.uuid}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { material, geometry: object.geometry, meshes: [], cells: new Map() }; buckets.set(key, bucket); }
      bucket.meshes.push(object);
      const cellKey = `${block.position.x}|${block.position.z}`;
      let cell = bucket.cells.get(cellKey);
      if (!cell) { cell = { x: block.position.x, z: block.position.z, street: [], roof: [] }; bucket.cells.set(cellKey, cell); }
      (object.matrixWorld.elements[13] > 30 ? cell.roof : cell.street).push(...object.matrixWorld.elements);
    });
  }
  for (const bucket of buckets.values()) {
    const instances = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.meshes.length);
    instances.name = 'Cyberpunk / shared facade hardware'; instances.userData.cyberpunkDetail = true; instances.userData.noCastShadow = true;
    instances.userData.cityInstanceCells = Array.from(bucket.cells.values(), cell => ({ x: cell.x, z: cell.z, street: new Float32Array(cell.street), roof: new Float32Array(cell.roof) }));
    bucket.meshes.forEach((mesh, i) => { instances.setMatrixAt(i, mesh.matrixWorld); mesh.removeFromParent(); });
    instances.instanceMatrix.needsUpdate = true; instances.computeBoundingSphere(); scene.add(instances);
  }
  return { screen(index: number, width: number, height: number) { return makeScreen(atlas.adverts[index % atlas.adverts.length], width, height); } };
}
