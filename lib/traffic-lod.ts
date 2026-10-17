import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Surface = 'paint' | 'trim' | 'glass' | 'headlights' | 'brakes' | 'reverse';
type Emitters = { headlights: THREE.Mesh[]; brakeLights: THREE.Mesh[]; reverseLights: THREE.Mesh[] };
type CachedGeometry = { surface: Surface; geometry: THREE.BufferGeometry }[];
const cache = new WeakMap<THREE.Object3D, CachedGeometry>();

/** Collapse subpixel exterior detail once, retaining the authored body and wheel outlines. */
function clusteredGeometry(mesh: THREE.Mesh, transform: THREE.Matrix4, spacing: number, color: THREE.Color) {
  const source = mesh.geometry, positions = source.getAttribute('position');
  const vertices: number[] = [], colors: number[] = [], normals: number[] = [], triangles: number[] = [];
  const clusters = new Map<string, number>(), remap = new Uint32Array(positions.count);
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3(), normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
  const sourceNormals = source.getAttribute('normal');
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i).applyMatrix4(transform);
    if (sourceNormals) normal.fromBufferAttribute(sourceNormals, i).applyNormalMatrix(normalMatrix);
    else normal.set(0, 1, 0);
    // Separate folds and opposite faces even when thin panels share a cell.
    // Welding across those seams cancels normals and makes black patches.
    const key = `${Math.round(point.x / spacing)},${Math.round(point.y / spacing)},${Math.round(point.z / spacing)}|${Math.round(normal.x * 3)},${Math.round(normal.y * 3)},${Math.round(normal.z * 3)}`;
    let vertex = clusters.get(key);
    if (vertex === undefined) {
      vertex = vertices.length / 3; clusters.set(key, vertex);
      vertices.push(point.x, point.y, point.z); colors.push(color.r, color.g, color.b); normals.push(0, 0, 0);
    }
    normals[vertex * 3] += normal.x; normals[vertex * 3 + 1] += normal.y; normals[vertex * 3 + 2] += normal.z;
    remap[i] = vertex;
  }
  const count = source.index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const a = remap[source.index ? source.index.getX(i) : i];
    const b = remap[source.index ? source.index.getX(i + 1) : i + 1];
    const c = remap[source.index ? source.index.getX(i + 2) : i + 2];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  if (!triangles.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  // Retain the authored smooth surfaces instead of exposing coarse clustered
  // triangle normals as dark facets when a car changes representation.
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.normalizeNormals(); geometry.setIndex(triangles);
  return geometry;
}

/** One shared set of exterior buffers replaces hundreds of tiny distant car draws. */
function exteriorGeometry(key: THREE.Object3D, car: THREE.Group, emitters: Emitters): CachedGeometry {
  const existing = cache.get(key);
  if (existing) return existing;
  car.updateWorldMatrix(true, true);
  const inverse = car.matrixWorld.clone().invert(), transform = new THREE.Matrix4();
  const buckets = new Map<Surface, THREE.BufferGeometry[]>();
  const headlights = new Set(emitters.headlights), brakes = new Set(emitters.brakeLights), reverse = new Set(emitters.reverseLights);
  car.traverseVisible(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.cockpitDetail) return;
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as THREE.MeshStandardMaterial;
    // Keep the original soft ground-contact plane in the close model only.
    if (material.transparent && !/glass|canopy|window/i.test(material.name)) return;
    // Removing a decal's UV/alpha mask would turn its entire rectangular
    // carrier into an opaque panel. Subpixel badges need no far geometry.
    if (material.alphaTest > 0 || material.alphaMap) return;
    const surface: Surface = headlights.has(object) ? 'headlights' : brakes.has(object) ? 'brakes' : reverse.has(object) ? 'reverse'
      : material.userData.vehiclePaint ? 'paint' : /glass|canopy|window/i.test(material.name) ? 'glass' : 'trim';
    const light = surface === 'headlights' || surface === 'brakes' || surface === 'reverse';
    const geometry = clusteredGeometry(object, transform.multiplyMatrices(inverse, object.matrixWorld), light ? .012 : .07,
      surface === 'trim' ? material.color ?? new THREE.Color(0x20252a) : new THREE.Color(0xffffff));
    if (!geometry) return;
    const bucket = buckets.get(surface) ?? []; bucket.push(geometry); buckets.set(surface, bucket);
  });
  const result: CachedGeometry = [];
  for (const [surface, geometries] of buckets) {
    const geometry = mergeGeometries(geometries);
    geometries.forEach(part => part.dispose());
    if (!geometry) continue;
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    result.push({ surface, geometry });
  }
  cache.set(key, result);
  return result;
}

export function createTrafficLod(source: THREE.Object3D, car: THREE.Group, color: number, emitters: Emitters) {
  const detail = car.children.map(object => ({ object, visible: object.visible }));
  const root = new THREE.Group(); root.name = 'Traffic / merged distant exterior';
  root.userData.trafficLod = true; root.visible = false;
  const materials = {
    paint: new THREE.MeshStandardMaterial({ color, metalness: .3, roughness: .24, envMapIntensity: 1.15 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: .5, roughness: .37, envMapIntensity: .9 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x536570, metalness: 0, roughness: .12, envMapIntensity: .9,
      transparent: true, opacity: .53, depthWrite: false, side: THREE.FrontSide }),
    headlights: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf0f6ff).multiplyScalar(2.4) }),
    brakes: new THREE.MeshStandardMaterial({ color: 0x480308, emissive: 0xee1422, emissiveIntensity: 1.6 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0xd8e5ec, emissive: 0xd8e5ec, emissiveIntensity: 0 }),
  };
  materials.paint.userData.vehiclePaint = true;
  for (const { surface, geometry } of exteriorGeometry(source, car, emitters)) {
    materials[surface].name = `Traffic / distant ${surface}`;
    const mesh = new THREE.Mesh(geometry, materials[surface]);
    mesh.name = `Traffic / distant ${surface}`; mesh.userData.dynamic = true; mesh.userData.trafficLod = true;
    // Small far-away vehicles do not need another full shadow-map submission.
    mesh.castShadow = false; mesh.receiveShadow = false; root.add(mesh);
  }
  car.add(root);
  let distant = false;
  return {
    root,
    update(distanceSquared: number, nearest: boolean, pitch: number, roll: number, braking: boolean, reversing: boolean) {
      // Twelve metres of hysteresis prevents a car flickering between representations.
      const next = !nearest && (distant ? distanceSquared > 72 * 72 : distanceSquared > 84 * 84);
      if (next !== distant) {
        distant = next; root.visible = distant;
        for (const { object, visible } of detail) object.visible = !distant && visible;
      }
      root.rotation.set(pitch, 0, roll);
      materials.brakes.emissiveIntensity = braking ? 4.5 : 1.6;
      materials.reverse.emissiveIntensity = reversing ? 2.2 : 0;
    },
  };
}
