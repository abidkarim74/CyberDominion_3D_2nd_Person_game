import * as THREE from 'three';

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

type Vertex = number[]; // Position, authored normal, and original UV.

/** Split a polygon on a paint boundary, interpolating the original attributes. */
function splitPolygon(polygon: Vertex[], distance: (vertex: Vertex) => number) {
  const inside: Vertex[] = [], outside: Vertex[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = distance(a), db = distance(b);
    (da >= 0 ? inside : outside).push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      const edge = a.map((value, component) => THREE.MathUtils.lerp(value, b[component], t));
      inside.push(edge); outside.push(edge);
    }
  }
  return { inside, outside };
}

/** Indexed triangles share their original corners and retain smooth bevel normals. */
function geometryBuilder() {
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  const vertices = new Map<string, number>();
  return {
    polygon(polygon: Vertex[]) {
      if (polygon.length < 3) return;
      const corners = polygon.map(vertex => {
        const key = vertex.join(',');
        let index = vertices.get(key);
        if (index === undefined) {
          index = vertices.size; vertices.set(key, index);
          positions.push(...vertex.slice(0, 3));
          const normal = new THREE.Vector3(...vertex.slice(3, 6) as [number, number, number]).normalize();
          normals.push(normal.x, normal.y, normal.z); uv.push(vertex[6], vertex[7]);
        }
        return index;
      });
      for (let i = 1; i < corners.length - 1; i++) indices.push(corners[0], corners[i], corners[i + 1]);
    },
    finish() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geometry.setIndex(indices);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      return geometry;
    },
  };
}

/** Cut the stripe into the real hood surface, with no raised decal or depth overlap. */
function addHoodStripe(body: THREE.Group, material: THREE.Material) {
  const hood = body.getObjectByName('Blender Chiron / paint') as THREE.Mesh<THREE.BufferGeometry>;
  const original = hood.geometry, position = original.getAttribute('position');
  const normal = original.getAttribute('normal'), uv = original.getAttribute('uv'), index = original.getIndex()!;
  const orange = geometryBuilder(), black = geometryBuilder();
  // A narrow stripe widens from the horseshoe grille toward the windshield.
  const halfWidth = (vertex: Vertex) => .09 + (vertex[2] + 2.35) * .032;
  const boundaries = [
    (v: Vertex) => v[2] + 2.35,
    (v: Vertex) => -1.18 - v[2],
    (v: Vertex) => v[0] + halfWidth(v),
    (v: Vertex) => halfWidth(v) - v[0],
  ];
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const face = [0, 1, 2].map(corner => {
      const i = index.getX(triangle + corner);
      return [position.getX(i), position.getY(i), position.getZ(i), normal.getX(i), normal.getY(i), normal.getZ(i), uv.getX(i), uv.getY(i)];
    });
    if (face.reduce((sum, vertex) => sum + vertex[4], 0) < .9 || face.some(vertex => vertex[1] < .55)) {
      orange.polygon(face); continue;
    }
    let remaining = face;
    for (const boundary of boundaries) {
      const split = splitPolygon(remaining, boundary);
      orange.polygon(split.outside); remaining = split.inside;
      if (remaining.length < 3) break;
    }
    black.polygon(remaining);
  }
  hood.geometry = orange.finish(); original.dispose();
  const stripe = new THREE.Mesh(black.finish(), material);
  stripe.name = 'Bugatti / fitted black center hood stripe';
  body.add(stripe);
  return (stripe.geometry.index?.count ?? 0) / 3;
}

/** Reference livery: orange body, gloss-black roof/deck, and a narrow black hood stripe. */
export function addReferenceLivery(body: THREE.Group) {
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
  const black = source.material.clone();
  black.name = 'Bugatti / reference gloss black roof and hood stripe';
  black.color.setHex(0x08090b);
  black.metalness = .2; black.roughness = .20;
  black.userData = { referenceBlackLacquer: true };
  const panel = new THREE.Mesh(geometry, black);
  panel.name = 'Bugatti / gloss black roof and rear deck';
  panel.userData.carPart = 'roof-and-rear-deck';
  body.add(panel);
  source.geometry.setIndex(rest);
  source.geometry.computeBoundingBox(); source.geometry.computeBoundingSphere();
  const stripeTriangles = addHoodStripe(body, black);
  body.userData.referenceLivery = {
    style: 'Orange / gloss black roof / tapered black hood stripe',
    roofTriangles: shell.length / 3, stripeTriangles,
  };
}
