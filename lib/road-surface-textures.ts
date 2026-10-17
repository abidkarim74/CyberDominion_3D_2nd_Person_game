import * as THREE from 'three';

const SIZE = 1024;

/** Eight metres of dry asphalt, shared by the road's colour, height and roughness. */
export function createRoadSurfaceTextures() {
  let state = 0x6a09e667;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const makeCanvas = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas textures are unavailable.');
    return { canvas, context };
  };
  const colour = makeCanvas(), height = makeCanvas(), surface = makeCanvas();
  const albedoPixels = colour.context.createImageData(SIZE, SIZE);
  const reliefPixels = height.context.createImageData(SIZE, SIZE);
  const roughnessPixels = surface.context.createImageData(SIZE, SIZE);

  // Periodic lattices make the aggregate and broad colour changes wrap in both
  // directions. Small stones occupy a few pixels, rather than long blue streaks.
  const lattice = (cells: number) => {
    const values = Float32Array.from({ length: cells * cells }, random);
    const indices = new Uint16Array(SIZE), weights = new Float32Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      const coordinate = i * cells / SIZE;
      indices[i] = Math.floor(coordinate);
      const fraction = coordinate - indices[i];
      weights[i] = fraction * fraction * (3 - 2 * fraction);
    }
    return (x: number, y: number) => {
      const left = indices[x], right = (left + 1) % cells;
      const top = indices[y] * cells, bottom = ((indices[y] + 1) % cells) * cells;
      const upper = values[top + left] + (values[top + right] - values[top + left]) * weights[x];
      const lower = values[bottom + left] + (values[bottom + right] - values[bottom + left]) * weights[x];
      return upper + (lower - upper) * weights[y];
    };
  };
  const fine = lattice(512), stone = lattice(256), coarse = lattice(128);
  const mottling = lattice(32), weathering = lattice(8);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const at = (y * SIZE + x) * 4;
    const mineral = stone(x, y) - .5;
    const grain = (fine(x, y) - .5) * 18 + mineral * 25 + (coarse(x, y) - .5) * 10;
    const wear = (mottling(x, y) - .5) * 8 + (weathering(x, y) - .5) * 12;
    const dust = (random() - .5) * 5;
    const value = 88 + grain + wear + dust;
    albedoPixels.data[at] = value;
    albedoPixels.data[at + 1] = value + 1;
    albedoPixels.data[at + 2] = value + 2;
    const relief = 127 + grain * 1.6 + dust;
    const roughness = 244 - mineral * 8 + (mottling(x, y) - .5) * 6;
    for (let channel = 0; channel < 3; channel++) {
      reliefPixels.data[at + channel] = relief;
      roughnessPixels.data[at + channel] = roughness;
    }
    albedoPixels.data[at + 3] = reliefPixels.data[at + 3] = roughnessPixels.data[at + 3] = 255;
  }
  colour.context.putImageData(albedoPixels, 0, 0);
  height.context.putImageData(reliefPixels, 0, 0);
  surface.context.putImageData(roughnessPixels, 0, 0);

  type Point = { x: number; y: number };
  const contexts = [colour.context, height.context, surface.context];
  // Draw translated copies so patches and fissures crossing an edge continue
  // on the neighbouring tile without a frame or a regular road-sized grid.
  const wrappedPath = (points: Point[], close: boolean, draw: (context: CanvasRenderingContext2D, layer: number) => void) => {
    for (let layer = 0; layer < contexts.length; layer++) {
      const context = contexts[layer];
      for (const dx of [-SIZE, 0, SIZE]) for (const dy of [-SIZE, 0, SIZE]) {
        context.beginPath();
        context.moveTo(points[0].x + dx, points[0].y + dy);
        for (let i = 1; i < points.length; i++) context.lineTo(points[i].x + dx, points[i].y + dy);
        if (close) context.closePath();
        draw(context, layer);
      }
    }
  };

  // Low contrast, crooked resurfacing edges. Translucent fills retain the same
  // visible aggregate in the older road and in the repaired binder.
  for (let patch = 0; patch < 3; patch++) {
    const cx = random() * SIZE, cy = random() * SIZE;
    const rx = 24 + random() * 65, ry = 18 + random() * 48;
    const points: Point[] = [];
    const corners = 10 + Math.floor(random() * 5);
    for (let corner = 0; corner < corners; corner++) {
      const angle = corner / corners * Math.PI * 2;
      const irregularity = .68 + random() * .45;
      points.push({ x: cx + Math.cos(angle) * rx * irregularity, y: cy + Math.sin(angle) * ry * irregularity });
    }
    wrappedPath(points, true, (context, layer) => {
      context.fillStyle = ['rgba(43,43,42,.18)', 'rgba(105,105,105,.13)', 'rgba(210,210,210,.26)'][layer];
      context.fill();
      context.lineWidth = 1.1;
      context.strokeStyle = ['rgba(40,39,38,.24)', 'rgba(85,85,85,.23)', 'rgba(188,188,188,.30)'][layer];
      context.stroke();
    });
  }

  const crack = (start: Point, angle: number, steps: number, width: number, branch: boolean) => {
    const points: Point[] = [start];
    let x = start.x, y = start.y;
    for (let step = 0; step < steps; step++) {
      angle += (random() - .5) * .9;
      const length = 3 + random() * 7;
      x += Math.cos(angle) * length; y += Math.sin(angle) * length;
      points.push({ x, y });
    }
    wrappedPath(points, false, (context, layer) => {
      context.lineCap = 'round'; context.lineJoin = 'round';
      context.lineWidth = width;
      context.strokeStyle = ['rgba(30,29,28,.42)', 'rgba(63,63,63,.50)', 'rgba(202,202,202,.35)'][layer];
      context.stroke();
    });
    if (branch) {
      const origin = points[Math.floor(points.length * (.35 + random() * .35))];
      crack(origin, angle + (random() > .5 ? 1 : -1) * (.7 + random() * .6), Math.max(3, Math.floor(steps * .35)), width * .65, false);
    }
  };
  for (let i = 0; i < 9; i++) {
    crack({ x: random() * SIZE, y: random() * SIZE }, random() * Math.PI * 2,
      7 + Math.floor(random() * 17), .65 + random() * .55, i % 2 === 0);
  }

  const texture = (canvas: HTMLCanvasElement, name: string, colourData = false) => {
    const result = new THREE.CanvasTexture(canvas);
    result.name = name;
    result.wrapS = result.wrapT = THREE.RepeatWrapping;
    result.colorSpace = colourData ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    result.anisotropy = 8;
    return result;
  };
  return {
    albedo: texture(colour.canvas, 'Road / neutral asphalt aggregate, repairs and cracks / 8 m', true),
    relief: texture(height.canvas, 'Road / asphalt aggregate and fissure relief / 8 m'),
    roughness: texture(surface.canvas, 'Road / matte asphalt and worn binder roughness / 8 m'),
  };
}
