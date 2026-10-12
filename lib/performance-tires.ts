import * as THREE from 'three';

const OUTER_RADIUS = .378;
const HALF_WIDTH = .122;
const RING_SEGMENTS = 40;
const RAIN_CHANNELS = [
  { center: -.048, width: .012, depth: .0065 },
  { center: -.0095, width: .014, depth: .007 },
  { center: .0355, width: .012, depth: .0065 },
];

type ProfilePoint = readonly [axial: number, radius: number];
type RubberMaps = { color: THREE.CanvasTexture; relief: THREE.CanvasTexture };

/** Author one set of GPU resources for all four wheels. The wheel axle is local X. */
export function createPerformanceTireAssets() {
  const treadMaps = makeTreadMaps();
  const outsideMaps = makeSidewallMaps(false);
  const insideMaps = makeSidewallMaps(true);
  const treadMaterial = new THREE.MeshStandardMaterial({
    color: 0xc7cbd0,
    map: treadMaps.color,
    bumpMap: treadMaps.relief,
    bumpScale: .0012,
    roughness: .94,
    metalness: 0,
    envMapIntensity: .65,
  });
  treadMaterial.name = 'Tyre / matte road rubber and asymmetric siping';
  const sidewallMaterial = (maps: RubberMaps, name: string) => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xb9bec3,
      map: maps.color,
      bumpMap: maps.relief,
      bumpScale: .00065,
      roughness: .88,
      metalness: 0,
      envMapIntensity: .7,
    });
    material.name = name;
    return material;
  };

  const crownRadius = (x: number) => OUTER_RADIUS - .003 * (x / .09) ** 2;
  const crown: ProfilePoint[] = [[-.105, .362], [-.088, .373], [-.071, crownRadius(-.071)]];
  for (const channel of RAIN_CHANNELS) {
    const lip = channel.width / 2;
    const bottom = lip - .002;
    crown.push(
      [channel.center - lip, crownRadius(channel.center - lip)],
      [channel.center - bottom, crownRadius(channel.center - bottom) - channel.depth],
      [channel.center + bottom, crownRadius(channel.center + bottom) - channel.depth],
      [channel.center + lip, crownRadius(channel.center + lip)],
    );
  }
  crown.push([.071, crownRadius(.071)], [.088, .373], [.105, .362]);

  // The bead seats beneath the .299 m rim lip. The visible lettering starts
  // above that lip, on the actual curved rubber rather than a floating decal.
  const sidewall: ProfilePoint[] = [
    [.108, .296], [.118, .3075], [.122, .330], [.1175, .350], [.105, .362],
  ];

  return {
    treadGeometry: makeRevolvedProfile(crown, false),
    sidewallGeometry: makeRevolvedProfile(sidewall, true),
    treadMaterial,
    outsideMaterial: sidewallMaterial(outsideMaps, 'Tyre / molded outside sidewall'),
    insideMaterial: sidewallMaterial(insideMaps, 'Tyre / molded inside sidewall'),
  };
}

/** Three meshes, independent tread/sidewall UVs, and no per-tread-block draws. */
export function addPerformanceTire(
  wheel: THREE.Group,
  side: number,
  assets: ReturnType<typeof createPerformanceTireAssets>,
) {
  const tread = new THREE.Mesh(assets.treadGeometry, assets.treadMaterial);
  tread.name = 'Tyre / rounded crown with recessed rain channels';
  // The broad outside shoulder follows the outside of either side of the car.
  if (side < 0) tread.rotation.y = Math.PI;
  wheel.add(tread);
  for (const outside of [true, false]) {
    const wall = new THREE.Mesh(assets.sidewallGeometry, outside ? assets.outsideMaterial : assets.insideMaterial);
    wall.name = `Tyre / ${outside ? 'outside' : 'inside'} embossed sidewall`;
    if ((outside ? side : -side) < 0) wall.rotation.y = Math.PI;
    wheel.add(wall);
  }
}

