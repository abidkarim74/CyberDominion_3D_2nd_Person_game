import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addCyberpunkDistrict, type DistrictInstanceCell } from './cyberpunk-district';
import { GRAPHICS_PRESETS, type GraphicsQuality } from './graphics-quality';
import { isCitySquare } from './city-layout';
import { NIGHT_ROAD_SURFACE_GLSL } from './night-city-surfaces';

const CYAN = 0x35cde8;
const PINK = 0xff347f;
const metal = new THREE.MeshStandardMaterial({ color: 0x17212a, metalness: .72, roughness: .43 });
const concrete = new THREE.MeshStandardMaterial({ color: 0x29323a, metalness: .18, roughness: .8 });
const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(1.25), toneMapped: false });
const pink = new THREE.MeshBasicMaterial({ color: new THREE.Color(PINK).multiplyScalar(1.2), toneMapped: false });

function box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = metal) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z); parent.add(mesh); return mesh;
}

function cable(parent: THREE.Object3D, points: THREE.Vector3[], radius = .045) {
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 18, radius, 5, false), metal);
  parent.add(mesh);
}

/** Static geometry is merged by material and city block so detail has a bounded draw cost. */
export function batchArchitecture(scene: THREE.Object3D, includeDynamic = false) {
  // Assemblies can be nested below newly positioned parents when they are first batched.
  scene.updateWorldMatrix(true, true);
  const rootInverse = scene.matrixWorld.clone().invert();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const colorMaterials = new Map<string, THREE.MeshBasicMaterial>();
  const accentStates = new WeakMap<THREE.MeshBasicMaterial, { key: string; material: THREE.MeshBasicMaterial }>();
  const worldBounds = new THREE.Box3();
  const center = new THREE.Vector3();
  const localMatrix = new THREE.Matrix4();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || (!includeDynamic && object.userData.dynamic) || Array.isArray(object.material)) return;
    if (object.material.transparent || object.material instanceof THREE.ShaderMaterial) return;
    const m = object.material as THREE.MeshStandardMaterial;
    // Absolute-coordinate curves have their mesh origin at zero. Bounds locate their actual block.
    object.geometry.computeBoundingBox();
    worldBounds.copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld);
    const p = worldBounds.getCenter(center);
    const heightClass = worldBounds.max.y <= 12 ? 0 : worldBounds.max.y <= 30 ? 1 : 2;
    const cellSize = heightClass < 2 ? 132 : 352;
    // Plain static accents can carry their hue in vertices and share a shader/material.
    // Keep textured/custom facades and movable car/aircraft assemblies on their own path.
    const basic = object.material instanceof THREE.MeshBasicMaterial ? object.material : undefined;
    const bakeColor = scene instanceof THREE.Scene && !includeDynamic && basic && basic.constructor === THREE.MeshBasicMaterial &&
      !basic.map && !basic.envMap && !basic.lightMap && !basic.aoMap && !basic.alphaMap && !basic.vertexColors && !basic.wireframe &&
      !basic.clippingPlanes?.length && basic.blending === THREE.NormalBlending && !('defines' in basic) &&
      basic.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && basic.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
    let material: THREE.Material = m;
    let materialKey: string;
    if (bakeColor) {
      let accent = accentStates.get(basic);
      if (!accent) {
        const state = { ...basic.toJSON(), uuid: undefined, name: undefined, color: undefined };
        // Include every render state even when toJSON omits its default value.
        const renderState = [basic.opacity, basic.alphaTest, basic.alphaHash, basic.alphaToCoverage, basic.premultipliedAlpha,
          basic.blending, basic.blendSrc, basic.blendDst, basic.blendEquation, basic.blendSrcAlpha, basic.blendDstAlpha, basic.blendEquationAlpha,
          basic.blendColor.toArray(), basic.blendAlpha, basic.depthFunc, basic.depthTest, basic.depthWrite, basic.colorWrite, basic.fog,
          basic.toneMapped, basic.side, basic.shadowSide, basic.polygonOffset, basic.polygonOffsetFactor, basic.polygonOffsetUnits,
          basic.forceSinglePass, basic.dithering, basic.precision, basic.visible, basic.clipIntersection, basic.clipShadows,
          basic.stencilWrite, basic.stencilFunc, basic.stencilRef, basic.stencilWriteMask, basic.stencilFuncMask, basic.stencilFail,
          basic.stencilZFail, basic.stencilZPass, basic.userData.noCastShadow];
        const colorKey = JSON.stringify([state, renderState]);
        let shared = colorMaterials.get(colorKey);
        if (!shared) {
          shared = basic.clone(); shared.color.setRGB(1, 1, 1); shared.vertexColors = true;
          colorMaterials.set(colorKey, shared);
        }
        accent = { key: colorKey, material: shared };
        accentStates.set(basic, accent);
      }
      material = accent.material;
      materialKey = ['Vertex-colored city accent', accent.key, heightClass, Math.floor((p.x + 22) / cellSize), Math.floor((p.z + 22) / cellSize)].join('|');
    } else {
      materialKey = [m.type, m.color?.getHex(), m.emissive?.getHex(), m.emissiveIntensity, m.metalness, m.roughness,
        m.map?.uuid, m.emissiveMap?.uuid, m.bumpMap?.uuid, m.bumpScale, m.envMapIntensity, m.side, m.toneMapped, m.userData.noCastShadow, m.customProgramCacheKey(), heightClass, Math.floor((p.x + 22) / cellSize), Math.floor((p.z + 22) / cellSize)].join('|');
    }
    const signature = materialKey;
    let bucket = buckets.get(signature);
    if (!bucket) { bucket = { material, geometries: [], meshes: [] }; buckets.set(signature, bucket); }
    // Keep shared corners so the main, shadow and reflection passes reuse vertex work.
    // A source without normals keeps the original flat-normal generation behavior.
    const g = object.geometry.index && !object.geometry.getAttribute('normal') ? object.geometry.toNonIndexed() : object.geometry.clone();
    // Keep vertices local to their assembly so wheels and rotors still move correctly.
    g.applyMatrix4(localMatrix.multiplyMatrices(rootInverse, object.matrixWorld));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    if (bakeColor) {
      const colors = new Float32Array(g.getAttribute('position').count * 3);
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = basic.color.r; colors[i + 1] = basic.color.g; colors[i + 2] = basic.color.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name) && !(bakeColor && name === 'color')) g.deleteAttribute(name);
    // mergeGeometries requires one index convention. Sequential indices preserve
    // nonindexed triangles exactly, without welding UV seams or hard edges.
    if (!g.index) {
      const count = g.getAttribute('position').count;
      const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      g.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    bucket.geometries.push(g); bucket.meshes.push(object);
  });
  const oldGeometries = new Set<THREE.BufferGeometry>();
  const oldMaterials = new Set<THREE.Material>();
  const retainedMaterials = new Set<THREE.Material>();
  for (const [signature, bucket] of buckets) {
    retainedMaterials.add(bucket.material);
    const geometry = mergeGeometries(bucket.geometries);
    if (geometry) {
      const merged = new THREE.Mesh(geometry, bucket.material);
      merged.name = 'Batched city architecture';
      merged.userData.dynamic = includeDynamic;
      merged.userData.noCastShadow = !!bucket.material.userData.noCastShadow;
      geometry.computeBoundingSphere();
      if (scene instanceof THREE.Scene) {
        geometry.computeBoundingBox();
        merged.userData.cityBounds = geometry.boundingBox;
        merged.userData.detailRange = geometry.boundingBox!.max.y <= 12 ? 150 : geometry.boundingBox!.max.y <= 30 ? 220 : 450;
        merged.userData.cityMaterialKey = signature.split('|').slice(0, -3).join('|');
      }
      merged.updateMatrix(); merged.matrixAutoUpdate = false;
      scene.add(merged);
      for (const mesh of bucket.meshes) {
        oldGeometries.add(mesh.geometry); oldMaterials.add(mesh.material as THREE.Material); mesh.removeFromParent();
      }
    }
    bucket.geometries.forEach(g => g.dispose());
  }
  // Remove empty transform trees left behind by merging thousands of static details.
  const emptyGroups: THREE.Group[] = [];
  scene.traverse(o => { if (o !== scene && o instanceof THREE.Group && !o.userData.dynamic) emptyGroups.push(o); });
  for (const group of emptyGroups.reverse()) if (group.children.length === 0) group.removeFromParent();
  oldGeometries.forEach(g => g.dispose());
  // A source material can also remain on an excluded instance or dynamic mesh.
  scene.traverse(object => {
    if (object instanceof THREE.Mesh) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) retainedMaterials.add(material);
    }
  });
  oldMaterials.forEach(m => { if (!retainedMaterials.has(m)) m.dispose(); });
  if (scene instanceof THREE.Scene) combineCityBatches(scene);
}

