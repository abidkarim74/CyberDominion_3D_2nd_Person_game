import * as THREE from 'three';
import type { WorldCollider } from './city-collision';
import { RETAIL_PODIUM_HALF_SIZE, RETAIL_PODIUM_HEIGHT } from './city-layout';
import { animatedScreenMaterial, screenClock } from './city-screens';

export type FacadeStyle = {
  windows: THREE.CanvasTexture;
  trim: number;
  accent: number;
  facade: THREE.MeshBasicMaterial;
  neon: THREE.MeshBasicMaterial;
  secondary: THREE.MeshBasicMaterial;
};

const PALETTE = [
  { color: '#63dce5', trim: 0x34d5e8, accent: 0xf142a0 },
  { color: '#ee78ae', trim: 0xef4b99, accent: 0x39dbe7 },
  { color: '#dca65f', trim: 0xeab85e, accent: 0x63dbdf },
  { color: '#a09bd6', trim: 0x9b86ee, accent: 0xed6887 },
  { color: '#7bc5b4', trim: 0x5cd7b5, accent: 0xea659d },
];

export const SKYLINE_SHAPES = [
  'terraced market', 'industrial loft', 'stacked habitat', 'twin spires',
  'slanted blade', 'setback tower', 'split crown', 'faceted reactor',
  'offset megablock', 'needle tower', 'sky gate', 'broadcast citadel',
] as const;

export type SkylineBuilding = {
  x: number; z: number; seed: number; width: number; depth: number; height: number;
  shape: number; archetype: typeof SKYLINE_SHAPES[number]; quarterTurn: number; styleIndex: number; landmark: boolean;
};

function randomFor(seed: number) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}

// Deliberately separated landmarks give each part of the city its own distant silhouette.
const LANDMARKS = [
  { x: 44, z: 88, height: 316, shape: 9 },
  { x: -88, z: 44, height: 248, shape: 10 },
  { x: 132, z: -88, height: 284, shape: 3 },
  { x: -176, z: -132, height: 232, shape: 11 },
  { x: 220, z: 132, height: 264, shape: 6 },
  { x: -264, z: 176, height: 218, shape: 4 },
  { x: 88, z: -264, height: 276, shape: 7 },
  { x: -44, z: 264, height: 242, shape: 5 },
];

const CITY_HEIGHT_SCALE = 1.75;

/** Stable city planning is independent of detail density and render quality. */
export function planSkylineBuilding(x: number, z: number, seed: number): SkylineBuilding {
  const random = randomFor(Math.imul(seed, 92837111) ^ 0x57af193d);
  const landmark = LANDMARKS.find(building => building.x === x && building.z === z);
  const roll = random();
  const low = roll < .3;
  const mid = roll < .7;
  const districtDensity = Math.max(0, 1 - Math.hypot(x + 22, z - 44) / 440);
  // A cluster of corporate towers, rather than an evenly scattered picket fence.
  // Low-rise blocks still interrupt the street canyon and reveal the skyline beyond it.
  // Build at the taller height so facade floors, rooftop details and colliders stay aligned.
  const height = (landmark?.height ?? (low ? 18 + random() * 17 : mid ? 40 + random() * 50 + districtDensity * 24 : roll < .94 ? 102 + random() * 78 + districtDensity * 32 : 184 + random() * 58)) * CITY_HEIGHT_SCALE;
  const width = landmark ? 21.5 + random() * 1.6 : low ? 19 + random() * 4.5 : 12.4 + random() * 10.5;
  const depth = landmark ? 18.5 + random() * 4 : low ? 14 + random() * 9 : 12.6 + random() * 10.2;
  const shape = landmark?.shape ?? (low ? Math.floor(random() * 2) : mid ? [0, 1, 2, 5, 8][Math.floor(random() * 5)] : 3 + Math.floor(random() * 9));
  return { x, z, seed, width, depth, height, shape, archetype: SKYLINE_SHAPES[shape], quarterTurn: Math.floor(random() * 4), styleIndex: Math.floor(random() * PALETTE.length), landmark: !!landmark };
}

