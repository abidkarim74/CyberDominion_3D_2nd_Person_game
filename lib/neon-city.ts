import * as THREE from 'three';
import { CityAudio } from './city-audio';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { makeSpeedPass, addSteam } from './driving-atmosphere';
import { addInfrastructure, type CoveredRoad } from './city-infrastructure';
import { makeCar } from './cinematic-car';
import { addCityDetail, batchArchitecture, cityEnvironment, poolStreetLights, wetStreetReflection } from './cinematic-city';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type DriveTelemetry = {
  speed: number;
  boost: number;
  drifting: boolean;
  boosting: boolean;
};

type BuildingCollider = { x: number; z: number; hx: number; hz: number };
type Particle = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; color: THREE.Color };
type FacadeStyle = { windows: THREE.CanvasTexture; trim: number; accent: number };

const CITY_SPAN = 396;
const ROAD_WIDTH = 18;
const ROAD_STEP = 44;
const ROAD_COORDS = Array.from({ length: 9 }, (_, i) => (i - 4) * ROAD_STEP);
const CITY_EDGE = 193;
const PALETTE = [
  { color: '#74f6ff', trim: 0x4be6f3, accent: 0xff42b8 },
  { color: '#ff8bcb', trim: 0xf754b6, accent: 0x46edff },
  { color: '#ffc76f', trim: 0xe6b35e, accent: 0x52ecff },
  { color: '#a68cff', trim: 0x9678ff, accent: 0xff4f9c },
  { color: '#83f7c4', trim: 0x54dfb7, accent: 0xff69bd },
];

function rng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeFacadeTexture(seed: number, windowColor: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 768;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  const random = rng(seed * 137 + 81);
  const shade = context.createLinearGradient(0, 0, 256, 0);
  shade.addColorStop(0, '#0b1224');
  shade.addColorStop(0.48, '#111a30');
  shade.addColorStop(1, '#080e1d');
  context.fillStyle = shade;
  context.fillRect(0, 0, 256, 768);
  context.fillStyle = 'rgba(118,190,237,.12)';
  context.fillRect(0, 0, 5, 768);
  context.fillRect(250, 0, 6, 768);

  const columns = 12;
  const rows = 40;
  const cellW = 256 / columns;
  const cellH = 768 / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const chance = random();
      if (chance < 0.37) continue;
      const x = column * cellW + 3;
      const y = row * cellH + 3;
      const width = cellW - 7;
      const height = cellH - 7;
      const glow = chance > 0.91 ? 0.95 : 0.26 + random() * 0.42;
      context.fillStyle = `rgba(3,10,22,${0.76 - glow * 0.18})`;
      context.fillRect(x - 1, y - 1, width + 2, height + 2);
      context.fillStyle = chance > .9 ? windowColor : chance > .74 ? '#ddb886' : '#7398b5';
      context.globalAlpha = glow;
      context.fillRect(x, y, width, height);
      context.globalAlpha = 1;
      if (chance > 0.93) {
        context.fillStyle = 'rgba(255,245,221,.82)';
        context.fillRect(x + 2, y + 2, 2, height - 4);
      }
    }
  }
  context.fillStyle = 'rgba(118,214,255,.2)';
  for (let y = 0; y < 768; y += 96) context.fillRect(0, y, 256, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function octagon(width: number, depth: number, y: number) {
  const cut = Math.min(width, depth) * 0.1;
  return [
    [-width / 2 + cut, y, -depth / 2],
    [width / 2 - cut, y, -depth / 2],
    [width / 2, y, -depth / 2 + cut],
    [width / 2, y, depth / 2 - cut],
    [width / 2 - cut, y, depth / 2],
    [-width / 2 + cut, y, depth / 2],
    [-width / 2, y, depth / 2 - cut],
    [-width / 2, y, -depth / 2 + cut],
  ];
}

function addTowerSection(
  parent: THREE.Group,
  x: number,
  z: number,
  y0: number,
  y1: number,
  w0: number,
  d0: number,
  w1: number,
  d1: number,
  material: THREE.Material,
) {
  const bottom = octagon(w0, d0, 0);
  const top = octagon(w1, d1, y1 - y0);
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let face = 0; face < 8; face += 1) {
    const next = (face + 1) % 8;
    const vertices = [bottom[face], bottom[next], top[next], bottom[face], top[next], top[face]];
    for (const vertex of vertices) {
      positions.push(vertex[0], vertex[1] + y0, vertex[2]);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const section = new THREE.Mesh(geometry, material);
  section.position.set(x, 0, z);
  parent.add(section);

  const roofPositions: number[] = [];
  const roofY = y1 + 0.012;
  for (let i = 0; i < 8; i += 1) {
    const current = top[i];
    const next = top[(i + 1) % 8];
    roofPositions.push(0, roofY, 0, next[0], roofY, next[2], current[0], roofY, current[2]);
  }
  const roofGeometry = new THREE.BufferGeometry();
  roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
  roofGeometry.computeVertexNormals();
  const roof = new THREE.Mesh(
    roofGeometry,
    new THREE.MeshStandardMaterial({ color: 0x101523, metalness: 0.7, roughness: 0.38 }),
  );
  roof.position.set(x, 0, z);
  parent.add(roof);
}

function addQuad(
  positions: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
) {
  positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
}

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,.82)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,.24)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRoadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  const random = rng(78);
  context.fillStyle = '#666a70';
  context.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i += 1) {
    const alpha = random() * 0.3;
    context.fillStyle = random() > 0.46
      ? `rgba(126,163,183,${alpha})`
      : `rgba(1,5,12,${alpha + 0.03})`;
    const size = 1 + random() * 4;
    context.fillRect(random() * 512, random() * 512, size * 2.4, size * 0.35);
  }
  for (let i = 0; i < 45; i += 1) {
    const y = random() * 512;
    context.fillStyle = `rgba(88,161,190,${random() * 0.07})`;
    context.fillRect(0, y, 512, random() * 3 + 0.6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeSign(text: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  context.clearRect(0, 0, 512, 128);
  context.shadowColor = color;
  context.shadowBlur = 24;
  context.strokeStyle = color;
  context.lineWidth = 4;
  context.strokeRect(11, 11, 490, 106);
  context.font = '700 58px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, 256, 65);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeTowerMaterial(texture: THREE.CanvasTexture, _color: number) {
  // Windows are self-lit; baked facade shading avoids evaluating every street light per window.
  const material = new THREE.MeshBasicMaterial({ color: 0x93a9bf, map: texture, side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 facadeNormal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nfacadeNormal = normal;');
    shader.fragmentShader = 'varying vec3 facadeNormal;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= .65 + .35 * abs(dot(normalize(facadeNormal), normalize(vec3(.4,.2,.7))));');
  };
  return material;
}

function makeBuildingSign(text: string, color: string, x: number, y: number, z: number, width: number) {
  const texture = makeSign(text, color);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * 0.25),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, side: THREE.DoubleSide }),
  );
  sign.position.set(x, y, z);
  sign.rotation.y = Math.PI;
  return sign;
}