type CityBatchEntry = { id: number; bounds: THREE.Box3; range: number; skyline: boolean };

function staticBatchMaterial(material: THREE.Material) {
  // Architecture vertices/normals are already baked into world space. Avoid five vertex
  // texture fetches per triangle corner for identity instance transforms.
  const compile = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <batching_vertex>', '#ifdef USE_BATCHING\nmat4 batchingMatrix = mat4(1.0);\n#endif');
  };
  material.customProgramCacheKey = () => cacheKey + '|static-city-batch';
  material.needsUpdate = true;
}

/** Keep block-level culling while submitting compatible blocks through GPU multi-draw. */
function combineCityBatches(scene: THREE.Scene) {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const object of scene.children) {
    if (!(object instanceof THREE.Mesh) || !object.userData.cityMaterialKey) continue;
    const key = object.userData.cityMaterialKey as string;
    const meshes = groups.get(key);
    if (meshes) meshes.push(object); else groups.set(key, [object]);
  }
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const vertices = meshes.reduce((sum, m) => sum + m.geometry.getAttribute('position').count, 0);
    const indices = meshes.reduce((sum, m) => sum + m.geometry.index!.count, 0);
    const material = meshes[0].material as THREE.MeshBasicMaterial;
    staticBatchMaterial(material);
    const batch = new THREE.BatchedMesh(meshes.length, vertices, indices, material);
    batch.name = 'City / GPU batched architecture';
    batch.sortObjects = false;
    batch.userData.noCastShadow = meshes[0].userData.noCastShadow;
    batch.customDepthMaterial = new THREE.MeshDepthMaterial();
    staticBatchMaterial(batch.customDepthMaterial);
    const entries: CityBatchEntry[] = [];
    for (const mesh of meshes) {
      const id = batch.addInstance(batch.addGeometry(mesh.geometry));
      batch.setMatrixAt(id, mesh.matrix);
      const bounds = mesh.userData.cityBounds as THREE.Box3;
      entries.push({ id, bounds: bounds.clone(), range: mesh.userData.detailRange, skyline: material instanceof THREE.MeshBasicMaterial && !!material.map && bounds.max.y > 60 });
      mesh.removeFromParent(); mesh.geometry.dispose();
      if (mesh.material !== material) (mesh.material as THREE.Material).dispose();
    }
    batch.userData.cityBatchEntries = entries;
    batch.computeBoundingBox(); batch.computeBoundingSphere();
    batch.updateMatrix(); batch.matrixAutoUpdate = false;
    batch.updateMatrixWorld(true); batch.matrixWorldAutoUpdate = false;
    scene.add(batch);
  }
}