function facadeTexture(seed: number, ink: string) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 768;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('Canvas textures are unavailable.');
  const random = randomFor(seed * 179 + 93);
  c.fillStyle = ['#16212b', '#23222a', '#25282b', '#1d2430', '#19292d'][seed];
  c.fillRect(0, 0, 256, 768);
  // Baked glass reflections and weathering add surface depth without a second texture
  // or costly reflective tower materials. Every style keeps the same physical UV scale.
  for (let column = 0; column < 12; column++) {
    const x = column * 256 / 12;
    const glass = c.createLinearGradient(x, 0, x + 21, 0);
    glass.addColorStop(0, 'rgba(2,8,14,.45)');
    glass.addColorStop(.36, seed % 2 ? 'rgba(124,134,154,.05)' : 'rgba(114,179,193,.12)');
    glass.addColorStop(1, 'rgba(2,8,14,.28)');
    c.fillStyle = glass; c.fillRect(x, 0, 21, 768);
  }
  // Physical-size UVs repeat this 12-bay / 40-floor tile without stretching skyscraper windows.
  for (let row = 0; row < 40; row++) for (let column = 0; column < 12; column++) {
    const x = column * 256 / 12 + 3; const y = row * 768 / 40 + 3;
    const chance = random();
    const office = seed === 0 || seed === 3;
    const serviceBay = column === seed + 2 && row % 8 > 2;
    c.fillStyle = '#080f16'; c.fillRect(x - 1, y - 1, 17, 14);
    if (chance < (office ? .3 : .42) || serviceBay) {
      c.fillStyle = 'rgba(72,116,136,.14)'; c.fillRect(x, y, 14, 10);
      continue;
    }
    c.fillStyle = chance > .91 ? ink : (seed === 1 || seed === 2) && chance > .48 ? '#d1b986' : chance > .76 ? '#b1c9c3' : '#729ba6';
    c.globalAlpha = chance > .91 ? .9 : .37 + random() * .39;
    c.fillRect(x, y, 14, office ? 8 : 10); c.globalAlpha = 1;
    // Ceiling fixtures, blinds and the shadow of an interior partition give rooms scale.
    c.fillStyle = 'rgba(226,243,235,.35)'; c.fillRect(x + 1, y + 1, 12, 1);
    c.fillStyle = 'rgba(3,10,16,.65)'; c.fillRect(x + (office ? 9 : 6), y, 1, 11);
    if (!office && chance < .67) {
      c.fillStyle = 'rgba(9,14,18,.45)'; c.fillRect(x, y + 3, 14, 1); c.fillRect(x, y + 6, 14, 1);
    }
    if (office && chance > .77) {
      c.fillStyle = 'rgba(2,9,15,.6)'; c.fillRect(x + 2, y + 5, 4, 3);
    }
  }
  // Mechanical floor bands, concrete panel seams and occasional circuit traces are baked.
  for (let row = 0; row < 40; row++) {
    const y = row * 768 / 40;
    c.fillStyle = row % 8 === 0 ? '#091019' : 'rgba(4,10,16,.48)'; c.fillRect(0, y, 256, row % 8 === 0 ? 5 : 2);
    c.fillStyle = 'rgba(118,148,159,.18)'; c.fillRect(0, y + 15, 256, 1);
    if (row % 8 === 0) {
      c.fillStyle = '#283840'; c.fillRect(0, y + 2, 256, 1);
      for (let vent = 0; vent < 18; vent++) { c.fillStyle = '#46515a'; c.fillRect(vent * 14 + 2, y + 1, 1, 3); }
      c.fillStyle = ink; c.globalAlpha = .5; c.fillRect(21, y + 1, 85 + seed * 9, 1); c.globalAlpha = 1;
    }
  }
  for (let column = 0; column < 12; column += 3) {
    c.fillStyle = 'rgba(6,11,18,.7)'; c.fillRect(column * 256 / 12, 0, 3, 768);
    c.fillStyle = 'rgba(115,148,160,.18)'; c.fillRect(column * 256 / 12 + 3, 0, 1, 768);
  }
  for (let i = 0; i < 100; i++) {
    c.fillStyle = `rgba(2,6,10,${.05 + random() * .12})`;
    c.fillRect(random() * 256, random() * 768, 1 + random() * 2, 12 + random() * 110);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 4;
  return texture;
}

export function makeSkylineStyles(): FacadeStyle[] {
  return PALETTE.map((palette, index) => {
    const windows = facadeTexture(index, palette.color);
    const facade = new THREE.MeshBasicMaterial({ map: windows, color: 0xc1d0d4 });
    // Lighting is baked on the facade, keeping a 300m tower as cheap to shade as a low rise.
    facade.onBeforeCompile = shader => {
      shader.vertexShader = 'varying vec3 facadeNormal;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nfacadeNormal = normal;');
      shader.fragmentShader = 'varying vec3 facadeNormal;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= .68 + .32 * abs(dot(normalize(facadeNormal), normalize(vec3(.4,.2,.7))));');
    };
    const neon = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.trim).multiplyScalar(1.55), toneMapped: false });
    const secondary = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.accent).multiplyScalar(1.25), toneMapped: false });
    neon.userData.noCastShadow = true; secondary.userData.noCastShadow = true;
    return { windows, trim: palette.trim, accent: palette.accent, facade, neon, secondary };
  });
}

const SHELL = new THREE.MeshStandardMaterial({ color: 0x28343d, metalness: .58, roughness: .64 });
const ROOF = new THREE.MeshStandardMaterial({ color: 0x121d28, metalness: .7, roughness: .5 });
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
const BEACON = new THREE.OctahedronGeometry(.22);
const AD_PLANES = Array.from({ length: 4 }, (_, tile) => {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (tile * 256 + 2 + uv.getX(i) * 252) / 1024, (2 + uv.getY(i) * 764) / 768);
  return geometry;
});