/** Shared indexed surfaces total 2,000 triangles per complete tyre. */
function makeRevolvedProfile(profile: ProfilePoint[], sidewall: boolean) {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const segmentNormals = profile.slice(1).map(([x, r], i) => {
    const [lastX, lastR] = profile[i];
    const normal = new THREE.Vector2(sidewall ? r - lastR : lastR - r, sidewall ? lastX - x : x - lastX);
    return normal.normalize();
  });
  for (let row = 0; row < profile.length; row++) {
    const [x, radius] = profile[row];
    const normal = (segmentNormals[Math.max(0, row - 1)]).clone();
    if (row > 0 && row < profile.length - 1) normal.add(segmentNormals[row]).normalize();
    for (let segment = 0; segment <= RING_SEGMENTS; segment++) {
      const angle = segment / RING_SEGMENTS * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      positions.push(x, radius * c, radius * s);
      normals.push(normal.x, normal.y * c, normal.y * s);
      // Viewed from +X, screen-right is -Z; preserve readable molded lettering
      // on this face and on the opposite face after its half-turn around Y.
      if (sidewall) uvs.push(.5 - radius * s / (2 * OUTER_RADIUS), .5 + radius * c / (2 * OUTER_RADIUS));
      else uvs.push(segment / RING_SEGMENTS, (x + HALF_WIDTH) / (2 * HALF_WIDTH));
      if (row < profile.length - 1 && segment < RING_SEGMENTS) {
        const a = row * (RING_SEGMENTS + 1) + segment;
        const b = a + RING_SEGMENTS + 1;
        if (sidewall) indices.push(a, b, a + 1, b, b + 1, a + 1);
        else indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function rubberCanvases(width: number, height: number, seed: number) {
  const color = document.createElement('canvas'), relief = document.createElement('canvas');
  color.width = relief.width = width;
  color.height = relief.height = height;
  const paint = color.getContext('2d')!, heightMap = relief.getContext('2d')!;
  const pixels = paint.createImageData(width, height), bump = heightMap.createImageData(width, height);
  let state = seed;
  for (let i = 0; i < pixels.data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const noise = ((state >>> 24) / 255 - .5);
    pixels.data[i] = 55 + noise * 5;
    pixels.data[i + 1] = 58 + noise * 5;
    pixels.data[i + 2] = 61 + noise * 5;
    pixels.data[i + 3] = 255;
    bump.data[i] = bump.data[i + 1] = bump.data[i + 2] = 128 + noise * 16;
    bump.data[i + 3] = 255;
  }
  paint.putImageData(pixels, 0, 0);
  heightMap.putImageData(bump, 0, 0);
  return { color, relief, paint, heightMap };
}

function texturePair(canvases: ReturnType<typeof rubberCanvases>, repeat: boolean): RubberMaps {
  const color = new THREE.CanvasTexture(canvases.color);
  color.colorSpace = THREE.SRGBColorSpace;
  const relief = new THREE.CanvasTexture(canvases.relief);
  for (const texture of [color, relief]) {
    texture.anisotropy = 4;
    texture.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return { color, relief };
}

function makeTreadMaps(): RubberMaps {
  const maps = rubberCanvases(1024, 256, 7231);
  const y = (axial: number) => (.5 - axial / (2 * HALF_WIDTH)) * 256;
  // These bands line up with the physical groove floors; the fine lateral
  // siping is relief detail, so long channels retain depth at every distance.
  for (const channel of RAIN_CHANNELS) {
    const top = y(channel.center + channel.width / 2);
    const width = channel.width / (2 * HALF_WIDTH) * 256;
    maps.paint.fillStyle = '#171a1c'; maps.paint.fillRect(0, top, 1024, width);
    maps.heightMap.fillStyle = '#333333'; maps.heightMap.fillRect(0, top, 1024, width);
  }
  const slot = (points: number[][], width = 2.1) => {
    for (const [context, color] of [[maps.paint, '#202326'], [maps.heightMap, '#454545']] as const) {
      context.beginPath(); context.moveTo(points[0][0], points[0][1]);
      for (const point of points.slice(1)) context.lineTo(point[0], point[1]);
      context.strokeStyle = color; context.lineWidth = width; context.lineCap = 'round'; context.stroke();
    }
  };
  // Variable-pitch, staggered blocks: wide closed outer shoulder, angled inner
  // drainage cuts, and shorter central sipes instead of an off-road chevron.
  for (let block = -1; block <= 49; block++) {
    const pitch = ((block % 48) + 48) % 48;
    const u = block * 1024 / 48 + Math.sin(pitch * 1.71) * 2.0;
    slot([[u, y(.104)], [u + 3.8, y(.084)], [u + 8.2, y(.046)]], 2.9);
    slot([[u + 11, y(.020)], [u + 7, y(.012)], [u + 8.6, y(.000)]], 1.55);
    slot([[u + 3, y(-.019)], [u + 1, y(-.029)], [u - 2, y(-.041)]], 1.6);
    slot([[u + 9, y(-.056)], [u + 3, y(-.079)], [u - 5, y(-.104)]], 2.65);
    // Shallow shoulder-edge micro-sipes retain intact rubber blocks.
    if (pitch % 2 === 0) {
      slot([[u + 12, y(.101)], [u + 12.7, y(.086)]], .8);
      slot([[u + 18, y(-.102)], [u + 14.5, y(-.087)]], .8);
    }
  }
  return texturePair(maps, true);
}

function makeSidewallMaps(inside: boolean): RubberMaps {
  const maps = rubberCanvases(1024, 1024, inside ? 9463 : 3641);
  const radialPixels = (radius: number) => radius / OUTER_RADIUS * 512;
  const ring = (radius: number, width: number, paint: string, relief: string) => {
    for (const [context, color] of [[maps.paint, paint], [maps.heightMap, relief]] as const) {
      context.beginPath(); context.arc(512, 512, radialPixels(radius), 0, Math.PI * 2);
      context.strokeStyle = color; context.lineWidth = width; context.stroke();
    }
  };
  ring(.3095, 2.0, '#44474a', '#aaaaaa');
  ring(.314, .9, '#303336', '#777777');
  ring(.3545, 1.5, '#44474a', '#9a9a9a');
  ring(.358, .8, '#303336', '#777777');
  // Rubber-colored molded characters sit entirely between bead and shoulder.
  const arcText = (text: string, radius: number, center: number, fontSize: number, weight = '600') => {
    const font = `${weight} ${fontSize}px Arial, sans-serif`;
    maps.paint.font = maps.heightMap.font = font;
    const characters = text.split('');
    const widths = characters.map(char => maps.paint.measureText(char).width + 1.9);
    const r = radialPixels(radius);
    let angle = center - widths.reduce((sum, width) => sum + width, 0) / r / 2;
    characters.forEach((char, i) => {
      const a = angle + widths[i] / r / 2;
      for (const [context, color] of [[maps.paint, '#595c60'], [maps.heightMap, '#b8b8b8']] as const) {
        context.save(); context.translate(512 + Math.cos(a) * r, 512 + Math.sin(a) * r);
        context.rotate(a + Math.PI / 2);
        context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'alphabetic';
        context.fillText(char, 0, 0); context.restore();
      }
      angle += widths[i] / r;
    });
  };
  arcText('PERFORMANCE SPORT', .331, -Math.PI / 2, 26, '700');
  arcText('245 / 35 ZR 23  ·  (96Y) XL', .331, Math.PI / 2, 20);
  arcText(inside ? 'INSIDE' : 'OUTSIDE', .335, 0, 17);
  arcText('RADIAL · TUBELESS', .334, Math.PI, 16);
  arcText('MAX LOAD 710 KG · 340 KPA', .317, -.76, 10, '500');
  arcText('DOT  ·  E4  ·  0826', .317, 2.33, 10, '500');
  // Fine mold seams and ticks break up the smooth sidewall without chalk-white
  // branding or raised geometry that can intersect the forged rim.
  for (let i = 0; i < 96; i++) {
    const angle = i / 96 * Math.PI * 2;
    for (const [context, color] of [[maps.paint, '#424548'], [maps.heightMap, '#969696']] as const) {
      context.beginPath();
      context.moveTo(512 + Math.cos(angle) * radialPixels(.352), 512 + Math.sin(angle) * radialPixels(.352));
      context.lineTo(512 + Math.cos(angle) * radialPixels(.3535), 512 + Math.sin(angle) * radialPixels(.3535));
      context.strokeStyle = color; context.lineWidth = .8; context.stroke();
    }
  }
  return texturePair(maps, false);
}
