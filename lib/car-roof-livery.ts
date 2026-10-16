import * as THREE from 'three';

type FlameKnot = [x: number, y: number, halfWidth: number];
type Flame = { knots: FlameKnot[]; core: boolean };

const WIDTH = 1024;
const HEIGHT = 2048;

// Canvas bounds are x = -.92..+.92 and z = -.56..2.24 metres. Broad lower
// tongues cover the roof, split around the engine, then curl toward the fin.
const leftStream: FlameKnot[] = [
  [424, 2023, 0], [403, 1870, 76], [397, 1700, 79],
  [317, 1470, 54], [322, 1215, 27], [326, 996, 27],
  [302, 788, 22], [325, 630, 24], [477, 430, 34], [514, 279, 22], [512, 126, 0],
];
const leftShoulder: FlameKnot[] = [
  [344, 1977, 0], [290, 1820, 39], [323, 1660, 43],
  [273, 1488, 33], [331, 1335, 22], [310, 1198, 0],
];
const leftFork: FlameKnot[] = [
  [315, 1255, 0], [285, 1138, 26], [297, 1040, 27],
  [313, 916, 19], [282, 827, 0],
];
const leftRearFork: FlameKnot[] = [
  [322, 1000, 0], [372, 825, 23], [353, 665, 20],
  [319, 528, 16], [353, 411, 0],
];
const mirrored = (knots: FlameKnot[]): FlameKnot[] =>
  knots.map(([x, y, halfWidth]) => [WIDTH - x, y, halfWidth]);

const flames: Flame[] = [
  { knots: leftFork, core: true },
  { knots: mirrored(leftFork), core: true },
  { knots: leftRearFork, core: true },
  { knots: mirrored(leftRearFork), core: true },
  { knots: leftShoulder, core: true },
  { knots: mirrored(leftShoulder), core: true },
  { knots: leftStream, core: true },
  { knots: mirrored(leftStream), core: true },
  {
    knots: [
      [509, 2028, 0], [471, 1870, 70], [501, 1732, 63],
      [475, 1610, 44], [518, 1491, 27], [485, 1355, 0],
    ],
    core: true,
  },
  {
    knots: [
      [590, 1961, 0], [607, 1828, 39], [570, 1723, 35],
      [615, 1587, 23], [585, 1462, 0],
    ],
    core: true,
  },
  {
    knots: [
      [413, 1908, 0], [399, 1768, 26], [427, 1652, 20],
      [410, 1548, 0],
    ],
    core: false,
  },
];

function tonguePath(knots: FlameKnot[], widthScale = 1, core = false) {
  const curve = new THREE.SplineCurve(knots.map(([x, y]) => new THREE.Vector2(x, y)));
  const left: THREE.Vector2[] = [], right: THREE.Vector2[] = [];
  const samples = 120;
  for (let sample = 0; sample <= samples; sample++) {
    const t = sample / samples;
    const knotPosition = t * (knots.length - 1);
    const a = Math.min(Math.floor(knotPosition), knots.length - 2);
    const between = knotPosition - a;
    const smooth = between * between * (3 - 2 * between);
    let radius = THREE.MathUtils.lerp(knots[a][2], knots[a + 1][2], smooth);
    if (core) {
      // Orange/red roots surround each narrower highlighted gold lick.
      radius *= THREE.MathUtils.smoothstep(t, .1, .26);
    }
    const point = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const normal = new THREE.Vector2(-tangent.y, tangent.x);
    if (core) point.addScaledVector(normal, -radius * .16);
    left.push(point.clone().addScaledVector(normal, radius * widthScale));
    right.push(point.clone().addScaledVector(normal, -radius * widthScale));
  }
  const path = new Path2D();
  path.moveTo(left[0].x, left[0].y);
  for (const point of left.slice(1)) path.lineTo(point.x, point.y);
  for (const point of right.reverse()) path.lineTo(point.x, point.y);
  path.closePath();
  return path;
}

function flameGradient(context: CanvasRenderingContext2D, knots: FlameKnot[], core = false) {
  const first = knots[0], tip = knots[knots.length - 1];
  const gradient = context.createLinearGradient(first[0], first[1], tip[0], tip[1]);
  if (core) {
    gradient.addColorStop(0, 'rgba(255, 120, 13, .05)');
    gradient.addColorStop(.24, 'rgba(255, 145, 15, .78)');
    gradient.addColorStop(.6, 'rgba(255, 208, 61, .87)');
    gradient.addColorStop(1, 'rgba(255, 244, 181, .91)');
  } else {
    gradient.addColorStop(0, 'rgba(171, 24, 13, .72)');
    gradient.addColorStop(.16, 'rgba(224, 41, 12, .93)');
    gradient.addColorStop(.42, 'rgba(255, 102, 12, .97)');
    gradient.addColorStop(.73, 'rgba(255, 173, 26, .96)');
    gradient.addColorStop(1, 'rgba(255, 225, 111, .91)');
  }
  return gradient;
}

function paintFlames(context: CanvasRenderingContext2D) {
  // Translucent overspray gives the flame edge a soft transition into pearl paint.
  context.save();
  context.globalAlpha = .3;
  context.filter = 'blur(21px)';
  for (const flame of flames) {
    context.fillStyle = '#f25315';
    context.fill(tonguePath(flame.knots, 1.15));
  }
  context.restore();

  for (const flame of flames) {
    context.save();
    context.filter = 'blur(1.4px)';
    context.fillStyle = flameGradient(context, flame.knots);
    context.fill(tonguePath(flame.knots));
    if (flame.core) {
      context.filter = 'blur(2.6px)';
      context.fillStyle = flameGradient(context, flame.knots, true);
      context.fill(tonguePath(flame.knots, .43, true));
    }
    context.restore();
  }

  // Fade the front roots so no straight texture boundary can read as a sticker.
  context.save();
  context.globalCompositeOperation = 'destination-in';
  const fade = context.createLinearGradient(0, 0, 0, HEIGHT);
  fade.addColorStop(0, 'rgba(255,255,255,0)');
  fade.addColorStop(.04, 'rgba(255,255,255,1)');
  fade.addColorStop(.925, 'rgba(255,255,255,1)');
  fade.addColorStop(.975, 'rgba(255,255,255,.58)');
  fade.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = fade;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.restore();
}

/** Alpha is the amount of flame pigment mixed into the existing pearl lacquer. */
export function createFieryRoofLivery(_carbon?: THREE.MeshPhysicalMaterial): {
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
} {
  const canvas = document.createElement('canvas');
  const glowCanvas = document.createElement('canvas');
  canvas.width = glowCanvas.width = WIDTH;
  canvas.height = glowCanvas.height = HEIGHT;
  const paint = canvas.getContext('2d')!;
  const glow = glowCanvas.getContext('2d')!;

  // Keep the color map genuinely transparent; the material mixes it with paint.
  paint.clearRect(0, 0, WIDTH, HEIGHT);
  paintFlames(paint);
  glow.fillStyle = '#000000';
  glow.fillRect(0, 0, WIDTH, HEIGHT);
  glow.drawImage(canvas, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  const emissiveMap = new THREE.CanvasTexture(glowCanvas);
  map.name = 'Pearl paint / transparent airbrushed roof-to-fin flames';
  emissiveMap.name = 'Pearl paint / softly glowing flame pigment';
  for (const texture of [map, emissiveMap]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return { map, emissiveMap };
}