/** Scale distant decorative detail while retaining the skyline and stable range boundaries. */
export function cityVisibility(scene: THREE.Scene) {
  const batches = scene.children.filter(o => o.userData.cityBounds) as THREE.Mesh[];
  const gpuBatches = scene.children.filter(o => o.userData.cityBatchEntries) as THREE.BatchedMesh[];
  const batchVisibility = new WeakMap<THREE.Mesh, boolean>();
  const gpuBatchStates = gpuBatches.map(batch => {
    const entries = batch.userData.cityBatchEntries as CityBatchEntry[];
    return { batch, entries, visibility: new Uint8Array(entries.length) };
  });
  const instances = scene.children.filter(o => o instanceof THREE.InstancedMesh && o.userData.cityInstanceCells) as THREE.InstancedMesh[];
  const instanceStates = instances.map(mesh => {
    const cells = mesh.userData.cityInstanceCells as DistrictInstanceCell[];
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return { mesh, cells, selection: new Uint8Array(cells.length), initialized: false };
  });
  const previous = new THREE.Vector3(Infinity, Infinity, Infinity);
  let instanceCellX = Infinity; let instanceCellZ = Infinity;
  let previousDetailScale = NaN;
  // Already visible detail gets a small exit margin, so crossing a boundary
  // does not toggle it repeatedly, even when presets change the base distance.
  // The legacy quality argument remains accepted; scenery distance is an explicit preset choice.
  return (position: THREE.Vector3, _qualityLevel = 0, detailScale = 1) => {
    const scale = Number.isFinite(detailScale) ? THREE.MathUtils.clamp(detailScale, .65, 1.7) : 1;
    const scaleChanged = scale !== previousDetailScale;
    previousDetailScale = scale;
    const streetRangeSquared = (144 * scale) ** 2; const streetExitSquared = (144 * scale + 12) ** 2;
    const roofRangeSquared = (430 * scale) ** 2; const roofExitSquared = (430 * scale + 20) ** 2;
    const cx = Math.floor(position.x / 44); const cz = Math.floor(position.z / 44);
    if (scaleChanged || cx !== instanceCellX || cz !== instanceCellZ) {
      instanceCellX = cx; instanceCellZ = cz;
      const focusX = cx * 44 + 22; const focusZ = cz * 44 + 22;
      for (const state of instanceStates) {
        const { mesh, cells, selection } = state;
        let changed = !state.initialized;
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          const dx = Math.max(Math.abs(cell.x - focusX) - 13, 0); const dz = Math.max(Math.abs(cell.z - focusZ) - 13, 0);
          const distance = dx * dx + dz * dz;
          const previousSelection = selection[i];
          const streetRange = previousSelection & 1 ? streetExitSquared : streetRangeSquared;
          const roofRange = previousSelection & 2 ? roofExitSquared : roofRangeSquared;
          const selected = (cell.street.length && distance < streetRange ? 1 : 0) |
            (cell.roof.length && distance < roofRange ? 2 : 0);
          if (selection[i] !== selected) { selection[i] = selected; changed = true; }
        }
        // A grid change can select the same matrix segments. Avoid
        // repacking and uploading the buffer when its visible contents are identical.
        if (!changed) continue;
        state.initialized = true;
        const target = mesh.instanceMatrix.array as Float32Array;
        let offset = 0;
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          if (selection[i] & 1) { target.set(cell.street, offset); offset += cell.street.length; }
          if (selection[i] & 2) { target.set(cell.roof, offset); offset += cell.roof.length; }
        }
        mesh.count = offset / 16; mesh.visible = mesh.count > 0;
        mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, offset);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (!scaleChanged && previous.distanceToSquared(position) < 4) return;
    previous.copy(position);
    for (const { batch, entries, visibility } of gpuBatchStates) {
      let anyVisible = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const { bounds, range } = entry;
        const effectiveRange = range * scale + (visibility[i] ? 12 : 0);
        const x = Math.max(bounds.min.x - position.x, 0, position.x - bounds.max.x);
        const z = Math.max(bounds.min.z - position.z, 0, position.z - bounds.max.z);
        const visible = entry.skyline || x * x + z * z < effectiveRange * effectiveRange;
        batch.setVisibleAt(entry.id, visible);
        visibility[i] = visible ? 1 : 0;
        anyVisible ||= visible;
      }
      // Entirely out-of-range materials need no render-list or shadow/reflection work.
      batch.visible = anyVisible;
    }
    for (const mesh of batches) {
      const bounds = mesh.userData.cityBounds as THREE.Box3;
      const x = Math.max(bounds.min.x - position.x, 0, position.x - bounds.max.x);
      const z = Math.max(bounds.min.z - position.z, 0, position.z - bounds.max.z);
      // The far skyline uses unlit facade panels and supplies the distant horizon.
      const material = mesh.material as THREE.MeshBasicMaterial;
      const skyline = material instanceof THREE.MeshBasicMaterial && material.map && bounds.max.y > 60;
      const range = (mesh.userData.detailRange as number) * scale + (batchVisibility.get(mesh) ? 12 : 0);
      mesh.visible = !!skyline || x * x + z * z < range * range;
      batchVisibility.set(mesh, mesh.visible);
    }
  };
}