function addBuilding(
  scene: THREE.Scene,
  styles: FacadeStyle[],
  colliders: BuildingCollider[],
  x: number,
  z: number,
  seed: number,
  trimMeshes: THREE.InstancedMesh[],
) {
  const random = rng(seed * 899 + 7);
  const style = styles[seed % styles.length];
  const width = 17.8 + random() * 3.8;
  const depth = 17.8 + random() * 3.8;
  const height = 40 + random() * 87 + (seed % 7 === 0 ? 35 : 0);
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const facade = makeTowerMaterial(style.windows, style.trim);
  const podium = new THREE.MeshStandardMaterial({ color: 0x343c42, metalness: .16, roughness: .78 });
  const crown = new THREE.MeshBasicMaterial({ color: new THREE.Color(style.trim).multiplyScalar(1.6), toneMapped: false });
  const upperWidth = width * .75;
  const upperDepth = depth * .75;
  addTowerSection(group, 0, 0, .22, 4, width + 1.1, depth + 1.1, width, depth, podium);
  const variant = seed % 5;
  if (variant === 0) {
    // Two slender connected towers with an open slot through their upper half.
    addTowerSection(group, 0, 0, 4, height * .3, width, depth, width, depth, facade);
    for (const side of [-1, 1]) {
      addTowerSection(group, side * width * .29, 0, height * .3, height, width * .39, depth * .81, width * .32, depth * .65, facade);
    }
    addTowerSection(group, 0, 0, height * .73, height * .78, width * .91, depth * .55, width * .91, depth * .55, podium);
  } else if (variant === 1) {
    // Cascading setbacks with service terraces.
    for (let tier = 0; tier < 4; tier++) {
      const scale = 1 - tier * .13;
      const top = 4 + (height - 4) * (tier + 1) / 4;
      addTowerSection(group, tier * .7, 0, 4 + (height - 4) * tier / 4, top, width * scale, depth * scale, width * scale, depth * scale, facade);
      addTowerSection(group, tier * .7, 0, top, top + .22, width * scale + .2, depth * scale + .2, width * scale + .2, depth * scale + .2, crown);
    }
  } else if (variant === 2) {
    // Faceted barrel-shaped headquarters with structural collars.
    for (let tier = 0; tier < 5; tier++) {
      const lower = .73 + Math.sin(tier / 5 * Math.PI) * .27;
      const upper = .73 + Math.sin((tier + 1) / 5 * Math.PI) * .27;
      const top = 4 + (height - 4) * (tier + 1) / 5;
      addTowerSection(group, 0, 0, 4 + (height - 4) * tier / 5, top, width * lower, depth * lower, width * upper, depth * upper, facade);
      addTowerSection(group, 0, 0, top, top + .45, width * upper + .3, depth * upper + .3, width * upper + .3, depth * upper + .3, podium);
    }
  } else {
    const waist = height * .68;
    addTowerSection(group, 0, 0, 4, waist, width, depth, width * .94, depth * .94, facade);
    addTowerSection(group, variant === 3 ? -2 : 0, 0, waist, height, width * .74, depth * .8, variant === 3 ? width * .35 : width * .74, depth * .67, facade);
    // External fins articulate the broad facades and cast material contrast into the windows.
    for (const side of [-1, 1]) for (let fin = -2; fin <= 2; fin++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(.22, waist - 4, .45), podium);
      rib.position.set(fin * width * .16, (waist + 4) / 2, side * depth * .49); group.add(rib);
    }
    addTowerSection(group, variant === 3 ? -2 : 0, 0, height, height + .35, upperWidth, upperDepth, upperWidth, upperDepth, crown);
  }

  const trimIndex = seed % trimMeshes.length;
  const trims = trimMeshes[trimIndex];
  const verticalCount = trims.count;
  if (verticalCount + 4 <= trims.instanceMatrix.count) {
    const matrix = new THREE.Matrix4();
    const positions: [number, number, number][] = [
      [-upperWidth * 0.49, 3.1, -upperDepth * 0.49],
      [upperWidth * 0.49, 3.1, -upperDepth * 0.49],
      [-upperWidth * 0.49, 3.1, upperDepth * 0.49],
      [upperWidth * 0.49, 3.1, upperDepth * 0.49],
    ];
    positions.forEach(([tx, ty, tz], index) => {
      matrix.makeScale(0.075, 5.6, 0.075);
      matrix.setPosition(x + tx, ty, z + tz);
      trims.setMatrixAt(verticalCount + index, matrix);
    });
    trims.count = verticalCount + positions.length;
  }

  const mastHeight = 5 + random() * 13;
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.52, mastHeight, 6),
    new THREE.MeshStandardMaterial({
      color: 0x1b293d,
      metalness: 0.8,
      roughness: 0.3,
      emissive: style.trim,
      emissiveIntensity: 0.3,
    }),
  );
  mast.position.set((random() - 0.5) * 3, height + mastHeight * 0.5, (random() - 0.5) * 3);
  group.add(mast);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 10, 8),
    new THREE.MeshBasicMaterial({ color: style.trim, toneMapped: false }),
  );
  beacon.position.set(mast.position.x, height + mastHeight, mast.position.z);
  group.add(beacon);

  if (seed % 3 === 0) {
    const signText = ['NOVA', 'AURORA', 'KAI', 'LUX', 'NEXUS'][seed % 5];
    const signColor = `#${(seed % 2 === 0 ? style.accent : style.trim).toString(16).slice(-6)}`;
    group.add(makeBuildingSign(signText, signColor, 0, 8.4, -depth / 2 - 0.05, Math.min(width * 0.76, 14)));
  }
  scene.add(group);
  colliders.push({ x, z, hx: width * 0.51 + 0.4, hz: depth * 0.51 + 0.4 });
}