function box(parent: THREE.Group, x: number, y: number, z: number, width: number, height: number, depth: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(UNIT_BOX, material); mesh.position.set(x, y, z); mesh.scale.set(width, height, depth); parent.add(mesh); return mesh;
}

function octagon(width: number, depth: number, y: number, x = 0, z = 0) {
  const cut = Math.min(width, depth) * .14;
  return [[-width / 2 + cut, y, -depth / 2], [width / 2 - cut, y, -depth / 2], [width / 2, y, -depth / 2 + cut], [width / 2, y, depth / 2 - cut], [width / 2 - cut, y, depth / 2], [-width / 2 + cut, y, depth / 2], [-width / 2, y, depth / 2 - cut], [-width / 2, y, -depth / 2 + cut]].map(point => [point[0] + x, point[1], point[2] + z]);
}

/** Eight wall faces, one flat roof; even landmarks require only a few dozen triangles. */
function section(parent: THREE.Group, material: THREE.Material, y0: number, y1: number, w0: number, d0: number, w1 = w0, d1 = d0, x0 = 0, z0 = 0, x1 = x0, z1 = z0) {
  const bottom = octagon(w0, d0, y0, x0, z0); const top = octagon(w1, d1, y1, x1, z1);
  const positions: number[] = []; const uvs: number[] = [];
  for (let face = 0; face < 8; face++) {
    const next = (face + 1) % 8;
    const u = Math.hypot(bottom[next][0] - bottom[face][0], bottom[next][2] - bottom[face][2]) / 16.8;
    const v0 = y0 / 128; const v1 = y1 / 128;
    for (const point of [bottom[face], top[next], bottom[next], bottom[face], top[face], top[next]]) positions.push(...point);
    uvs.push(0, v0, u, v1, u, v0, 0, v0, 0, v1, u, v1);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.computeVertexNormals();
  parent.add(new THREE.Mesh(geometry, material));
  const roofPositions: number[] = [];
  for (let face = 0; face < 8; face++) roofPositions.push(x1, y1 + .012, z1, ...top[(face + 1) % 8], ...top[face]);
  const roof = new THREE.BufferGeometry(); roof.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3)); roof.computeVertexNormals(); parent.add(new THREE.Mesh(roof, ROOF));
}

function ribbon(parent: THREE.Group, material: THREE.Material, x0: number, y0: number, x1: number, y1: number, z0: number, width = .13, z1 = z0) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    x0 - width / 2, y0, z0, x1 - width / 2, y1, z1, x1 + width / 2, y1, z1,
    x0 - width / 2, y0, z0, x1 + width / 2, y1, z1, x0 + width / 2, y0, z0,
  ], 3));
  geometry.computeVertexNormals(); parent.add(new THREE.Mesh(geometry, material));
}

function signTexture(text: string, color: number) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128; const c = canvas.getContext('2d')!;
  const ink = `#${color.toString(16).padStart(6, '0')}`;
  c.fillStyle = '#080e16'; c.fillRect(0, 0, 512, 128);
  c.fillStyle = ink; c.fillRect(8, 8, 496, 3); c.fillRect(8, 117, 496, 3);
  c.font = '900 55px Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 256, 63, 465);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

let campaignArtwork: Promise<HTMLImageElement | null> | undefined;