/** Soft night sky and narrow city lights keep polished surfaces readable. */
export function cityEnvironment(renderer: THREE.WebGLRenderer) {
  const studio = new THREE.Scene(); studio.background = new THREE.Color(0x0a1224);
  const sky = document.createElement('canvas'); sky.width = 2; sky.height = 128;
  const context = sky.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, sky.height);
  gradient.addColorStop(0, '#334b64');
  gradient.addColorStop(.5, '#233547');
  gradient.addColorStop(1, '#0b1220');
  context.fillStyle = gradient; context.fillRect(0, 0, sky.width, sky.height);
  const skyTexture = new THREE.CanvasTexture(sky); skyTexture.colorSpace = THREE.SRGBColorSpace;
  studio.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide })));
  const colors = [0x3b7684, 0x647483, 0x8a4c6a, 0x927454];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.2 + (i % 3) * .45, 9 + i % 7),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colors[i % 4]).multiplyScalar(i % 3 ? .45 : .72), side: THREE.DoubleSide }));
    panel.position.set(Math.sin(a) * 14, 4, Math.cos(a) * 14); panel.lookAt(0, 4, 0); studio.add(panel);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(studio, .06, .1, 80); generator.dispose();
  studio.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  skyTexture.dispose();
  return target;
}

export function addCityDetail(scene: THREE.Scene) {
  const district = addCyberpunkDistrict(scene);
  const trimMaterials = [cyan, pink];
  for (let ix = 0; ix < 17; ix++) for (let iz = 0; iz < 17; iz++) {
    const x = -352 + ix * 44; const z = -352 + iz * 44; const seed = ix * 17 + iz;
    if (isCitySquare(x, z)) continue;
    const group = new THREE.Group(); group.position.set(x, 0, z); scene.add(group);
    const trim = trimMaterials[(ix + iz) % 2];
    // Slab joints and accessible corners surround the opaque district storefronts.
    for (const side of [-1, 1]) {
      box(group, side * 12.85, .3, 0, .18, .2, 25.7, concrete);
      box(group, 0, .3, side * 12.85, 25.7, .2, .18, concrete);
      box(group, 0, .405, side * 12.6, 22, .018, .05, trim);
      for (let i = -2; i <= 2; i++) {
        box(group, i * 4.7, .25, side * 11.85, .025, .015, 1.3, metal);
      }
      for (const k of [-1, 1]) {
        box(group, side * 11.9, .75, k * 11.9, .24, 1.05, .24, metal);
        box(group, side * 11.9, 1.12, k * 11.9, .27, .08, .27, trim);
      }
    }
    // Upper service pipes remain above the new shop canopies. Hidden old interiors are omitted.
    for (let j = 0; j < 2; j++) {
      cable(group, [new THREE.Vector3(10.8, .4, -4 + j * .5), new THREE.Vector3(10.8, 4.5, -4 + j * .5), new THREE.Vector3(8, 5, -4 + j * .5)], .09);
    }
    if (seed % 4 === 0) {
      const screen = district.screen(seed % 3, 6.5, 9.75);
      screen.position.set(0, 10, -12.46); screen.rotation.y = Math.PI;
      group.add(screen);
      box(group, 0, 10, -12.28, 6.85, 10.1, .3, metal);
    }
    // Blade advertisements face the main avenues and create a strong near/mid hierarchy.
    if ((Math.abs(x) === 0 || Math.abs(x) === 176 || Math.abs(x) === 264) && (iz % 2 === 0 || iz === 3)) {
      const screen = district.screen((iz + ix) % 4, 6, 18);
      screen.position.set(x < 0 ? 12.46 : -12.46, iz === 3 ? 14 : 20 + seed % 9, -2);
      screen.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      group.add(screen);
    }
    if (iz % 3 === 0) {
      cable(scene, [new THREE.Vector3(x - 12, 11, z - 13), new THREE.Vector3(x, 9, z - 22), new THREE.Vector3(x + 12, 12, z - 31)], .04);
    }
  }
  // A multi-span elevated arterial behind the foreground blocks, with structural trusses.
  for (let i = -8; i < 9; i++) {
    const x = i * 44;
    box(scene, x, 23.4, -286, 44, .7, 6.4, concrete);
    for (const side of [-1, 1]) {
      box(scene, x, 24.1, -286 + side * 3.1, 44, .08, .08, cyan);
      box(scene, x, 22.7, -286 + side * 2.8, 44, .25, .25, metal);
      box(scene, x, 11.5, -286 + side * 11, 1.2, 23, 1.2, concrete);
      for (let j = 0; j < 8; j++) {
        const brace = box(scene, x - 19 + j * 5.4, 22.8, -286 + side * 3, .12, 2.5, .12, metal);
        brace.rotation.z = j % 2 ? -.85 : .85;
      }
    }
  }
  // Tunnel services and lighting now follow each complete covered-road span.
  // Diagonal crosswalks/stop bars remain subtle, broken lane lines stop at junctions.
  const markings = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x82919d }), 18 * 18 * 16);
  let count = 0; const matrix = new THREE.Matrix4();
  for (let x = -374; x <= 374; x += 44) for (let z = -374; z <= 374; z += 44) {
    if (isCitySquare(x, z)) continue;
    for (const side of [-1, 1]) for (let j = 0; j < 4; j++) {
      matrix.makeScale(.65, .012, 2); matrix.setPosition(x + (j - 1.5) * 1.5, .047, z + side * 8); markings.setMatrixAt(count++, matrix);
      matrix.makeScale(2, .012, .65); matrix.setPosition(x + side * 8, .047, z + (j - 1.5) * 1.5); markings.setMatrixAt(count++, matrix);
    }
  }
  markings.count = count;
  markings.instanceMatrix.needsUpdate = true;
  scene.add(markings);
  // Visible infrastructure marks the existing world boundary.
  for (let road = -374; road <= 374; road += 44) for (const side of [-1, 1]) {
    box(scene, road, .65, side * 396, 17, .9, .45, concrete);
    box(scene, road, 1.12, side * 396, 17, .06, .5, pink);
    box(scene, side * 396, .65, road, .45, .9, 17, concrete);
    box(scene, side * 396, 1.12, road, .5, .06, 17, pink);
  }
  // LED displays use the city's shared clock, including while the car is parked.
}

