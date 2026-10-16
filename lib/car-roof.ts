import * as THREE from 'three';
import { createFieryRoofLivery } from './car-roof-livery';

/** Isolate the authored upper shell while preserving every panel boundary. */
function upperShellIndices(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position'), index = geometry.getIndex()!;
  const weld = new Map<string, number>(), ids: number[] = [], neighbors: number[][] = [];
  let seed = 0, nearest = Infinity;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
    const key = `${x},${y},${z}`;
    let id = weld.get(key);
    if (id === undefined) { id = neighbors.length; weld.set(key, id); neighbors.push([]); }
    ids.push(id);
    const distance = x * x + (y - 1.3) ** 2 + (z - .1) ** 2;
    if (distance < nearest) { nearest = distance; seed = id; }
  }
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const a = ids[index.getX(triangle)], b = ids[index.getX(triangle + 1)], c = ids[index.getX(triangle + 2)];
    neighbors[a].push(b, c); neighbors[b].push(a, c); neighbors[c].push(a, b);
  }
  const connected = new Set([seed]), queue = [seed];
  for (let i = 0; i < queue.length; i++) for (const next of neighbors[queue[i]]) {
    if (!connected.has(next)) { connected.add(next); queue.push(next); }
  }
  const shell: number[] = [], rest: number[] = [];
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const target = connected.has(ids[index.getX(triangle)]) ? shell : rest;
    target.push(index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2));
  }
  return { shell, rest };
}

/** Transparent pigment blends into lacquer instead of multiplying it by a decal. */
function flamePaint(base: THREE.MeshPhysicalMaterial, livery: ReturnType<typeof createFieryRoofLivery>, fin = false) {
  const material = base.clone();
  material.name = fin ? 'Bugatti / airbrushed flame continuation on rear fin' : 'Bugatti / pearl lacquer with blended roof-to-rear flames';
  material.map = livery.map;
  material.emissiveMap = livery.emissiveMap;
  material.emissive.setHex(0xffffff);
  material.emissiveIntensity = .035;
  material.customProgramCacheKey = () => `car-airbrushed-flames-v1/${fin ? 'fin' : 'upper-shell'}`;
  material.onBeforeCompile = shader => {
    const varying = 'varying vec3 vFlamePosition;\nvarying vec3 vFlameNormal;\n';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${varying}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlamePosition = position;\nvFlameNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${varying}`)
      .replace('#include <map_fragment>', /* glsl */ `
        // Every surface shares these car-local coordinates, including the fin.
        vec2 flameUv = vec2((vFlamePosition.x + .92) / 1.84, (vFlamePosition.z + .56) / 2.8);
        vec4 flamePigment = texture2D(map, flameUv);
        float flameSurface = ${fin ? '1.0' : 'smoothstep(.25, .62, normalize(vFlameNormal).y)'};
        diffuseColor.rgb = mix(diffuseColor.rgb, flamePigment.rgb, flamePigment.a * flameSurface);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        totalEmissiveRadiance *= texture2D(emissiveMap, flameUv).rgb * flameSurface;
      `);
  };
  return material;
}

/** Paint one flowing design across the roof, rear deck and center dorsal fin. */
export function addFieryRoof(body: THREE.Group) {
  const source = body.getObjectByName('Blender Chiron / secondaryPaint') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  const { shell, rest } = upperShellIndices(source.geometry);
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  const remap = new Map<number, number>();
  const sourcePosition = source.geometry.getAttribute('position');
  const sourceNormal = source.geometry.getAttribute('normal');
  const sourceUv = source.geometry.getAttribute('uv');
  for (const vertex of shell) {
    let mapped = remap.get(vertex);
    if (mapped === undefined) {
      mapped = remap.size; remap.set(vertex, mapped);
      positions.push(sourcePosition.getX(vertex), sourcePosition.getY(vertex), sourcePosition.getZ(vertex));
      normals.push(sourceNormal.getX(vertex), sourceNormal.getY(vertex), sourceNormal.getZ(vertex));
      uv.push(sourceUv.getX(vertex), sourceUv.getY(vertex));
    }
    indices.push(mapped);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const livery = createFieryRoofLivery();
  const panel = new THREE.Mesh(geometry, flamePaint(source.material, livery));
  panel.name = 'Bugatti / blended flame roof and rear deck';
  panel.userData.carPart = 'roof-and-rear-deck';
  body.add(panel);
  source.geometry.setIndex(rest);
  source.geometry.computeBoundingBox(); source.geometry.computeBoundingSphere();
  for (const name of ['Bugatti / carbon center dorsal fin', 'Bugatti / red dorsal fin upper edge']) {
    const fin = body.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    fin.material = flamePaint(fin.material, livery, true);
  }
  body.userData.flameLivery = { style: 'Airbrushed pearl paint', shellTriangles: shell.length / 3,
    surfaces: ['roof', 'rear deck', 'center rear fin'] };
}