/** Four original vertical campaigns share one mipmapped, opaque atlas and one shader. */
function towerAdvertisements(scene: THREE.Scene, signs: Map<string, THREE.MeshBasicMaterial>) {
  const cached = signs.get('__tower-advertisement-atlas');
  if (cached) return cached;
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
  const c = canvas.getContext('2d')!;
  const colors = ['#57dce9', '#ef4999', '#c9df7e', '#ffaf67'];
  for (let tile = 0; tile < 4; tile++) {
    c.save(); c.translate(tile * 256, 0);
    const ink = colors[tile];
    const gradient = c.createLinearGradient(0, 0, 256, 768);
    gradient.addColorStop(0, ['#164c74', '#9d286d', '#37655b', '#954939'][tile]);
    gradient.addColorStop(.55, ['#287485', '#c04486', '#73966b', '#b76754'][tile]);
    gradient.addColorStop(1, ['#0d2e49', '#3b1a48', '#233f43', '#482541'][tile]);
    c.fillStyle = gradient; c.fillRect(0, 0, 256, 768);
    c.fillStyle = ink; c.fillRect(9, 10, 238, 5); c.fillRect(9, 752, 238, 5);
    c.font = '700 12px Arial, sans-serif'; c.fillText(['KAIRO / OPTICAL SYSTEMS', 'VANTA / HUMAN TECHNOLOGY', 'ORBIT / URBAN NETWORK', 'SYNAPSE / AFTER DARK'][tile], 17, 36, 223);
    c.font = '900 36px Arial, sans-serif';
    const title = [['SEE', 'BEYOND.'], ['A BETTER', 'YOU.'], ['THE CITY', 'IS YOURS.'], ['STAY', 'AWAKE.']][tile];
    c.fillText(title[0], 16, 91, 224); c.fillText(title[1], 16, 129, 224);
    c.lineWidth = 2; c.strokeStyle = ink;
    if (tile === 0) {
      // A technical ocular implant, with the pupil surrounded by calibrated reticles.
      c.fillStyle = '#79cbd1'; c.beginPath(); c.moveTo(18, 356); c.quadraticCurveTo(128, 248, 238, 356); c.quadraticCurveTo(128, 464, 18, 356); c.fill();
      c.fillStyle = '#071721'; c.beginPath(); c.arc(128, 356, 69, 0, Math.PI * 2); c.fill();
      for (const radius of [66, 54, 37, 21]) { c.beginPath(); c.arc(128, 356, radius, 0, Math.PI * 2); c.stroke(); }
      for (let spoke = 0; spoke < 36; spoke++) {
        const a = spoke / 36 * Math.PI * 2;
        c.beginPath(); c.moveTo(128 + Math.cos(a) * 41, 356 + Math.sin(a) * 41); c.lineTo(128 + Math.cos(a) * 59, 356 + Math.sin(a) * 59); c.stroke();
      }
      c.fillStyle = '#def9ec'; c.beginPath(); c.arc(112, 334, 8, 0, Math.PI * 2); c.fill();
      for (const y of [254, 460, 485]) { c.beginPath(); c.moveTo(23, y); c.lineTo(81, y); c.lineTo(99, y - 18); c.stroke(); }
    } else if (tile === 1) {
      // A sculptural synthetic face, deliberately drawn as a campaign illustration.
      c.fillStyle = '#e9b7c8'; c.beginPath(); c.moveTo(70, 273); c.bezierCurveTo(68, 223, 190, 207, 195, 286); c.lineTo(185, 379); c.lineTo(145, 426); c.lineTo(97, 405); c.lineTo(65, 344); c.closePath(); c.fill();
      c.fillStyle = '#562750'; c.beginPath(); c.moveTo(122, 252); c.lineTo(156, 262); c.lineTo(143, 362); c.lineTo(178, 377); c.lineTo(145, 411); c.lineTo(124, 354); c.closePath(); c.fill();
      c.fillStyle = '#143441'; c.fillRect(74, 303, 47, 12); c.fillRect(151, 303, 31, 12);
      c.fillStyle = '#82e4e4'; c.fillRect(79, 306, 34, 3); c.fillRect(153, 306, 23, 3);
      c.fillStyle = '#b8417c'; c.fillRect(120, 382, 37, 5);
      c.fillStyle = '#d4448a'; c.beginPath(); c.moveTo(103, 412); c.lineTo(94, 465); c.lineTo(40, 519); c.lineTo(25, 585); c.lineTo(227, 585); c.lineTo(205, 521); c.lineTo(155, 469); c.lineTo(156, 425); c.closePath(); c.fill();
      for (let line = 0; line < 7; line++) { c.beginPath(); c.moveTo(41, 533 + line * 7); c.lineTo(126, 453 + line * 8); c.lineTo(203, 536 + line * 7); c.stroke(); }
    } else if (tile === 2) {
      c.font = '900 122px Arial, sans-serif'; c.fillText('07', 24, 357, 218);
      c.lineWidth = 3;
      for (let route = 0; route < 7; route++) {
        c.beginPath(); c.moveTo(20, 395 + route * 20); c.lineTo(74, 395 + route * 20); c.lineTo(119, 433 + route * 8); c.lineTo(213, 433 + route * 8); c.stroke();
        c.fillStyle = '#e0ead3'; c.beginPath(); c.arc(74, 395 + route * 20, 4, 0, Math.PI * 2); c.fill();
      }
      for (let building = 0; building < 10; building++) {
        c.fillStyle = building % 3 === 0 ? '#9fbd99' : '#527577'; c.fillRect(18 + building * 23, 585 - (building % 4) * 19, 15, 40 + (building % 4) * 19);
      }
    } else {
      c.fillStyle = '#f68d71'; c.beginPath(); c.arc(127, 366, 108, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#321a35'; c.beginPath(); c.arc(127, 366, 81, 0, Math.PI * 2); c.fill();
      for (let ring = 0; ring < 6; ring++) {
        c.strokeStyle = ring % 2 ? '#ea70a4' : '#eebd91'; c.lineWidth = 6;
        c.beginPath(); c.arc(127, 366, 21 + ring * 11, ring * .55, ring * .55 + Math.PI * 1.4); c.stroke();
      }
      c.fillStyle = ink; c.font = '900 25px Arial, sans-serif'; c.fillText('NIGHT / EDITION', 15, 545, 227);
    }
    c.fillStyle = '#e4e8df'; c.font = '700 15px Arial, sans-serif';
    c.fillText(['VISION WITHOUT LIMITS', 'UPGRADE YOUR EVERYDAY', 'CONNECTED. EVERYWHERE.', 'MORE HOURS. MORE LIFE.'][tile], 16, 661, 222);
    c.fillStyle = ink; c.font = '900 24px Arial, sans-serif'; c.fillText(['KAIROSHI', 'VANTA+', 'ORBIT 07', 'SYNAPSE'][tile], 16, 708, 222);
    c.font = '10px monospace'; c.fillText('NC / 24H / ACCESS AVAILABLE', 17, 735, 224);
    // LED scanlines and the segmented pixels of a real outdoor display are baked once.
    c.fillStyle = 'rgba(4,7,17,.2)'; for (let line = 0; line < 768; line += 4) c.fillRect(0, line, 256, 1);
    c.fillStyle = 'rgba(4,7,17,.12)'; for (let line = 0; line < 256; line += 5) c.fillRect(line, 0, 1, 768);
    c.restore();
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const material = animatedScreenMaterial(map, screenClock(scene), 'tower');
  signs.set('__tower-advertisement-atlas', material);

  // The procedural artwork is available immediately. Decode one local photograph
  // atlas for the session and repaint this same canvas once; geometry, mipmaps and
  // draw batches retain their existing layout and memory footprint.
  let disposed = false;
  map.addEventListener('dispose', () => { disposed = true; });
  campaignArtwork ??= new Promise(resolve => {
    const artwork = new Image(); artwork.decoding = 'async';
    artwork.onload = () => resolve(artwork);
    artwork.onerror = () => resolve(null);
    artwork.src = '/textures/night-city-campaigns-v1.webp';
  });
  void campaignArtwork.then(artwork => {
    if (!artwork || disposed) return;
    const sourceWidth = artwork.naturalWidth / 4;
    // Keep optical, human, network and energy campaigns aligned with their palette.
    const sourceColumns = [1, 0, 3, 2];
    const titles = [['SEE', 'BEYOND.'], ['A BETTER', 'YOU.'], ['THE CITY', 'IS YOURS.'], ['STAY', 'AWAKE.']];
    for (let tile = 0; tile < 4; tile++) {
      c.save(); c.translate(tile * 256, 0);
      c.drawImage(artwork, sourceColumns[tile] * sourceWidth, 0, sourceWidth, artwork.naturalHeight, 0, 0, 256, 768);
      // The image centers remain unobstructed. Small header/footer scrims carry
      // readable typography without covering the face, ocular implant or product.
      const topShade = c.createLinearGradient(0, 0, 0, 114);
      topShade.addColorStop(0, 'rgba(3,8,15,.76)'); topShade.addColorStop(.75, 'rgba(3,8,15,.55)'); topShade.addColorStop(1, 'rgba(3,8,15,0)');
      c.fillStyle = topShade; c.fillRect(0, 0, 256, 114);
      const bottomShade = c.createLinearGradient(0, 636, 0, 768);
      bottomShade.addColorStop(0, 'rgba(3,8,15,0)'); bottomShade.addColorStop(.34, 'rgba(3,8,15,.56)'); bottomShade.addColorStop(1, 'rgba(3,8,15,.8)');
      c.fillStyle = bottomShade; c.fillRect(0, 636, 256, 132);
      c.fillStyle = colors[tile]; c.fillRect(9, 10, 238, 3); c.fillRect(9, 752, 238, 3);
      c.font = '700 10px Arial, sans-serif'; c.fillText(['KAIRO / OPTICAL SYSTEMS', 'VANTA / HUMAN TECHNOLOGY', 'ORBIT / URBAN NETWORK', 'SYNAPSE / AFTER DARK'][tile], 15, 28, 226);
      c.fillStyle = '#e9f5ef'; c.font = '900 29px Arial, sans-serif';
      c.fillText(titles[tile][0], 14, 62, 228); c.fillText(titles[tile][1], 14, 93, 228);
      c.font = '700 12px Arial, sans-serif';
      c.fillText(['VISION WITHOUT LIMITS', 'UPGRADE YOUR EVERYDAY', 'CONNECTED. EVERYWHERE.', 'MORE HOURS. MORE LIFE.'][tile], 15, 677, 226);
      c.fillStyle = colors[tile]; c.font = '900 27px Arial, sans-serif';
      c.fillText(['KAIROSHI', 'VANTA+', 'ORBIT 07', 'SYNAPSE'][tile], 15, 718, 226);
      c.font = '10px monospace'; c.fillText('NC / 24H / ACCESS AVAILABLE', 15, 740, 226);
      c.fillStyle = 'rgba(4,7,17,.14)'; for (let line = 0; line < 768; line += 4) c.fillRect(0, line, 256, 1);
      c.fillStyle = 'rgba(4,7,17,.08)'; for (let line = 0; line < 256; line += 5) c.fillRect(line, 0, 1, 768);
      c.restore();
    }
    material.color.setScalar(1.35);
    map.needsUpdate = true;
  });
  return material;
}

/** Opaque facades and LED campaigns share the existing city batches. */
export function addSkylineBuilding(scene: THREE.Scene, styles: FacadeStyle[], colliders: WorldCollider[], plan: SkylineBuilding, signs: Map<string, THREE.MeshBasicMaterial>) {
  const { x, z, seed, width: w, depth: d, height: h, shape, quarterTurn } = plan;
  const style = styles[plan.styleIndex]; const group = new THREE.Group();
  group.name = `Cyberpunk / ${SKYLINE_SHAPES[shape]}`; group.position.set(x, 0, z); group.rotation.y = quarterTurn * Math.PI / 2;
  group.userData.skylineBuilding = plan;
  const podiumW = Math.min(24.2, w + 1.1); const podiumD = Math.min(24.2, d + 1.1);
  // A closed retail floor reaches all four storefronts and seals their corners.
  // Keep it in permanent architecture so distance culling never removes the shop walls.
  const retailSize = RETAIL_PODIUM_HALF_SIZE * 2;
  const podium = box(group, 0, (.22 + RETAIL_PODIUM_HEIGHT) / 2, 0,
    retailSize, RETAIL_PODIUM_HEIGHT - .22, retailSize, SHELL);
  podium.name = 'Cyberpunk / solid retail podium';
  const retailRoof = box(group, 0, RETAIL_PODIUM_HEIGHT + .05, 0, retailSize + .16, .18, retailSize + .16, ROOF);
  retailRoof.name = 'Cyberpunk / retail roof slab';
  const wall = (y0: number, y1: number, w0: number, d0: number, w1 = w0, d1 = d0, x0 = 0, z0 = 0, x1 = x0, z1 = z0) => section(group, style.facade, y0, y1, w0, d0, w1, d1, x0, z0, x1, z1);
  const edge = (y: number, width: number, depth: number, cx = 0, cz = 0, material: THREE.Material = style.neon) => {
    // Four opaque facade strips use eight triangles rather than four twelve-triangle boxes.
    const positions: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (const side of [-1, 1]) {
      const left = cx - width * .365; const right = cx + width * .365;
      const front = cz - depth * .355; const back = cz + depth * .355;
      const a = [left, y - .065, cz + side * (depth / 2 + .02)]; const b = [left, y + .065, a[2]];
      const c = [right, y + .065, a[2]]; const d = [right, y - .065, a[2]];
      if (side < 0) quad(a, b, c, d); else quad(d, c, b, a);
      const e = [cx + side * (width / 2 + .02), y - .065, front]; const f = [e[0], y + .065, front];
      const g = [e[0], y + .065, back]; const j = [e[0], y - .065, back];
      if (side > 0) quad(e, f, g, j); else quad(j, g, f, e);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals(); group.add(new THREE.Mesh(geometry, material));
  };
  let roofX = 0; const roofZ = 0;
  if (shape === 0) {
    // Wide market blocks step back into a compact roof pavilion.
    wall(4.1, h * .58, w, d); wall(h * .58, h * .82, w * .8, d * .76, w * .8, d * .76, -w * .08);
    wall(h * .82, h, w * .52, d * .59, w * .52, d * .59, w * .08);
    edge(h * .58, w, d); edge(h, w * .52, d * .59, w * .08, 0, style.secondary); roofX = w * .08;
  } else if (shape === 1) {
    wall(4.1, h * .83, w, d); wall(h * .83, h, w * .58, d * .65, w * .58, d * .65, -w * .13); roofX = -w * .13;
    for (const side of [-1, 1]) box(group, side * w * .32, (h * .8 + 4.1) / 2, -d / 2 - .08, .32, h * .8 - 4.1, .2, SHELL);
    edge(h * .83, w, d); edge(h, w * .58, d * .65, roofX, 0, style.secondary);
  } else if (shape === 2 || shape === 8) {
    const tiers = shape === 2 ? 4 : 3;
    for (let tier = 0; tier < tiers; tier++) {
      const y0 = 4.1 + (h - 4.1) * tier / tiers; const y1 = 4.1 + (h - 4.1) * (tier + 1) / tiers;
      const scale = .89 - tier * .13; const cx = (tier % 2 ? 1 : -1) * w * .055;
      wall(y0, y1, w * scale, d * scale, w * scale, d * scale, cx);
      edge(y1, w * scale, d * scale, cx, 0, tier % 2 ? style.secondary : style.neon); roofX = cx;
    }
  } else if (shape === 3 || shape === 10) {
    const split = shape === 10 ? .4 : .24;
    wall(4.1, h * split, w, d);
    for (const side of [-1, 1]) {
      const cx = side * w * .29; const top = side < 0 && shape === 3 ? h * .84 : h;
      wall(h * split, top, w * .37, d * .78, w * .31, d * .66, cx);
      edge(top, w * .31, d * .66, cx, 0, side < 0 ? style.secondary : style.neon);
      ribbon(group, side < 0 ? style.secondary : style.neon, cx, h * split, cx, top, -d * .395, .17, -d * .335);
    }
    const bridgeY = h * (shape === 10 ? .88 : .63);
    box(group, 0, bridgeY, 0, w * .83, Math.max(2, h * .024), d * .37, SHELL);
    box(group, 0, bridgeY, -d * .19, w * .83, .2, .1, style.secondary); roofX = w * .29;
  } else if (shape === 4) {
    // A sheared, tapered blade is recognisable even as a distant dark silhouette.
    wall(4.1, h * .32, w, d, w * .91, d * .89);
    wall(h * .32, h, w * .8, d * .78, w * .31, d * .6, -w * .05, 0, w * .21);
    ribbon(group, style.neon, -w * .338, h * .32, w * .0984, h, -d * .395, .21, -d * .305);
    ribbon(group, style.secondary, w * .238, h * .32, w * .3216, h, -d * .395, .14, -d * .305); roofX = w * .21;
    edge(h, w * .31, d * .6, roofX);
  } else if (shape === 5 || shape === 11) {
    const tiers = shape === 11 ? 5 : 4;
    for (let tier = 0; tier < tiers; tier++) {
      const scale = 1 - tier * (shape === 11 ? .16 : .17); const cx = tier * w * .028;
      const y0 = 4.1 + (h - 4.1) * tier / tiers; const y1 = 4.1 + (h - 4.1) * (tier + 1) / tiers;
      wall(y0, y1, w * scale, d * scale, w * scale, d * scale, cx); edge(y1, w * scale, d * scale, cx); roofX = cx;
    }
  } else if (shape === 6) {
    wall(4.1, h * .7, w, d, w * .84, d * .9);
    for (const side of [-1, 1]) {
      const cx = side * w * .25; const top = side < 0 ? h : h * .87;
      wall(h * .7, top, w * .29, d * .64, w * .21, d * .57, cx);
      edge(top, w * .21, d * .57, cx, 0, style.secondary);
    }
    edge(h * .7, w * .84, d * .9); roofX = -w * .25;
  } else if (shape === 7) {
    for (let tier = 0; tier < 4; tier++) {
      const lower = .68 + Math.sin(tier / 4 * Math.PI) * .32; const upper = .68 + Math.sin((tier + 1) / 4 * Math.PI) * .32;
      const top = 4.1 + (h - 4.1) * (tier + 1) / 4;
      wall(4.1 + (h - 4.1) * tier / 4, top, w * lower, d * lower, w * upper, d * upper);
      edge(top, w * upper, d * upper, 0, 0, tier % 2 ? style.neon : style.secondary);
    }
  } else {
    wall(4.1, h * .18, w, d); wall(h * .18, h * .77, w * .74, d * .73, w * .48, d * .48);
    wall(h * .77, h * .93, w * .48, d * .48, w * .36, d * .36);
    wall(h * .93, h, w * .36, d * .36, w * .06, d * .06);
    edge(h * .18, w, d); edge(h * .77, w * .48, d * .48, 0, 0, style.secondary);
    for (const side of [-1, 1]) ribbon(group, style.neon, side * w * .23, h * .18, side * w * .15, h * .77, -d * .37, .18, -d * .245);
  }

  // A few long emissive rails supply architectural scale; fine floors live in the texture.
  if (shape !== 4 && shape !== 9 && shape !== 3 && shape !== 7 && shape !== 10) {
    const railTop = shape === 0 ? h * .57 : shape === 1 ? h * .82 : shape === 6 ? h * .69 : shape === 11 ? h * .19 : h * .23;
    const railZ = shape === 2 || shape === 8 ? -d * .445 - .025 : -d / 2 - .025;
    const railTopZ = shape === 6 ? -d * .45 - .025 : railZ;
    for (const side of [-1, 1]) ribbon(group, style.neon, side * w * .28, 4.2, side * w * .28, railTop, railZ, .12, railTopZ);
  }

  const baseTop = shape === 0 ? h * .58 : shape === 1 ? h * .83 : shape === 2 ? 4.1 + (h - 4.1) / 4 : shape === 8 ? 4.1 + (h - 4.1) / 3 : shape === 3 ? h * .24 : shape === 10 ? h * .4 : shape === 4 ? h * .32 : shape === 5 ? 4.1 + (h - 4.1) / 4 : shape === 11 ? 4.1 + (h - 4.1) / 5 : shape === 6 ? h * .7 : shape === 7 ? 4.1 + (h - 4.1) / 4 : h * .18;
  const baseScale = shape === 2 || shape === 8 ? .89 : shape === 7 ? .68 : 1;
  const baseWidth = w * baseScale; const baseDepth = d * baseScale;
  // Structural ribs and deep mechanical ledges keep the street-facing elevations
  // legible at driving speed. Finer vents and floor slabs remain part of the texture.
  if (h > 38 && shape !== 4 && shape !== 7) {
    for (const side of [-1, 1]) {
      box(group, side * baseWidth * .32, (4.1 + baseTop) / 2, baseDepth / 2 + .05, .26, baseTop - 4.1, .2, SHELL);
    }
    box(group, 0, baseTop - .48, baseDepth / 2 + .07, baseWidth * .73, .68, .25, ROOF);
  }

  const avenueTower = Math.abs(x + 22) < 46 || Math.abs(z + 22) < 46;
  const major = plan.landmark || [[0, 0], [-44, 0], [0, -44], [44, 0], [-44, -44], [0, 44]].some(([bx, bz]) => x === bx && z === bz);
  if ((major && h > 30) || (h > 64 && (avenueTower || seed % 3 === 0))) {
    // Major campaigns start just above shop roofs, so their subjects and copy
    // remain in the driver's view. Carriers span setbacks without entering lanes.
    const panelBottom = major ? 8.5 : Math.min(22, Math.max(10, h * .08));
    const panelHeight = Math.min(major ? 72 : 62, h - panelBottom - 5, h * .68);
    const panelY = panelBottom + panelHeight / 2;
    const adMaterial = towerAdvertisements(scene, signs);
    const tile = (seed + plan.styleIndex) % AD_PLANES.length;
    const faces = major || avenueTower ? [0, 1, 2, 3] : [seed % 4, (seed + 1) % 4];
    for (const direction of faces) {
      const carrier = new THREE.Group(); carrier.rotation.y = direction * Math.PI / 2; group.add(carrier);
      const faceWidth = direction % 2 ? d : w; const faceDepth = direction % 2 ? w : d;
      const panelWidth = Math.min(faceWidth * (major ? .84 : .76), panelHeight * .4);
      const panelZ = faceDepth / 2 + .2;
      box(carrier, 0, panelY, panelZ - .06, panelWidth + .46, panelHeight + .46, .2, ROOF);
      const ad = new THREE.Mesh(AD_PLANES[tile], adMaterial);
      ad.position.set(0, panelY, panelZ + .06); ad.scale.set(panelWidth, panelHeight, 1);
      ad.name = major ? 'Cyberpunk / major LED billboard' : 'Cyberpunk / tower campaign'; carrier.add(ad);
      for (const frameSide of [-1, 1]) box(carrier, frameSide * (panelWidth / 2 + .12), panelY, panelZ + .08, .06, panelHeight, .05, style.secondary);
      for (const frameSide of [-1, 1]) box(carrier, 0, panelY + frameSide * (panelHeight / 2 + .12), panelZ + .08, panelWidth + .3, .08, .05, style.neon);
      for (const heightFraction of [-.29, .29]) box(carrier, 0, panelY + panelHeight * heightFraction, panelZ - faceDepth * .16, panelWidth * .9, .28, faceDepth * .32, SHELL);
      const angle = (direction + quarterTurn) * Math.PI / 2;
      const billboards = scene.userData.cityBillboards ??= [];
      billboards.push({ x, z, seed, direction: (direction + quarterTurn) % 4, width: panelWidth, height: panelHeight,
        bottom: panelBottom, major, landmark: plan.landmark,
        center: [x + Math.sin(angle) * (panelZ + .06), panelY, z + Math.cos(angle) * (panelZ + .06)] });
    }
  }

  const random = randomFor(seed * 877 + 11); const mastHeight = plan.landmark ? 10 + random() * 9 : 2.2 + random() * 5;
  if (shape !== 9) {
    // Compact HVAC boxes, antenna footings and roof maintenance decks share unit
    // geometry. They stay inside the smallest tower cap and never enter road lanes.
    box(group, roofX, h + .31, roofZ, 2.35, .62, 1.72, SHELL);
    box(group, roofX - .7, h + .88, roofZ + .25, .79, .54, 1.05, ROOF);
    box(group, roofX + .66, h + .81, roofZ - .22, .73, .4, .85, SHELL);
  }
  // Keep the district roof locator compatible with its existing radiusBottom=.52 convention.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.1, .52, mastHeight, 5), ROOF);
  mast.position.set(roofX, h + mastHeight / 2, roofZ); group.add(mast);
  const beacon = new THREE.Mesh(BEACON, style.secondary); beacon.position.set(roofX, h + mastHeight, roofZ); group.add(beacon);
  if (plan.landmark || seed % 4 === 0) {
    const text = ['NEXUS', 'KAIRO', 'NEURAL+', 'VANTA', 'ORBIT'][plan.styleIndex];
    let material = signs.get(text);
    if (!material) { material = new THREE.MeshBasicMaterial({ map: signTexture(text, style.accent), toneMapped: false }); material.userData.noCastShadow = true; signs.set(text, material); }
    const signWidth = Math.min(w * .72, 13); const sign = new THREE.Mesh(UNIT_PLANE, material); sign.scale.set(signWidth, signWidth * .25, 1);
    sign.position.set(0, Math.min(13.2, h * .3), -d / 2 - .09); sign.rotation.y = Math.PI; group.add(sign);
  }
  scene.add(group);
  let triangles = 0;
  group.traverse(object => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  scene.userData.cyberpunkSkylineTriangles = (scene.userData.cyberpunkSkylineTriangles ?? 0) + triangles;
  const rotated = quarterTurn % 2 !== 0;
  // The low retail volume gets its own geometry collider. Keep the upper tower's
  // narrower footprint so cameras do not hit invisible walls above the shop roof.
  colliders.push({ x, z, hx: (rotated ? podiumD : podiumW) / 2 + .04, hz: (rotated ? podiumW : podiumD) / 2 + .04, maxY: h + mastHeight, label: group.name });
}