export function wetStreetReflection(scene: THREE.Scene) {
  const mirror = new Reflector(new THREE.PlaneGeometry(800, 800), { textureWidth: 768, textureHeight: 432, clipBias: .002, multisample: 0 });
  mirror.name = 'Road / wet asphalt reflections';
  mirror.rotation.x = -Math.PI / 2; mirror.position.y = .026;
  const material = mirror.material as THREE.ShaderMaterial;
  material.transparent = true; material.depthWrite = false;
  material.uniforms.time = { value: 0 };
  material.uniforms.reflectionSpread = { value: new THREE.Vector2(.001, .002) };
  material.uniforms.reflectionGain = { value: 1.12 };
  material.uniforms.highlightCompression = { value: .18 };
  material.uniforms.reflectionReach = { value: 240 };
  material.vertexShader = `uniform mat4 textureMatrix;
    varying vec4 vUv; varying vec3 vWorld;
    void main() { vUv = textureMatrix * vec4(position,1.); vWorld = (modelMatrix * vec4(position,1.)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`;
  material.fragmentShader = `uniform sampler2D tDiffuse; uniform float time; uniform vec2 reflectionSpread;
    uniform float reflectionGain; uniform float highlightCompression; uniform float reflectionReach;
    varying vec4 vUv; varying vec3 vWorld;
    ${NIGHT_ROAD_SURFACE_GLSL}
    void main(){
      vec2 uv = vUv.xy / vUv.w;
      float roadWetness=nightRoadWetness(vWorld.xz);
      float cameraDistance=distance(cameraPosition,vWorld);
      // Screen derivatives remove subpixel ripples before they can shimmer in motion.
      float footprint=max(length(dFdx(vWorld.xz)),length(dFdy(vWorld.xz)));
      float ripple = sin(vWorld.z*18.+time*.7)*sin(vWorld.x*14.-time*.5);
      float rippleFade=(1.-smoothstep(35.,95.,cameraDistance))*(1.-smoothstep(.025,.18,footprint));
      uv += vec2(ripple*.00012, ripple*.0002)*rippleFade*roadWetness;
      // Water-filled patches stay crisp; rougher asphalt spreads the same three samples.
      vec2 spread=reflectionSpread*mix(1.65,.65,roadWetness);
      vec3 reflected = texture2D(tDiffuse,uv).rgb*.42;
      reflected += texture2D(tDiffuse,uv+spread).rgb*.29;
      reflected += texture2D(tDiffuse,uv-spread).rgb*.29;
      float grazing = 1.-clamp(normalize(cameraPosition-vWorld).y,0.,1.);
      float grazing2=grazing*grazing;
      float fresnel=.045+.955*grazing2*grazing2*grazing;
      float luminance = dot(reflected,vec3(.2126,.7152,.0722));
      // A soft shoulder keeps neon hue and HDR highlights instead of clipping them to gray.
      reflected /= 1.+max(luminance,0.)*highlightCompression;
      float distanceFade=1.-smoothstep(reflectionReach*.48,reflectionReach,cameraDistance);
      float strength=(.018+fresnel*.48)*reflectionGain*roadWetness*distanceFade;
      gl_FragColor=vec4(reflected*vec3(.86,.91,.96),strength);
    }`;
  // Captures follow the chosen budget, with occasional parked updates for animated city lights.
  const capture = mirror.onBeforeRender.bind(mirror);
  let captureFrame = 0;
  let quality = 0;
  let presetKey = '';
  let captureCadence = 6;
  let parkedCadence = 48;
  let movementThreshold = .0225;
  let rotationThreshold = .00004;
  let lastCaptureFrame = -Infinity;
  let hasCapture = false;
  let collected = false;
  const excluded: THREE.Object3D[] = [];
  const visibility: boolean[] = [];
  const previousPosition = new THREE.Vector3();
  const previousRotation = new THREE.Quaternion();
  const cameraPosition = new THREE.Vector3();
  const cameraRotation = new THREE.Quaternion();
  const cameraDirection = new THREE.Vector3();
  mirror.onBeforeRender = function(renderer, scene, camera, geometry, material, group) {
    const frame = captureFrame++;
    if (hasCapture && frame % captureCadence !== 2 % captureCadence) return;
    camera.getWorldPosition(cameraPosition); camera.getWorldQuaternion(cameraRotation);
    // Looking into the sky does not need another complete city render.
    camera.getWorldDirection(cameraDirection);
    if (cameraPosition.y <= mirror.position.y || cameraDirection.y > .8) return;
    if (hasCapture && frame - lastCaptureFrame < parkedCadence && cameraPosition.distanceToSquared(previousPosition) < movementThreshold && 1 - Math.abs(cameraRotation.dot(previousRotation)) < rotationThreshold) return;
    if (!collected) {
      // The first render happens after weather and the car are installed. Keep references thereafter.
      scene.traverse(object => {
        const roadSurface = object instanceof THREE.Mesh && !Array.isArray(object.material) && object.material.userData.nightRoadSurface;
        // The asphalt lies beneath the reflection clip plane and cannot contribute to a capture.
        if (roadSurface || object instanceof THREE.Points || object instanceof THREE.Sprite || object.name.startsWith('Snow /') || object.userData.cockpitDetail || object.userData.excludeFromReflection) excluded.push(object);
      });
      collected = true;
    }
    for (let i = 0; i < excluded.length; i++) { visibility[i] = excluded[i].visible; excluded[i].visible = false; }
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    try {
      capture(renderer, scene, camera, geometry, material, group);
      previousPosition.copy(cameraPosition); previousRotation.copy(cameraRotation); hasCapture = true; lastCaptureFrame = frame;
    } finally {
      for (let i = 0; i < excluded.length; i++) excluded[i].visible = visibility[i];
      renderer.shadowMap.autoUpdate = shadowAutoUpdate; renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
    }
  };
  scene.add(mirror);
  return {
    mirror,
    update(time: number) { material.uniforms.time.value = time; },
    invalidate() { hasCapture = false; },
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = Number.isFinite(pressure) ? THREE.MathUtils.clamp(Math.floor(pressure), 0, 4) : 0;
      const key = `${preset}:${load}`;
      if (key === presetKey) return;
      presetKey = key;
      const profile = GRAPHICS_PRESETS[preset];
      // Pressure trims work within the selected tier; Ultra keeps a larger capture than High.
      const size = Math.max(128, Math.round(profile.reflectionSize * (1 - load * .1) / 64) * 64);
      captureCadence = Math.max(1, Math.round(profile.reflectionCadence * (1 + load * .45)));
      parkedCadence = Math.max(captureCadence, (preset === 'ultra' ? 8 : preset === 'low' ? 72 : 24) * (1 + load));
      movementThreshold = preset === 'ultra' ? .0001 : preset === 'low' ? .0225 : .0025;
      rotationThreshold = preset === 'ultra' ? .0000005 : .00004;
      const spread = preset === 'ultra' ? .45 : preset === 'low' ? 1 : .65;
      material.uniforms.reflectionSpread.value.set(spread / size, spread * 1.5 / size);
      material.uniforms.reflectionGain.value = { low: .8, medium: .98, high: 1.16, ultra: 1.34 }[preset];
      material.uniforms.highlightCompression.value = { low: .4, medium: .25, high: .18, ultra: .13 }[preset];
      material.uniforms.reflectionReach.value = { low: 140, medium: 200, high: 260, ultra: 310 }[preset];
      mirror.getRenderTarget().setSize(size, size);
      mirror.visible = true; hasCapture = false;
    },
    setQuality(level: number) {
      const next = Math.max(0, Math.min(4, Math.floor(level)));
      if (next === quality && !presetKey) return;
      presetKey = '';
      quality = next; mirror.visible = true; hasCapture = false;
      captureCadence = [6, 9, 14, 20, 28][quality]; parkedCadence = captureCadence * 8;
      movementThreshold = .0225; rotationThreshold = .00004;
      material.uniforms.reflectionSpread.value.set(.001, .002);
      material.uniforms.reflectionGain.value = 1.12;
      material.uniforms.highlightCompression.value = .18;
      material.uniforms.reflectionReach.value = 240;
      const [width, height] = [[768, 432], [640, 360], [512, 288], [384, 216], [256, 144]][quality];
      mirror.getRenderTarget().setSize(width, height);
    },
    dispose() { mirror.getRenderTarget().dispose(); },
  };
}

