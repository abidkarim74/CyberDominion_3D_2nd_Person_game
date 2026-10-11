import * as THREE from 'three';

type AeroMaterials = Record<'carbon' | 'paint' | 'trim' | 'alloy', THREE.Material>;
type Profile = [number, number][]; // Height, longitudinal position; front is -Z.

/** Closed loft with separate cap vertices, so smooth edges keep flat end faces. */
function solidProfile(profile: Profile, sections: number[], point: (x: number, y: number, z: number) => THREE.Vector3) {
  let area = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i], b = profile[(i + 1) % profile.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const contour = area > 0 ? profile : [...profile].reverse();
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  const count = contour.length;
  const vertex = (x: number, y: number, z: number) => {
    const p = point(x, y, z);
    positions.push(p.x, p.y, p.z);
    uv.push((p.x + p.z) * .35, p.y * .6 + p.z * .3);
  };
  for (const x of sections) for (const [y, z] of contour) vertex(x, y, z);
  for (let section = 0; section < sections.length - 1; section++) {
    for (let i = 0; i < count; i++) {
      const a = section * count + i, b = section * count + (i + 1) % count;
      const c = b + count, d = a + count;
      indices.push(a, b, c, a, c, d);
    }
  }
  const triangles = THREE.ShapeUtils.triangulateShape(contour.map(([y, z]) => new THREE.Vector2(y, z)), []);
  for (const end of [0, sections.length - 1]) {
    const offset = positions.length / 3;
    for (const [y, z] of contour) vertex(sections[end], y, z);
    for (const face of triangles) {
      const [a, b, c] = face.map(i => offset + i);
      const normalX = (positions[b * 3 + 1] - positions[a * 3 + 1]) * (positions[c * 3 + 2] - positions[a * 3 + 2])
        - (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3 + 1] - positions[a * 3 + 1]);
      const outward = end === 0 ? -1 : 1;
      if (normalX * outward > 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Compact low rear spoiler and small fins, using the car's material batches. */
export function addBugattiRearAero(body: THREE.Group, materials: AeroMaterials) {
  const aero = new THREE.Group();
  aero.name = 'Bugatti / compact rear spoiler and small fins';
  body.add(aero);
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Bugatti / ${name}`;
    aero.add(mesh);
    return mesh;
  };
  const box = (name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
    const mesh = add(name, new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
  };
  const profilePlate = (name: string, shape: Profile, center: number, thickness: number, material: THREE.Material) => {
    const geometry = solidProfile(shape, [-thickness / 2, thickness / 2], (x, y, z) => new THREE.Vector3(center + x, y, z));
    // Laminate faces retain crisp edge normals; narrow concave edge strips
    // should not average their opposing edge normals through the thin cap.
    const laminate = geometry.toNonIndexed();
    geometry.dispose();
    laminate.computeVertexNormals();
    laminate.computeBoundingBox();
    laminate.computeBoundingSphere();
    return add(name, laminate, material);
  };

  // A rounded NACA-style nose, cambered upper surface and thin closed trailing
  // edge give real aerofoil highlights. Red tip sections meet the carbon center.
  const airfoil: Profile = [[0, 0]];
  const halfThickness = (t: number) => .045 * (.2969 * Math.sqrt(t) - .1260 * t - .3516 * t * t + .2843 * t ** 3 - .1015 * t ** 4);
  const camber = (t: number) => .007 * Math.sin(Math.PI * t) + .009 * t;
  for (let i = 1; i <= 7; i++) {
    const t = (1 - Math.cos(Math.PI * i / 7)) / 2;
    airfoil.push([camber(t) + halfThickness(t), t * .27]);
  }
  for (let i = 7; i >= 1; i--) {
    const t = (1 - Math.cos(Math.PI * i / 7)) / 2;
    airfoil.push([camber(t) - halfThickness(t), t * .27]);
  }
  const wingPoint = (x: number, y: number, z: number) => {
    const sweep = (Math.abs(x) / .725) ** 2;
    return new THREE.Vector3(x, 1.085 + y + .005 * sweep, 1.95 + z + .02 * sweep);
  };
  add('cambered carbon rear airfoil', solidProfile(airfoil, [-.61, 0, .61], wingPoint), materials.carbon);
  for (const side of [-1, 1]) {
    const sections = side < 0 ? [-.725, -.61] : [.61, .725];
    add('racing red wing tip', solidProfile(airfoil, sections, wingPoint), materials.paint);

    // Tiny endplates sit on the spoiler tips, well below the coupe roofline.
    const fin: Profile = [
      [1.06, 1.979], [1.109, 1.990], [1.131, 2.159],
      [1.13, 2.245], [1.09, 2.255], [1.055, 2.205],
    ];
    const finCenter = side * .725;
    profilePlate('small carbon spoiler end fin', fin, finCenter, .014, materials.carbon);
    profilePlate('red upper fin edge', [
      [1.114, 1.990], [1.137, 2.159], [1.136, 2.245],
      [1.128, 2.245], [1.129, 2.159], [1.106, 1.990],
    ], finCenter, .018, materials.paint);

    // Slender swept pedestals plant the wing in the existing engine deck.
    profilePlate('swept carbon wing pedestal', [
      [.962, 1.984], [.962, 2.040], [1.085, 2.134], [1.086, 2.080],
    ], side * .40, .030, materials.carbon);
    box('rear wing deck gasket', [.11, .014, .11], [side * .40, .963, 2.009], materials.trim);
    box('rear wing pedestal fitting', [.045, .012, .056], [side * .40, 1.079, 2.109], materials.alloy);
  }

  // A short, low dorsal ridge follows only the last section of the engine deck.
  profilePlate('carbon center dorsal fin', [
    [1.076, 1.65], [1.163, 1.71], [1.106, 1.985],
    [.970, 1.985], [1.050, 1.73],
  ], 0, .018, materials.carbon);
  profilePlate('red dorsal fin upper edge', [
    [1.167, 1.710], [1.111, 1.985], [1.103, 1.985], [1.159, 1.710],
  ], 0, .022, materials.paint);

  // Keep the authored low stock spoiler as a deck lip beneath this assembly.
  // No imported material panel needs removal; all surrounding trim stays intact.
  body.userData.rearAero = 'Compact carbon spoiler / small rear fins';
  const bounds = new THREE.Box3().setFromObject(aero);
  let triangles = 0;
  aero.traverse(object => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });
  return { aero, bounds, triangles };
}
