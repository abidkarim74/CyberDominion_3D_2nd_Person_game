import * as THREE from 'three';

type ExteriorMaterials = Record<'paint' | 'carbon' | 'alloy' | 'trim', THREE.Material>;

/** A concave wheelhouse, with its closed inboard bulkhead facing the wheel. */
function wheelhouse(side: number, rear: boolean) {
  // Decoded source arch edges: front crown .763 m, rear crown .803 m;
  // rear quarters have a wider longitudinal opening than the front fenders.
  const centerY = .385, centerZ = rear ? 1.43 : -1.43;
  const radiusY = rear ? .425 : .389, radiusZ = rear ? .446 : .423;
  const inboard = rear ? .585 : .475;
  const segments = 32, start = -.54, sweep = Math.PI + 1.08;
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = start + sweep * i / segments;
    const sine = Math.sin(angle), cosine = Math.cos(angle);
    // Decoded outer arch legs are at |x| .951–.987, but their curved return
    // rolls inward at the crown. Seat this whole mouth behind the skin and
    // visible tire face; meeting the outer lip exposes a black fender overlay.
    const outboard = .900 - .015 * Math.abs(cosine) ** 4;
    const normal = new THREE.Vector3(0, -sine / radiusY, cosine / radiusZ).normalize();
    for (const [x, u] of [[outboard, 0], [inboard, 1]]) {
      positions.push(side * x, centerY + radiusY * sine, centerZ - radiusZ * cosine);
      normals.push(normal.x, normal.y, normal.z);
      uv.push(u, i / segments);
    }
    if (i < segments) {
      const a = i * 2, b = a + 2;
      if (side > 0) indices.push(a, b, b + 1, a, b + 1, a + 1);
      else indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
  // Separate flat vertices prevent the bulkhead normals from smoothing into
  // the curved liner. Front bulkheads allow room for the steered tire's sweep.
  const center = positions.length / 3;
  positions.push(side * inboard, centerY, centerZ);
  normals.push(side, 0, 0); uv.push(.5, .5);
  for (let i = 0; i <= segments; i++) {
    const angle = start + sweep * i / segments;
    positions.push(side * inboard, centerY + radiusY * Math.sin(angle), centerZ - radiusZ * Math.cos(angle));
    normals.push(side, 0, 0); uv.push(.5 - Math.cos(angle) * .5, .5 + Math.sin(angle) * .5);
    if (i < segments) {
      const a = center + i + 1;
      if (side > 0) indices.push(center, a, a + 1);
      else indices.push(center, a + 1, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/** A rolled mouth gives the existing thin titanium nozzle a real wall. */
function outletLip() {
  const profile = [[.078, -.007], [.078, -.002], [.075, 0], [.067, 0], [.065, -.004], [.065, -.009]];
  const segments = 24, positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let row = 0; row < profile.length; row++) {
    const [radius, z] = profile[row];
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
      uv.push(i / segments, row / (profile.length - 1));
      if (row < profile.length - 1 && i < segments) {
        const a = row * (segments + 1) + i, b = a + segments + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/** Fitted mechanical structure; all parts share the existing static batches. */
export function addCarExteriorDetails(body: THREE.Group, materials: ExteriorMaterials) {
  const details = new THREE.Group();
  details.name = 'Bugatti / fitted exterior mechanical details';
  body.add(details);
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Bugatti / ${name}`;
    details.add(mesh);
    return mesh;
  };

  for (const side of [-1, 1]) for (const rear of [false, true]) {
    add(`${rear ? 'rear' : 'front'} enclosed wheelhouse liner`, wheelhouse(side, rear), materials.trim);
  }

  // Match the two existing bumper-end outlets exactly. Their .078 m outside
  // radius and rear face at 2.405 m stay inside the original nozzle bounds.
  const lip = outletLip();
  for (const side of [-1, 1]) {
    const mesh = add('rolled titanium bumper-end outlet mouth', lip, materials.alloy);
    mesh.position.set(side * .80, .30, 2.405);
  }

  // Source intake castings and rear carbon diffuser already exist. Seat their
  // small fittings on the actual triangles, avoiding floating decoration or
  // guessed cover planes when the source model is revised.
  body.updateWorldMatrix(true, true);
  const raycaster = new THREE.Raycaster();
  const bodyInverse = body.matrixWorld.clone().invert();
  const up = new THREE.Vector3(0, 1, 0);
  const fastener = new THREE.CylinderGeometry(.006, .006, .004, 6);
  const socket = new THREE.CylinderGeometry(.0026, .0026, .0006, 6);
  let fasteners = 0;
  function seatFastener(sourceName: string, origin: THREE.Vector3, direction: THREE.Vector3, within: (point: THREE.Vector3) => boolean) {
    const source = body.getObjectByName(sourceName);
    if (!(source instanceof THREE.Mesh)) return;
    raycaster.set(origin.clone().applyMatrix4(body.matrixWorld), direction.clone().transformDirection(body.matrixWorld));
    const hit = raycaster.intersectObject(source, false)[0];
    if (!hit?.face) return;
    const point = hit.point.clone().applyMatrix4(bodyInverse);
    if (!within(point)) return;
    const sourceToBody = bodyInverse.clone().multiply(source.matrixWorld);
    const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(sourceToBody));
    if (normal.dot(direction) > -.25) return;
    const head = add('recessed hex mechanical fastener', fastener, materials.alloy);
    head.position.copy(point).addScaledVector(normal, .0015);
    head.quaternion.setFromUnitVectors(up, normal);
    const recess = add('dark hex fastener socket', socket, materials.trim);
    recess.position.copy(point).addScaledVector(normal, .00365);
    recess.quaternion.copy(head.quaternion);
    fasteners++;
  }
  for (const side of [-1, 1]) for (const x of [.157, .295]) for (const z of [.75, .95, 1.16]) {
    seatFastener('Blender Chiron / alloy', new THREE.Vector3(side * x, 1.15, z), new THREE.Vector3(0, -1, 0), point => point.y > .915 && point.y < 1.04);
  }
  for (const side of [-1, 1]) for (const [x, y] of [[.45, .35], [.70, .30]]) {
    seatFastener('Blender Chiron / carbon', new THREE.Vector3(side * x, y, 2.42), new THREE.Vector3(0, 0, -1), point => point.z > 2.1);
  }
  if (!fasteners) { fastener.dispose(); socket.dispose(); }

  const bounds = new THREE.Box3().setFromObject(details);
  let triangles = 0;
  details.traverse(object => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });
  body.userData.exteriorDetails = { triangles, fasteners, enclosedWheelhouses: 4 };
  return { details, bounds, triangles };
}