/** Select a preset's local practical lights without rendering every lamp in the city. */
export function poolStreetLights(scene: THREE.Scene) {
  const sources: { position: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; decay: number }[] = [];
  const remove: THREE.PointLight[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => { if (o instanceof THREE.PointLight) {
    sources.push({ position: o.getWorldPosition(new THREE.Vector3()), color: o.color.clone(), intensity: o.intensity, distance: o.distance, decay: o.decay }); remove.push(o);
  } });
  remove.forEach(l => l.removeFromParent());
  const pool = Array.from({ length: 8 }, (_, index) => {
    const light = new THREE.PointLight(); light.visible = index < 4; scene.add(light); return light;
  });
  const previous = new THREE.Vector3(Infinity, Infinity, Infinity);
  let previousCount = -1;
  const nearest: (typeof sources[number] | undefined)[] = Array.from({ length: pool.length }, () => undefined);
  const distances = new Float64Array(pool.length);
  return (position: THREE.Vector3, count = 4) => {
    const nextCount = Number.isFinite(count) ? THREE.MathUtils.clamp(Math.floor(count), 0, pool.length) : 4;
    if (nextCount === previousCount && previous.distanceToSquared(position) < 4) return;
    previousCount = nextCount;
    previous.copy(position); nearest.fill(undefined); distances.fill(Infinity);
    for (const source of sources) {
      const distance = source.position.distanceToSquared(position);
      for (let i = 0; i < nextCount; i++) {
        if (distance >= distances[i]) continue;
        for (let j = nextCount - 1; j > i; j--) { distances[j] = distances[j - 1]; nearest[j] = nearest[j - 1]; }
        distances[i] = distance; nearest[i] = source; break;
      }
    }
    pool.forEach((light, i) => { const source = nearest[i]; light.visible = i < nextCount && !!source;
      if (!light.visible || !source) { light.intensity = 0; return; }
      light.position.copy(source.position); light.color.copy(source.color); light.intensity = source.intensity; light.distance = source.distance; light.decay = source.decay;
    });
  };
}
