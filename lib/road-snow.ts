import * as THREE from 'three';
import {
  ROAD_COORDS,
  ROAD_STEP,
  ROAD_WIDTH,
  nearestBlock,
} from './city-layout';
import type { CoveredRoad } from './city-infrastructure';
import {
  BORDER_SNOW_GLSL,
  BORDER_SNOW_START,
  WINTER_GROUND_EDGE,
  borderSnowCoverage,
  borderSnowHeight,
  finishSnowContact,
  groundHeight,
  makeSnowContact,
  smooth01,
  type SnowContact,
} from './snow-surface';
export { SNOW_CLEAR_HALF_WIDTH } from './snow-surface';

const SEGMENTS = 8;
const VISIBLE_BLOCK_RADIUS = 4;
const CELL = 4;
const PROFILE = [
  { radius: ROAD_STEP / 2 - 6.32, height: 0.028, clean: 0.15, coverage: 0 },
  { radius: 15.2, height: 0.053, clean: 0.35, coverage: 0.22 },
  { radius: 14.6, height: 0.12, clean: 0.62, coverage: 0.55 },
  { radius: 13.9, height: 0.23, clean: 0.88, coverage: 0.86 },
  {
    radius: ROAD_STEP / 2 - ROAD_WIDTH / 2,
    height: 0.43,
    clean: 1,
    coverage: 1,
  },
  { radius: 10.8, height: 0.265, clean: 0.96, coverage: 1 },
];
function noise(x: number, z: number) {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Static snow surfaces share one contact sampler with tires and track emission. */
export function addRoadSnow(
  scene: THREE.Scene,
  shelters: readonly CoveredRoad[],
) {
  const positions: number[] = [],
    colors: number[] = [],
    uvs: number[] = [],
    coverage: number[] = [],
    indices: number[] = [];
  const cells = new Map<string, number[]>();
  const blocks: { x: number; z: number; start: number; count: number }[] = [];
  const key = (x: number, z: number) =>
    Math.floor(x / CELL) + ':' + Math.floor(z / CELL);
  for (const xRoad of ROAD_COORDS.slice(0, -1))
    for (const zRoad of ROAD_COORDS.slice(0, -1)) {
      const start = indices.length,
        cx = xRoad + ROAD_STEP / 2,
        cz = zRoad + ROAD_STEP / 2;
      for (let side = 0; side < 4; side++) {
        const first = positions.length / 3;
        for (let segment = 0; segment <= SEGMENTS; segment++) {
          const along = (segment / SEGMENTS) * 2 - 1;
          for (let profile = 0; profile < PROFILE.length; profile++) {
            const p = PROFILE[profile];
            const jitter =
              profile === 0
                ? 0
                : (noise(cx + along * 15, cz + side * 17) - 0.5) *
                  0.58 *
                  (1 - Math.abs(along));
            const radius = p.radius + jitter,
              a = along * radius,
              b = radius;
            const x =
              cx + (side === 0 ? a : side === 1 ? b : side === 2 ? -a : -b);
            const z =
              cz + (side === 0 ? b : side === 1 ? -a : side === 2 ? -b : a);
            const variation = noise(x * 0.29, z * 0.29);
            positions.push(
              x,
              p.height +
                (profile < 2 ? variation * 0.012 : (variation - 0.5) * 0.075),
              z,
            );
            const clean = p.clean * (0.9 + variation * 0.1);
            colors.push(
              0.12 + clean * 0.78,
              0.15 + clean * 0.78,
              0.18 + clean * 0.76,
            );
            coverage.push(p.coverage);
            uvs.push(x * 1.7, z * 1.7);
          }
        }
        for (let segment = 0; segment < SEGMENTS; segment++)
          for (let profile = 0; profile < PROFILE.length - 1; profile++) {
            const a = first + segment * PROFILE.length + profile,
              b = a + PROFILE.length,
              c = a + 1,
              d = b + 1;
            const xs = [a, b, c, d].map((i) => positions[i * 3]),
              zs = [a, b, c, d].map((i) => positions[i * 3 + 2]);
            const minX = Math.min(...xs),
              maxX = Math.max(...xs),
              minZ = Math.min(...zs),
              maxZ = Math.max(...zs);
            if (
              shelters.some(
                (r) =>
                  maxX > r.x - r.hx &&
                  minX < r.x + r.hx &&
                  maxZ > r.z - r.hz &&
                  minZ < r.z + r.hz,
              )
            )
              continue;
            const triangle = indices.length;
            indices.push(a, b, c, b, d, c);
            for (
              let ix = Math.floor(minX / CELL);
              ix <= Math.floor(maxX / CELL);
              ix++
            )
              for (
                let iz = Math.floor(minZ / CELL);
                iz <= Math.floor(maxZ / CELL);
                iz++
              ) {
                const cellKey = ix + ':' + iz;
                let list = cells.get(cellKey);
                if (!list) {
                  list = [];
                  cells.set(cellKey, list);
                }
                list.push(triangle, triangle + 3);
              }
          }
      }
      blocks.push({ x: cx, z: cz, start, count: indices.length - start });
    }
  const geometry = new THREE.BufferGeometry();
  const vertices = new THREE.Float32BufferAttribute(positions, 3),
    density = new THREE.Float32BufferAttribute(coverage, 1);
  geometry.setAttribute('position', vertices);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('snowCoverage', density);
  geometry.setAttribute(
    'snowExterior',
    new THREE.Float32BufferAttribute(new Float32Array(coverage.length), 1),
  );
  const IndexArray = coverage.length > 65535 ? Uint32Array : Uint16Array;
  const allIndices = new IndexArray(indices);
  geometry.setIndex(new THREE.BufferAttribute(allIndices, 1));
  geometry.computeVertexNormals();
  const capacity =
    (VISIBLE_BLOCK_RADIUS * 2 + 1) ** 2 *
    SEGMENTS *
    (PROFILE.length - 1) *
    4 *
    6;
  const visibleIndices = new IndexArray(capacity),
    visibleIndex = new THREE.BufferAttribute(visibleIndices, 1).setUsage(
      THREE.DynamicDrawUsage,
    );
  geometry.setIndex(visibleIndex);
  geometry.setDrawRange(0, 0);
  geometry.computeBoundingSphere();

  const size = 128,
    texels = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const value = 212 + Math.floor(noise(x, z) * 43),
        offset = (z * size + x) * 4;
      texels[offset] = texels[offset + 1] = texels[offset + 2] = value;
      texels[offset + 3] = 255;
    }
  const grain = new THREE.DataTexture(texels, size, size);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.magFilter = THREE.LinearFilter;
  grain.minFilter = THREE.LinearMipmapLinearFilter;
  grain.generateMipmaps = true;
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({
    color: 0xf2f5f8,
    vertexColors: true,
    map: grain,
    bumpMap: grain,
    bumpScale: 0.018,
    roughness: 0.98,
    metalness: 0,
    envMapIntensity: 0.25,
    alphaTest: 0.004,
    transparent: true,
    depthWrite: true,
    emissive: 0x192633,
    emissiveIntensity: 0.18,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nattribute float snowCoverage;\nattribute float snowExterior;\nvarying float vSnowCoverage;\nvarying float vSnowExterior;\nvarying vec2 vSnowWorld;',
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvSnowCoverage = snowCoverage; vSnowExterior = snowExterior; vSnowWorld = (modelMatrix * vec4(position, 1.)).xz;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nvarying float vSnowCoverage;\nvarying float vSnowExterior;\nvarying vec2 vSnowWorld;\n' +
        BORDER_SNOW_GLSL,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      `
      float cover = vSnowExterior > .5 ? borderSnowCoverage(vSnowWorld) : vSnowCoverage;
      float breakup = sin(vSnowWorld.x * 2.4 + sin(vSnowWorld.y * 1.8)) * sin(vSnowWorld.y * 2.1);
      cover += (breakup * .12 + (sampledDiffuseColor.r - .78) * .25) * cover * (1. - cover);
      diffuseColor.a *= smoothstep(0., .97, cover);
      #include <alphatest_fragment>
    `,
    );
  };
  material.customProgramCacheKey = () => 'snow-island-shoreline-v3';
  const banks = new THREE.Mesh(geometry, material);
  banks.name = 'Snow / plowed roadside banks';
  banks.receiveShadow = true;
  banks.matrixAutoUpdate = false;
  banks.renderOrder = 1;
  scene.add(banks);

  // Snow stops at the island seawall; water remains exposed beyond the shoreline.
  const outerPositions: number[] = [],
    outerColors: number[] = [],
    outerUvs: number[] = [],
    outerIndices: number[] = [];
  const radii = [
    BORDER_SNOW_START,
    382.1,
    383.2,
    386,
    396,
    420,
    WINTER_GROUND_EDGE,
  ];
  const spans = 48;
  for (let side = 0; side < 4; side++) {
    const first = outerPositions.length / 3;
    for (let segment = 0; segment <= spans; segment++)
      for (const r of radii) {
        const a = ((segment / spans) * 2 - 1) * r,
          b = r;
        const x = side === 0 ? a : side === 1 ? b : side === 2 ? -a : -b;
        const z = side === 0 ? b : side === 1 ? -a : side === 2 ? -b : a;
        outerPositions.push(x, borderSnowHeight(x, z), z);
        const color = 0.8 + noise(x, z) * 0.07;
        outerColors.push(color, color + 0.025, color + 0.04);
        outerUvs.push(x * 1.7, z * 1.7);
      }
    for (let segment = 0; segment < spans; segment++)
      for (let profile = 0; profile < radii.length - 1; profile++) {
        const a = first + segment * radii.length + profile,
          b = a + radii.length,
          c = a + 1,
          d = b + 1;
        outerIndices.push(a, c, b, b, c, d);
      }
  }
  const outerGeometry = new THREE.BufferGeometry(),
    outerCount = outerPositions.length / 3;
  outerGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(outerPositions, 3),
  );
  outerGeometry.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(outerColors, 3),
  );
  outerGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(outerUvs, 2),
  );
  outerGeometry.setAttribute(
    'snowCoverage',
    new THREE.Float32BufferAttribute(new Float32Array(outerCount).fill(1), 1),
  );
  outerGeometry.setAttribute(
    'snowExterior',
    new THREE.Float32BufferAttribute(new Float32Array(outerCount).fill(1), 1),
  );
  outerGeometry.setIndex(outerIndices);
  outerGeometry.computeVertexNormals();
  const border = new THREE.Mesh(outerGeometry, material);
  border.name = 'Snow / outer city ground';
  border.receiveShadow = true;
  border.matrixAutoUpdate = false;
  border.renderOrder = 1;
  scene.add(border);
  let previousX = Infinity,
    previousZ = Infinity;
  const scratch = makeSnowContact();
  function sample(
    x: number,
    z: number,
    target: SnowContact = scratch,
  ): SnowContact {
    const outer = borderSnowCoverage(x, z);
    if (outer > 0.001)
      return finishSnowContact(target, x, z, borderSnowHeight(x, z), outer);
    const list = cells.get(key(x, z));
    if (list)
      for (const offset of list) {
        const a = allIndices[offset],
          b = allIndices[offset + 1],
          c = allIndices[offset + 2];
        const ax = vertices.getX(a),
          az = vertices.getZ(a),
          bx = vertices.getX(b),
          bz = vertices.getZ(b),
          cx = vertices.getX(c),
          cz = vertices.getZ(c);
        const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / determinant;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / determinant;
        const w = 1 - u - v;
        if (u < -1e-5 || v < -1e-5 || w < -1e-5) continue;
        const cover = smooth01(
          (u * density.getX(a) + v * density.getX(b) + w * density.getX(c)) /
            0.97,
        );
        if (cover < 0.004) continue;
        const height =
          u * vertices.getY(a) + v * vertices.getY(b) + w * vertices.getY(c);
        return finishSnowContact(target, x, z, height, cover);
      }
    return finishSnowContact(target, x, z, groundHeight(x, z), 0);
  }
  return {
    banks,
    border,
    allIndices,
    sample,
    update(position: THREE.Vector3) {
      const x = nearestBlock(position.x),
        z = nearestBlock(position.z);
      if (x === previousX && z === previousZ) return;
      previousX = x;
      previousZ = z;
      let count = 0;
      const range = VISIBLE_BLOCK_RADIUS * ROAD_STEP;
      for (const block of blocks) {
        if (Math.abs(block.x - x) > range || Math.abs(block.z - z) > range)
          continue;
        visibleIndices.set(
          allIndices.subarray(block.start, block.start + block.count),
          count,
        );
        count += block.count;
      }
      visibleIndex.clearUpdateRanges();
      visibleIndex.addUpdateRange(0, count);
      visibleIndex.needsUpdate = true;
      geometry.setDrawRange(0, count);
    },
  };
}
