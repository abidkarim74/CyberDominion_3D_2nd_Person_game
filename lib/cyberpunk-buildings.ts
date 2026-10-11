import * as THREE from 'three';
import type { WorldCollider } from './city-collision';

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

/** Stable city planning is independent of detail density and render quality. */
export function planSkylineBuilding(x: number, z: number, seed: number): SkylineBuilding {
  const random = randomFor(Math.imul(seed, 92837111) ^ 0x57af193d);
  const landmark = LANDMARKS.find(building => building.x === x && building.z === z);
  const roll = random();
  const low = roll < .3;
  const mid = roll < .7;
  const height = landmark?.height ?? (low ? 14 + random() * 16 : mid ? 34 + random() * 44 : roll < .94 ? 90 + random() * 75 : 176 + random() * 52);
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
  c.fillStyle = ['#15212b', '#211e2b', '#25282a', '#1e2334', '#172b2c'][seed];
  c.fillRect(0, 0, 256, 768);
  // Physical-size UVs repeat this 12-bay / 40-floor tile without stretching skyscraper windows.
  for (let row = 0; row < 40; row++) for (let column = 0; column < 12; column++) {
    const x = column * 256 / 12 + 3; const y = row * 768 / 40 + 3;
    const chance = random();
    c.fillStyle = '#090f17'; c.fillRect(x - 1, y - 1, 17, 14);
    if (chance < .38 || (column === seed + 2 && row % 8 > 2)) continue;
    c.fillStyle = chance > .87 ? ink : chance > .73 ? '#cbbb92' : '#73919c';
    c.globalAlpha = chance > .9 ? .92 : .27 + random() * .39;
    c.fillRect(x, y, 14, 10); c.globalAlpha = 1;
    c.fillStyle = 'rgba(3,10,16,.5)'; c.fillRect(x + 7, y, 1, 11);
  }
  // Mechanical floor bands, concrete panel seams and occasional circuit traces are baked.
  for (let row = 0; row < 40; row++) {
    const y = row * 768 / 40;
    c.fillStyle = row % 8 === 0 ? '#091019' : 'rgba(4,10,16,.38)'; c.fillRect(0, y, 256, row % 8 === 0 ? 5 : 1);
    if (row % 8 === 0) { c.fillStyle = ink; c.globalAlpha = .42; c.fillRect(21, y + 1, 85 + seed * 9, 1); c.globalAlpha = 1; }
  }
  for (let column = 0; column < 12; column += 3) {
    c.fillStyle = 'rgba(6,11,18,.7)'; c.fillRect(column * 256 / 12, 0, 3, 768);
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
    const facade = new THREE.MeshBasicMaterial({ map: windows, color: 0xb6c6ca });
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

/** No lights, transparency, or per-frame updates: every component joins the existing city batches. */
export function addSkylineBuilding(scene: THREE.Scene, styles: FacadeStyle[], colliders: WorldCollider[], plan: SkylineBuilding, signs: Map<string, THREE.MeshBasicMaterial>) {
  const { x, z, seed, width: w, depth: d, height: h, shape, quarterTurn } = plan;
  const style = styles[plan.styleIndex]; const group = new THREE.Group();
  group.name = `Cyberpunk / ${SKYLINE_SHAPES[shape]}`; group.position.set(x, 0, z); group.rotation.y = quarterTurn * Math.PI / 2;
  group.userData.skylineBuilding = plan;
  const podiumW = Math.min(24.2, w + 1.1); const podiumD = Math.min(24.2, d + 1.1);
  section(group, SHELL, .22, 4.1, podiumW, podiumD, w, d);
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
  let roofX = 0; let roofZ = 0;
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

  const random = randomFor(seed * 877 + 11); const mastHeight = plan.landmark ? 10 + random() * 9 : 2.2 + random() * 5;
  // Keep the district roof locator compatible with its existing radiusBottom=.52 convention.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.1, .52, mastHeight, 5), ROOF);
  mast.position.set(roofX, h + mastHeight / 2, roofZ); group.add(mast);
  const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(.22), style.secondary); beacon.position.set(roofX, h + mastHeight, roofZ); group.add(beacon);
  if (plan.landmark || seed % 4 === 0) {
    const text = ['NEXUS', 'KAIRO', 'NEURAL+', 'VANTA', 'ORBIT'][plan.styleIndex];
    let material = signs.get(text);
    if (!material) { material = new THREE.MeshBasicMaterial({ map: signTexture(text, style.accent), toneMapped: false }); material.userData.noCastShadow = true; signs.set(text, material); }
    const signWidth = Math.min(w * .72, 13); const sign = new THREE.Mesh(new THREE.PlaneGeometry(signWidth, signWidth * .25), material);
    sign.position.set(0, Math.min(13.2, h * .3), -d / 2 - .09); sign.rotation.y = Math.PI; group.add(sign);
  }
  scene.add(group);
  let triangles = 0;
  group.traverse(object => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  scene.userData.cyberpunkSkylineTriangles = (scene.userData.cyberpunkSkylineTriangles ?? 0) + triangles;
  const rotated = quarterTurn % 2 !== 0;
  colliders.push({ x, z, hx: (rotated ? podiumD : podiumW) / 2 + .04, hz: (rotated ? podiumW : podiumD) / 2 + .04, maxY: h + mastHeight, label: group.name });
}