function addTunnel(scene: THREE.Scene, colliders: BuildingCollider[]) {
  const structure = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x101625, metalness: 0.74, roughness: 0.38 });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(19.4, 1.7, 26), concrete);
  roof.position.set(0, 10.2, 66);
  structure.add(roof);
  const innerRoof = new THREE.Mesh(
    new THREE.BoxGeometry(18.2, 0.18, 25),
    new THREE.MeshStandardMaterial({ color: 0x080e1b, metalness: 0.72, roughness: 0.32, emissive: 0x102c3b }),
  );
  innerRoof.position.set(0, 9.28, 66);
  structure.add(innerRoof);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9.6, 26), concrete);
    wall.position.set(side * 9.35, 4.8, 66);
    structure.add(wall);
    const guide = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 25),
      new THREE.MeshBasicMaterial({ color: side < 0 ? 0x20dbea : 0xf5409d, toneMapped: false }),
    );
    guide.position.set(side * 8.83, 8.8, 66);
    structure.add(guide);
  }
  for (let i = 0; i < 9; i += 1) {
    const z = 54 + i * 3;
    const rib = new THREE.Mesh(
      new THREE.TorusGeometry(8.9, 0.16, 6, 24, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x25394c, metalness: 0.9, roughness: 0.24 }),
    );
    rib.rotation.x = 0;
    rib.position.set(0, 0.5, z);
    structure.add(rib);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.08, 0.15),
      new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0xff4b9d : 0x41e6fa, toneMapped: false }),
    );
    lamp.position.set(0, 9.1, z);
    structure.add(lamp);
  }
  for (const z of [53, 79]) {
    const portal = new THREE.Mesh(
      new THREE.BoxGeometry(18.6, 0.28, 0.25),
      new THREE.MeshBasicMaterial({ color: 0x45eaff, toneMapped: false }),
    );
    portal.position.set(0, 9.24, z);
    structure.add(portal);
  }
  const tealLamp = new THREE.PointLight(0x41dfff, 28, 19, 2);
  tealLamp.position.set(0, 6.5, 57);
  structure.add(tealLamp);
  const pinkLamp = new THREE.PointLight(0xf437a7, 26, 19, 2);
  pinkLamp.position.set(0, 6.5, 75);
  structure.add(pinkLamp);
  scene.add(structure);
  colliders.push(
    { x: -9.4, z: 66, hx: 0.7, hz: 13 },
    { x: 9.4, z: 66, hx: 0.7, hz: 13 },
  );
}

function addSkyBridge(scene: THREE.Scene, z: number, color: number) {
  const bridge = new THREE.Group();
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(42, 1.1, 5.6),
    new THREE.MeshStandardMaterial({ color: 0x151b2b, metalness: 0.84, roughness: 0.3 }),
  );
  deck.position.set(0, 17.4, z);
  bridge.add(deck);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(41, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    rail.position.set(0, 18.12, z + side * 2.45);
    bridge.add(rail);
    for (const x of [-19, 19]) {
      const support = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 17, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x202a3c, metalness: 0.83, roughness: 0.3 }),
      );
      support.position.set(x, 8.5, z + side * 2.45);
      bridge.add(support);
    }
  }
  for (let i = 0; i < 18; i += 1) {
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.08, 0.13),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    light.position.set(-20 + i * 2.35, 16.78, z);
    bridge.add(light);
  }
  const glow = new THREE.PointLight(color, 23, 32, 2);
  glow.position.set(0, 14.8, z);
  bridge.add(glow);
  scene.add(bridge);
}

function addStreetlights(scene: THREE.Scene) {
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x18263a, metalness: 0.88, roughness: 0.31 });
  for (const [x, z, color] of [
    [-10, -10, 0x46e9ff], [10, -10, 0xff45ac], [-10, 10, 0xff45ac], [10, 10, 0x46e9ff],
    [-54, 0, 0x46e9ff], [54, 0, 0xff45ac], [0, -98, 0x46e9ff], [0, 98, 0xff45ac],
    [-98, 0, 0xff45ac], [98, 0, 0x46e9ff], [-54, 44, 0xff45ac], [54, 44, 0x46e9ff],
  ] as const) {
    const lightGroup = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 7.5, 8), poleMaterial);
    pole.position.y = 3.75;
    lightGroup.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMaterial);
    arm.position.set(-1, 7.25, 0);
    lightGroup.add(arm);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.13, 0.52),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    lamp.position.set(-2.05, 7.12, 0);
    lightGroup.add(lamp);
    const glow = new THREE.PointLight(color === 0x46e9ff ? 0xa4cfdb : 0xc59aac, 48, 24, 2);
    glow.position.set(-2, 6.9, 0);
    lightGroup.add(glow);
    lightGroup.position.set(x, 0, z);
    scene.add(lightGroup);
  }
}

function addFlyingVehicles(scene: THREE.Scene) {
  const random = rng(4021);
  return Array.from({ length: 7 }, (_, index) => {
    const hue = index % 2 === 0 ? 0x39e9ff : 0xff4baf;
    const vehicle = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(1.1 + random() * 0.45, 0.24, 2.4 + random() * 1.2),
      new THREE.MeshStandardMaterial({
        color: 0x172338,
        metalness: 0.82,
        roughness: 0.24,
        emissive: hue,
        emissiveIntensity: 0.42,
      }),
    );
    vehicle.add(hull);
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(0.64, 0.25, 0.75),
      new THREE.MeshBasicMaterial({ color: hue, toneMapped: false }),
    );
    canopy.position.y = 0.2;
    vehicle.add(canopy);
    for (const side of [-1, 1]) {
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 8),
        new THREE.MeshBasicMaterial({ color: hue, toneMapped: false }),
      );
      light.position.set(side * 0.56, 0, 0.6);
      vehicle.add(light);
    }
    scene.add(vehicle);
    const phase = random() * Math.PI * 2;
    const radius = 96 + random() * 82;
    const height = 36 + random() * 52;
    const speed = 0.022 + random() * 0.025;
    return { vehicle, phase, radius, height, speed, index };
  });
}

export class NeonCityGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(66, 1, 0.1, 560);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly speedPass = makeSpeedPass();
  private readonly steam: ReturnType<typeof addSteam>;
  private readonly environment: THREE.WebGLRenderTarget;
  private readonly reflections: ReturnType<typeof wetStreetReflection>;
  private cityDetails!: ReturnType<typeof addCityDetail>;
  private updateStreetLights!: ReturnType<typeof poolStreetLights>;
  private readonly blurHandler = () => this.pressed.clear();
  private driftTimer = 0;
  private averageFrame = 16;
  private qualityTimer = 0;
  private readonly carRig: ReturnType<typeof makeCar>;
  private readonly car: THREE.Group;
  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly carPosition = new THREE.Vector3(0, 0.015, 0);
  private readonly previousPosition = new THREE.Vector3();
  private readonly colliders: BuildingCollider[] = [];
  private readonly coveredRoads: CoveredRoad[] = [{ x: 0, z: 66, hx: 9.5, hz: 13, ceiling: 11, label: 'CENTRAL TUNNEL' }];
  private keyLight!: THREE.DirectionalLight;
  private shadowFrame = 0;
  private readonly pressed = new Set<string>();
  private readonly audio = new CityAudio();
  private readonly rainGeometry: THREE.BufferGeometry;
  private readonly rainPositions: Float32Array;
  private readonly rainOffsets: { x: number; z: number; y: number; length: number; speed: number }[] = [];
  private readonly particleGeometry = new THREE.BufferGeometry();
  private readonly particlePositions = new Float32Array(180 * 3);
  private readonly particleColors = new Float32Array(180 * 3);
  private readonly particles: Particle[] = [];
  private readonly flying: ReturnType<typeof addFlyingVehicles>;
  private readonly wheelMeshes: THREE.Group[];
  private readonly brakeLights: THREE.Mesh[];
  private readonly exhaustMeshes: THREE.Mesh[];
  private readonly headlights: THREE.Mesh[];
  private readonly underglow: THREE.Mesh;
  private readonly boostLights: THREE.PointLight[];
  private readonly onTelemetry: (telemetry: DriveTelemetry) => void;
  private readonly resizeHandler = () => this.resize();
  private readonly keyDownHandler = (event: KeyboardEvent) => this.onKeyDown(event);
  private readonly keyUpHandler = (event: KeyboardEvent) => this.onKeyUp(event);
  private readonly rain: THREE.LineSegments;
  private readonly exhaustParticles: THREE.Points;
  private readonly glowMap: THREE.CanvasTexture;
  private active = false;
  private destroyed = false;
  private yaw = 0;
  private steerInput = 0;
  private boostCharge = 100;
  private previousTime = 0;
  private elapsed = 0;
  private telemetryTimer = 0;
  private exhaustTimer = 0;
  private lastTelemetry: DriveTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false };
  private readonly frameHandler = (time: number) => this.frame(time);

  constructor(canvas: HTMLCanvasElement, onTelemetry: (telemetry: DriveTelemetry) => void) {
    this.onTelemetry = onTelemetry;
    this.scene.background = new THREE.Color(0x070914);
    this.scene.fog = new THREE.FogExp2(0x142333, 0.0062);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25, Math.sqrt(1_100_000 / (window.innerWidth * window.innerHeight))));
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.environment = cityEnvironment(this.renderer);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = .65;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), .36, .4, 1.3));
    this.composer.addPass(this.speedPass);
    this.composer.addPass(new OutputPass());
    this.carRig = makeCar();
    this.car = this.carRig.car;
    this.wheelMeshes = this.carRig.wheels;
    this.brakeLights = this.carRig.brakeLights;
    this.exhaustMeshes = this.carRig.exhausts;
    this.headlights = this.carRig.headlights;
    this.underglow = this.carRig.underglow;
    this.boostLights = this.carRig.boostLights;
    this.glowMap = makeGlowTexture();

    this.createWorld();
    this.updateStreetLights = poolStreetLights(this.scene);
    batchArchitecture(this.scene);
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh && !Array.isArray(object.material) && !object.material.transparent) {
        object.receiveShadow = object.material instanceof THREE.MeshStandardMaterial;
        object.castShadow = object.material instanceof THREE.MeshStandardMaterial || !!(object.material as THREE.MeshBasicMaterial).map;
      }
    });
    this.reflections = wetStreetReflection(this.scene);
    this.scene.add(this.car);
    this.steam = addSteam(this.scene);
    this.flying = addFlyingVehicles(this.scene);
    this.rainPositions = new Float32Array(1050 * 6);
    this.rainGeometry = new THREE.BufferGeometry();
    this.rainGeometry.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rain = new THREE.LineSegments(
      this.rainGeometry,
      new THREE.LineBasicMaterial({ color: 0x8ecbff, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.scene.add(this.rain);
    this.createRain();

    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    this.exhaustParticles = new THREE.Points(
      this.particleGeometry,
      new THREE.PointsMaterial({
        color: 0xffffff,
        map: this.glowMap,
        vertexColors: true,
        size: 0.29,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.scene.add(this.exhaustParticles);
    this.camera.position.set(0, 6, 14);
    this.camera.lookAt(0, 1.2, -2.2);
    this.resize();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('keydown', this.keyDownHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    window.addEventListener('blur', this.blurHandler);
    this.animationFrame = requestAnimationFrame(this.frameHandler);
  }

  private animationFrame = 0;

  private createWorld() {
    const hemisphere = new THREE.HemisphereLight(0xabb6c5, 0x1a1c21, .95);
    this.scene.add(hemisphere);
    const ambient = new THREE.AmbientLight(0x657482, .34);
    this.scene.add(ambient);
    const magentaMoon = new THREE.DirectionalLight(0xc9a2b1, .4);
    magentaMoon.position.set(-64, 92, 50);
    this.scene.add(magentaMoon);
    const cyanMoon = new THREE.DirectionalLight(0xc4d0df, 1.65);
    cyanMoon.position.set(72, 74, -88);
    this.keyLight = cyanMoon;
    cyanMoon.castShadow = true;
    cyanMoon.shadow.mapSize.set(1024, 1024);
    Object.assign(cyanMoon.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 110 });
    cyanMoon.shadow.normalBias = .045;
    cyanMoon.shadow.bias = -.00015;
    this.scene.add(cyanMoon, cyanMoon.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(440, 440),
      new THREE.MeshStandardMaterial({ color: 0x10131c, metalness: 0.28, roughness: 0.82 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.19;
    this.scene.add(ground);

    const roadTexture = makeRoadTexture();
    const acrossTexture = roadTexture.clone();
    acrossTexture.repeat.set(CITY_SPAN / 22, ROAD_WIDTH / 22);
    acrossTexture.needsUpdate = true;
    const alongTexture = roadTexture.clone();
    alongTexture.repeat.set(ROAD_WIDTH / 22, CITY_SPAN / 22);
    alongTexture.needsUpdate = true;
    const wetRoadAcross = new THREE.MeshStandardMaterial({
      color: 0x3c4147,
      map: acrossTexture,
      bumpMap: acrossTexture,
      bumpScale: .025,
      metalness: .025,
      roughness: .86,
      envMapIntensity: 0,
    });
    const wetRoadAlong = wetRoadAcross.clone();
    wetRoadAlong.map = alongTexture;
    wetRoadAlong.bumpMap = alongTexture;
    const puddleGeometry = new THREE.CircleGeometry(1, 14);
    const puddleMaterial = new THREE.MeshStandardMaterial({
      color: 0x131a21,
      metalness: .12,
      roughness: .38,
      envMapIntensity: 0,
      transparent: true,
      opacity: .2,
      depthWrite: false,
    });
    const puddles = new THREE.InstancedMesh(puddleGeometry, puddleMaterial, 180);
    const puddleRandom = rng(13514);
    const puddleMatrix = new THREE.Matrix4();
    for (let i = 0; i < 180; i += 1) {
      const line = ROAD_COORDS[Math.floor(puddleRandom() * ROAD_COORDS.length)];
      const across = puddleRandom() > 0.5;
      const along = -CITY_SPAN / 2 + puddleRandom() * CITY_SPAN;
      const radius = 0.35 + puddleRandom() * 1.7;
      puddleMatrix.compose(
        new THREE.Vector3(
          across ? along : line + (puddleRandom() - 0.5) * 12,
          0.022,
          across ? line + (puddleRandom() - 0.5) * 12 : along,
        ),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
        new THREE.Vector3(radius * (0.8 + puddleRandom()), radius * 0.35, 1),
      );
      puddles.setMatrixAt(i, puddleMatrix);
    }
    this.scene.add(puddles);

    const horizontalStreets: THREE.Mesh[] = [];
    for (const road of ROAD_COORDS) {
      const horizontal = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY_SPAN, ROAD_WIDTH),
        wetRoadAcross,
      );
      horizontal.rotation.x = -Math.PI / 2;
      horizontal.position.set(0, 0.008, road);
      horizontalStreets.push(horizontal);
      const vertical = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_WIDTH, CITY_SPAN),
        wetRoadAlong,
      );
      vertical.rotation.x = -Math.PI / 2;
      vertical.position.set(road, 0.009, 0);
      horizontalStreets.push(vertical);
    }
    this.scene.add(...horizontalStreets);

    const lanePositions: number[] = [];
    const glowPositions: number[] = [];
    const coverage = CITY_SPAN / 2;
    for (const street of ROAD_COORDS) {
      for (let along = -coverage; along < coverage; along += 11) {
        if (ROAD_COORDS.some(cross => Math.abs(along + 2.6 - cross) < 11)) continue;
        for (const lane of [-4.4, 4.4]) {
          addQuad(lanePositions, along, street + lane - 0.055, along + 5.2, street + lane + 0.055, 0.034);
          addQuad(lanePositions, street + lane - 0.055, along, street + lane + 0.055, along + 5.2, 0.034);
        }
      }
      for (const side of [-1, 1]) {
        for (let along = -coverage; along < coverage; along += 32) {
          addQuad(glowPositions, along, street + side * 8.76 - 0.04, along + 18, street + side * 8.76 + 0.04, 0.035);
          addQuad(glowPositions, street + side * 8.76 - 0.04, along, street + side * 8.76 + 0.04, along + 18, 0.035);
        }
      }
    }
    const laneGeometry = new THREE.BufferGeometry();
    laneGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lanePositions, 3));
    laneGeometry.computeVertexNormals();
    const lanes = new THREE.Mesh(
      laneGeometry,
      new THREE.MeshBasicMaterial({ color: 0x8e979b, transparent: true, opacity: .7, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.scene.add(lanes);
    const curbGeometry = new THREE.BufferGeometry();
    curbGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
    curbGeometry.computeVertexNormals();
    const curbs = new THREE.Mesh(
      curbGeometry,
      new THREE.MeshBasicMaterial({ color: 0x19a8c9, transparent: true, opacity: 0.24, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.scene.add(curbs);

    const platformGeometry = new THREE.BoxGeometry(26, 0.24, 26);
    const platformMaterial = new THREE.MeshStandardMaterial({ color: 0x171e2b, metalness: 0.48, roughness: 0.7 });
    const platforms = new THREE.InstancedMesh(platformGeometry, platformMaterial, 64);
    platforms.count = 0;
    const platformMatrix = new THREE.Matrix4();
    for (const xRoad of ROAD_COORDS.slice(0, -1)) {
      for (const zRoad of ROAD_COORDS.slice(0, -1)) {
        platformMatrix.setPosition(xRoad + ROAD_STEP / 2, 0.12, zRoad + ROAD_STEP / 2);
        const index = platforms.count;
        platforms.setMatrixAt(index, platformMatrix);
        platforms.count += 1;
      }
    }
    this.scene.add(platforms);

    const styles: FacadeStyle[] = PALETTE.map((palette, index) => ({
      windows: makeFacadeTexture(index + 1, palette.color),
      trim: palette.trim,
      accent: palette.accent,
    }));
    const trimMeshes = styles.map((style) => {
      const trims = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: style.trim, toneMapped: false }),
        80,
      );
      trims.count = 0;
      return trims;
    });
    trimMeshes.forEach((mesh) => this.scene.add(mesh));
    let buildingIndex = 1;
    for (const xRoad of ROAD_COORDS.slice(0, -1)) {
      for (const zRoad of ROAD_COORDS.slice(0, -1)) {
        const x = xRoad + ROAD_STEP / 2;
        const z = zRoad + ROAD_STEP / 2;
        addBuilding(this.scene, styles, this.colliders, x, z, buildingIndex, trimMeshes);
        buildingIndex += 1;
      }
    }
    for (const trim of trimMeshes) trim.instanceMatrix.needsUpdate = true;
    platforms.instanceMatrix.needsUpdate = true;

    const stars = new Float32Array(260 * 3);
    const starRandom = rng(772);
    for (let i = 0; i < 260; i += 1) {
      stars[i * 3] = (starRandom() - 0.5) * 420;
      stars[i * 3 + 1] = 48 + starRandom() * 120;
      stars[i * 3 + 2] = (starRandom() - 0.5) * 420;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    const starsMesh = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xa7d4ff, size: 0.7, transparent: true, opacity: 0.64, sizeAttenuation: true }),
    );
    this.scene.add(starsMesh);
    addTunnel(this.scene, this.colliders);
    addSkyBridge(this.scene, -44, 0x26dcf1);
    addSkyBridge(this.scene, 132, 0xff47a8);
    addStreetlights(this.scene);
    this.cityDetails = addCityDetail(this.scene, styles.map(s => s.windows));
    this.coveredRoads.push(...addInfrastructure(this.scene, this.colliders));
  }

  private createRain() {
    const random = rng(6500);
    for (let i = 0; i < 1050; i += 1) {
      this.rainOffsets.push({
        x: (random() - 0.5) * 90,
        z: (random() - 0.5) * 110,
        y: random() * 48,
        length: 0.45 + random() * 0.95,
        speed: 24 + random() * 18,
      });
    }
    this.updateRain(0);
  }

  private updateRain(delta: number) {
    for (let i = 0; i < this.rainOffsets.length; i += 1) {
      const drop = this.rainOffsets[i];
      drop.y -= drop.speed * delta;
      if (drop.y < -1.5) drop.y = 42 + Math.random() * 12;
      const index = i * 6;
      const x = this.car.position.x + drop.x;
      const z = this.car.position.z + drop.z;
      this.rainPositions[index] = x;
      const sheltered = this.coveredRoads.some(roof => Math.abs(x - roof.x) < roof.hx && Math.abs(z - roof.z) < roof.hz && drop.y < roof.ceiling);
      this.rainPositions[index + 1] = sheltered ? -5 : drop.y + 1.8;
      this.rainPositions[index + 2] = z;
      this.rainPositions[index + 3] = x - 0.06;
      this.rainPositions[index + 4] = sheltered ? -5 : drop.y + 1.8 - drop.length;
      this.rainPositions[index + 5] = z + 0.03;
    }
    this.rainGeometry.attributes.position.needsUpdate = true;
    this.rainGeometry.computeBoundingSphere();
  }

  private onKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (!this.active) return;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();
    this.pressed.add(key);
    if (key === 'r' && !event.repeat) this.reset();
  }

  private onKeyUp(event: KeyboardEvent) {
    this.pressed.delete(event.key.toLowerCase());
  }

  setDriving(active: boolean) {
    this.active = active;
    this.pressed.clear();
    this.previousTime = 0;
    if (active) {
      this.audio.start();
      this.renderer.domElement.focus({ preventScroll: true });
    }
  }

  audioDiagnostics() { return this.audio.diagnostics(); }

  private reset() {
    this.carPosition.set(0, 0.015, 0);
    this.car.position.copy(this.carPosition);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.car.rotation.set(0, 0, 0);
    this.carRig.body.rotation.set(0, 0, 0);
    this.particles.length = 0;
    this.pressed.clear();
    this.steerInput = 0;
    this.boostCharge = 100;
    this.camera.position.set(0, 6, 14);
    this.camera.lookAt(0, 1.1, -3);
    this.exhaustTimer = 0;
    this.lastTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false };
    this.onTelemetry(this.lastTelemetry);
  }

  private resize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
  }

  private updateDriving(delta: number) {
    const key = (...values: string[]) => values.some((value) => this.pressed.has(value));
    const throttle = (key('w', 'arrowup') ? 1 : 0) - (key('s', 'arrowdown') ? 1 : 0);
    const steer = (key('a', 'arrowleft') ? 1 : 0) - (key('d', 'arrowright') ? 1 : 0);
    this.steerInput = steer;
    const drifting = key(' ');
    const forwardInput = throttle > 0;
    const boosting = key('shift') && this.boostCharge > 0 && forwardInput;
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let longitudinal = this.velocity.dot(this.forward);

    if (throttle > 0 && longitudinal < (boosting ? 83 : 66)) {
      this.velocity.addScaledVector(this.forward, (boosting ? 43 : 27) * delta);
    } else if (throttle < 0) {
      const brakePower = longitudinal > 1.5 ? 42 : 20;
      this.velocity.addScaledVector(this.forward, -brakePower * delta);
    }

    const steeringPower = 0.58 + Math.min(Math.abs(longitudinal) / 17, 1.72);
    this.yaw += steer * delta * steeringPower * (longitudinal < -0.5 ? -1 : 1) * (drifting ? 1.22 : 1);
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    longitudinal = this.velocity.dot(this.forward);
    let lateral = this.velocity.dot(this.right);
    lateral *= Math.exp(-delta * (drifting ? 0.72 : 6.8));
    this.velocity.copy(this.forward).multiplyScalar(longitudinal).addScaledVector(this.right, lateral);
    this.velocity.multiplyScalar(Math.exp(-delta * (boosting ? 0.035 : 0.12)));
    longitudinal = this.velocity.dot(this.forward);
    const topSpeed = boosting ? 83 : 66;
    if (longitudinal > topSpeed) this.velocity.addScaledVector(this.forward, topSpeed - longitudinal);
    if (longitudinal < -24) this.velocity.addScaledVector(this.forward, -24 - longitudinal);

    if (boosting) this.boostCharge = Math.max(0, this.boostCharge - delta * 25);
    else this.boostCharge = Math.min(100, this.boostCharge + delta * (drifting ? 4 : 10));
    this.previousPosition.copy(this.carPosition);
    this.carPosition.addScaledVector(this.velocity, delta);
    this.carPosition.y = 0.015;

    let collision = false;
    for (const building of this.colliders) {
      if (Math.abs(this.carPosition.x - building.x) < building.hx + 0.88 &&
          Math.abs(this.carPosition.z - building.z) < building.hz + 2.06) {
        collision = true;
        break;
      }
    }
    if (collision) {
      if (this.velocity.length() > 8) for (let i = 0; i < 12; i++) this.spawnParticle(this.carPosition, 0xffb34b, false);
      this.carPosition.copy(this.previousPosition);
      this.velocity.multiplyScalar(-0.19);
    }
    if (Math.abs(this.carPosition.x) > CITY_EDGE || Math.abs(this.carPosition.z) > CITY_EDGE) {
      this.carPosition.x = THREE.MathUtils.clamp(this.carPosition.x, -CITY_EDGE, CITY_EDGE);
      this.carPosition.z = THREE.MathUtils.clamp(this.carPosition.z, -CITY_EDGE, CITY_EDGE);
      this.velocity.multiplyScalar(-0.28);
    }
    this.car.position.copy(this.carPosition);
    this.car.rotation.y = this.yaw;
    const wheelSpin = this.velocity.length() * delta / 0.355;
    for (const wheel of this.wheelMeshes) wheel.rotation.x -= wheelSpin * (longitudinal < 0 ? -1 : 1);
    for (const pivot of this.carRig.steering) pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, steer * .3, 1 - Math.exp(-delta * 12));
    const suspensionEase = 1 - Math.exp(-delta * 8);
    this.carRig.body.rotation.z = THREE.MathUtils.lerp(this.carRig.body.rotation.z, -steer * Math.min(this.velocity.length() / 40, 1) * .045, suspensionEase);
    this.carRig.body.rotation.x = THREE.MathUtils.lerp(this.carRig.body.rotation.x, throttle * .018, suspensionEase);
    this.carRig.body.position.y = Math.sin(this.elapsed * 13) * Math.min(this.velocity.length() / 60, 1) * .012;
    for (const flame of this.carRig.flames) {
      flame.visible = boosting; flame.scale.y = .9 + Math.sin(this.elapsed * 43) * .18;
    }
    const brakeIntensity = key('s', 'arrowdown') ? 4.5 : 1.6;
    for (const brakeLight of this.brakeLights) {
      (brakeLight.material as THREE.MeshStandardMaterial).emissiveIntensity = brakeIntensity;
    }
    const engineIntensity = boosting ? 2.2 : .3;
    for (const exhaust of this.exhaustMeshes) {
      (exhaust.material as THREE.MeshStandardMaterial).emissiveIntensity = engineIntensity;
    }
    for (const light of this.boostLights) light.intensity = boosting ? 8 : 0;
    this.underglow.scale.set(boosting ? 1.05 : 1, 1, boosting ? 1.2 : 1);
    this.driftTimer -= delta;
    if (drifting && Math.abs(steer) > 0 && this.velocity.length() > 5 && this.driftTimer <= 0) {
      for (let i = 0; i < 3; i++) this.spawnParticle(this.car.position, 0x7ba7b7, false);
      this.driftTimer = .035;
    }
    this.exhaustTimer -= delta;
    if (boosting && this.exhaustTimer <= 0) {
      this.spawnParticle(this.car.position, 0x48efff, true);
      this.exhaustTimer = 0.022;
    }
    const speed = this.velocity.length() * 3.6;
    const telemetry: DriveTelemetry = { speed, boost: this.boostCharge / 100, drifting: drifting && speed > 18, boosting };
    this.lastTelemetry = telemetry;
    this.audio.update({
      speed: this.velocity.length(), engineLoad: throttle > 0 ? 1 : throttle < 0 ? .55 : .2,
      boosting, drifting: telemetry.drifting, steering: steer, reversing: longitudinal < -1,
    });
  }

  private spawnParticle(origin: THREE.Vector3, color: number, exhaust: boolean) {
    const position = origin.clone();
    const localX = exhaust ? (Math.random() - 0.5) * 0.78 : (Math.random() - 0.5) * 1.65;
    const localZ = exhaust ? 2.2 : 1.45 + Math.random() * 0.6;
    const local = new THREE.Vector3(localX, exhaust ? 0.42 : 0.11, localZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    position.add(local);
    const velocity = new THREE.Vector3();
    velocity.x += (Math.random() - 0.5) * (exhaust ? 2.2 : 6);
    velocity.y += exhaust ? 1 + Math.random() * 1.6 : 0.25 + Math.random() * 0.75;
    velocity.z += 0.8 + Math.random() * (exhaust ? 4.8 : 3);
    velocity.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).addScaledVector(this.velocity, .15);
    this.particles.push({ position, velocity, life: exhaust ? 0.5 + Math.random() * 0.24 : 0.32, color: new THREE.Color(color) });
    if (this.particles.length > 180) this.particles.shift();
  }

  private updateParticles(delta: number) {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      particle.life -= delta;
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      particle.velocity.y -= delta * 1.8;
      particle.position.addScaledVector(particle.velocity, delta);
    }
    for (let i = 0; i < 180; i += 1) {
      const particle = this.particles[i];
      const index = i * 3;
      if (particle) {
        this.particlePositions[index] = particle.position.x;
        this.particlePositions[index + 1] = particle.position.y;
        this.particlePositions[index + 2] = particle.position.z;
        const fade = Math.min(particle.life * 3, 1);
        this.particleColors[index] = particle.color.r * fade;
        this.particleColors[index + 1] = particle.color.g * fade;
        this.particleColors[index + 2] = particle.color.b * fade;
      } else {
        this.particlePositions[index] = 0;
        this.particlePositions[index + 1] = -1000;
        this.particlePositions[index + 2] = 0;
      }
    }
    this.particleGeometry.setDrawRange(0, this.particles.length);
    this.particleGeometry.attributes.position.needsUpdate = true;
    this.particleGeometry.attributes.color.needsUpdate = true;
    this.particleGeometry.computeBoundingSphere();
  }

  private frame(time: number) {
    if (this.destroyed) return;
    const frameMs = this.previousTime === 0 ? 16 : time - this.previousTime;
    const delta = this.previousTime === 0 ? 0 : Math.min(frameMs / 1000, 0.04);
    this.previousTime = time;
    this.elapsed += delta;
    if (this.active && delta > 0) this.updateDriving(delta);
    this.updateRain(delta);
    this.updateParticles(delta);
    this.cityDetails.update(this.elapsed);
    this.steam.update(this.elapsed, window.innerHeight * this.renderer.getPixelRatio());
    this.reflections.update(this.elapsed);
    this.updateStreetLights(this.carPosition);
    this.flying.forEach(({ vehicle, phase, radius, height, speed, index }) => {
      const angle = phase + this.elapsed * speed * (index % 2 === 0 ? 1 : -1);
      vehicle.position.set(Math.cos(angle) * radius, height + Math.sin(angle * 1.6) * 2.4, Math.sin(angle) * radius);
      vehicle.rotation.y = -angle + Math.PI / 2;
    });

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const cameraTarget = this.carPosition.clone().addScaledVector(this.forward, 2.2);
    const speedRatio = Math.min(this.velocity.length() / 76, 1);
    const desiredCamera = this.carPosition.clone()
      .addScaledVector(this.forward, -(8.4 + speedRatio * 1.6))
      .addScaledVector(this.right, -this.steerInput * speedRatio * (this.lastTelemetry.drifting ? 0.42 : 0.14))
      .add(new THREE.Vector3(
        0,
        3.1 + speedRatio * 0.45 + Math.sin(this.elapsed * 19) * (this.lastTelemetry.boosting ? 0.08 : 0.018),
        0,
      ));
    const chaseEase = 1 - Math.exp(-delta * 5.3);
    this.camera.position.addScaledVector(this.velocity, delta);
    this.camera.position.lerp(desiredCamera, chaseEase);
    cameraTarget.y += 1.3;
    this.camera.lookAt(cameraTarget);
    const boostFov = this.lastTelemetry.boosting ? 5 : 0;
    const targetFov = 66 + speedRatio * 7 + boostFov;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-delta * 2.2));
    this.camera.updateProjectionMatrix();

    this.speedPass.uniforms.strength.value = speedRatio * (this.lastTelemetry.boosting ? .022 : .005);
    this.keyLight.position.copy(this.carPosition).add(new THREE.Vector3(22, 38, 16));
    this.keyLight.target.position.copy(this.carPosition);
    this.renderer.shadowMap.needsUpdate = this.shadowFrame++ % 3 === 0;
    this.renderer.info.reset();
    this.composer.render();
    // Lower resolution only after sustained slow frames, avoiding expensive automatic oscillation.
    if (delta > 0) this.averageFrame += (frameMs - this.averageFrame) * .025;
    this.qualityTimer += delta;
    if (this.qualityTimer > 3 && this.averageFrame > 24 && this.renderer.getPixelRatio() > Math.min(.75, Math.sqrt(720_000 / (window.innerWidth * window.innerHeight)))) {
      const minimum = Math.min(.75, Math.sqrt(720_000 / (window.innerWidth * window.innerHeight)));
      this.renderer.setPixelRatio(Math.max(minimum, this.renderer.getPixelRatio() * .85));
      this.resize(); this.qualityTimer = 0;
    }
    this.telemetryTimer += delta;
    if (this.active && this.telemetryTimer > 0.085) {
      this.telemetryTimer = 0;
      this.onTelemetry(this.lastTelemetry);
    }
    this.animationFrame = requestAnimationFrame(this.frameHandler);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    window.removeEventListener('blur', this.blurHandler);
    this.audio.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        const drawable = object as THREE.Mesh | THREE.Points | THREE.LineSegments;
        drawable.geometry.dispose();
        const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
          if ('bumpMap' in material && material.bumpMap instanceof THREE.Texture) material.bumpMap.dispose();
          if ('alphaMap' in material && material.alphaMap instanceof THREE.Texture) material.alphaMap.dispose();
          if ('emissiveMap' in material && material.emissiveMap instanceof THREE.Texture) material.emissiveMap.dispose();
          material.dispose();
        }
      }
    });
    this.glowMap.dispose();
    this.environment.dispose();
    this.keyLight.shadow.map?.dispose();
    this.reflections.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
