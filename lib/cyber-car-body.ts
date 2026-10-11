import * as THREE from 'three';

type BodyMaterials = { paint: THREE.Material; carbon: THREE.Material; alloy: THREE.Material; amber: THREE.Material; glass: THREE.Material };

/** Closed, folded coupe skin with full doors and fitted wheel openings. */
export function addCyberBody(body: THREE.Group, m: BodyMaterials) {
  const rings = [
    [-2.56, .80, .255, .405, .507], [-2.18, .91, .235, .465, .625],
    [-1.44, 1.025, .235, .715, .895], [-.84, .974, .235, .715, .826],
    [-.25, .938, .235, .705, .813], [.58, .977, .235, .735, .858],
    [1.43, 1.045, .245, .755, .955], [2.05, .992, .255, .652, .858],
    [2.50, .942, .285, .544, .746],
  ];
  const profile = new THREE.CatmullRomCurve3(rings.map(r => new THREE.Vector3(r[1], r[3], r[4])), false, 'centripetal');
  const sample = (z: number) => {
    const lower = Math.max(0, Math.min(rings.length - 2, rings.findIndex((r, i) => i < rings.length - 1 && z <= rings[i + 1][0])));
    const fraction = THREE.MathUtils.clamp((z - rings[lower][0]) / (rings[lower + 1][0] - rings[lower][0]), 0, 1);
    const { x: w, y: belt, z: top } = profile.getPoint((lower + fraction) / (rings.length - 1));
    return { w, belt, top, bottom: THREE.MathUtils.lerp(rings[lower][2], rings[lower + 1][2], fraction) };
  };
  const wheelY = .385, archRadius = .426;
  // Sample the actual arch boundary instead of deleting faces by their centers.
  const stations = Array.from({ length: 145 }, (_, i) => THREE.MathUtils.lerp(-2.56, 2.50, i / 144));
  for (const axle of [-1.43, 1.43]) {
    stations.push(axle - archRadius - .001, axle + archRadius + .001);
    for (let i = 0; i <= 36; i++) stations.push(axle - archRadius * Math.cos(i * Math.PI / 36));
  }
  stations.sort((a, b) => a - b);
  const rows: THREE.Vector3[][] = [];
  for (const z of stations) {
    const { w, belt, top, bottom } = sample(z);
    const dz = Math.min(Math.abs(z - 1.43), Math.abs(z + 1.43));
    const opening = dz <= archRadius ? wheelY + Math.sqrt(Math.max(0, archRadius ** 2 - dz ** 2)) : bottom;
    rows.push([
      new THREE.Vector3(-w * .78, Math.max(bottom, opening), z), new THREE.Vector3(-w * .97, Math.max(bottom + .04, opening), z),
      new THREE.Vector3(-w, Math.max(belt, opening), z), new THREE.Vector3(-w * .957, top - .025, z),
      new THREE.Vector3(-w * .62, top, z), new THREE.Vector3(-w * .16, top - .012, z),
      new THREE.Vector3(w * .16, top - .012, z), new THREE.Vector3(w * .62, top, z),
      new THREE.Vector3(w * .957, top - .025, z), new THREE.Vector3(w, Math.max(belt, opening), z),
      new THREE.Vector3(w * .97, Math.max(bottom + .04, opening), z), new THREE.Vector3(w * .78, Math.max(bottom, opening), z),
    ]);
  }
  const spans = rows.length - 1;
  // Smooth longitudinal normals retain sharp folds across each separate panel band.
  for (let band = 0; band < 12; band++) {
    const vertices: number[] = [], uv: number[] = [], indices: number[] = [];
    for (const row of rows) for (const point of [row[band], row[(band + 1) % 12]]) {
      vertices.push(point.x, point.y, point.z); uv.push(point.z * .5, point.y);
    }
    for (let i = 0; i < spans; i++) {
      const a = i * 2, b = a + 2;
      const points = [rows[i][band], rows[i + 1][band], rows[i + 1][(band + 1) % 12], rows[i][(band + 1) % 12]];
      const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(.25);
      if (Math.abs(center.x) < .65 && center.y > .66 && center.z > -.82 && center.z < .79) continue;
      if (Math.abs(center.x) < .67 && center.y > .73 && center.z > 1.05 && center.z < 2.16) continue;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, m.paint); mesh.name = 'Cyber body / graphite folded skin'; body.add(mesh);
  }
  surface(body, rows[0], m.paint); surface(body, rows[spans], m.paint);

  const flank = (side: number, y: number, z: number, offset = .006) => {
    const { w, belt, top, bottom } = sample(z);
    const width = y <= belt
      ? THREE.MathUtils.lerp(w * .97, w, THREE.MathUtils.clamp((y - bottom - .04) / (belt - bottom - .04), 0, 1))
      : THREE.MathUtils.lerp(w, w * .957, THREE.MathUtils.clamp((y - belt) / (top - .025 - belt), 0, 1));
    return [side * (width + offset), y, z];
  };
  const sidePanel = (side: number, yz: number[][], material: THREE.Material, offset = .006) =>
    surface(body, yz.map(([y, z]) => flank(side, y, z, offset)), material, new THREE.Vector3(side, 0, 0));
  for (const side of [-1, 1]) {
    // Full-height door skin; a crease and a narrow perimeter seam articulate a solid panel.
    sidePanel(side, [[.327, -.91], [.744, -.91], [.803, -.62], [.822, .48], [.708, .58], [.35, .48]], m.paint, .010);
    sidePanel(side, [[.69, -.89], [.696, -.89], [.726, .52], [.72, .52]], m.alloy, .014);
    for (const z of [-.905, .49]) sidePanel(side, [[.345, z], [.743, z], [.746, z + .009], [.347, z + .009]], m.carbon, .015);
    sidePanel(side, [[.328, -.87], [.335, -.87], [.357, .475], [.350, .475]], m.carbon, .015);
    // A compact rear-quarter vent leaves most of the door painted and opaque.
    sidePanel(side, [[.385, .60], [.677, .60], [.746, .91], [.448, 1.005]], m.carbon, .016);
    sidePanel(side, [[.674, .58], [.692, .58], [.772, .92], [.744, .946]], m.paint, .025);
    for (let i = 0; i < 4; i++) {
      const y = .433 + i * .055;
      sidePanel(side, [[y, .64], [y + .009, .64], [y + .043, .90], [y + .029, .90]], m.alloy, .024);
    }
    // A continuous sill closes the space below each door.
    sidePanel(side, [[.244, -.96], [.301, -.94], [.322, .98], [.244, 1.01]], m.carbon, .012);
    sidePanel(side, [[.30, -.94], [.32, -.94], [.344, .92], [.322, .98]], m.paint, .019);
    for (const axle of [-1.43, 1.43]) {
      for (let i = 0; i < 36; i++) {
        const angles = [i, i + 1].map(step => step * Math.PI / 36);
        const arcPoint = (angle: number, radius: number, inset = 0) => {
          const z = axle - radius * Math.cos(angle);
          return [side * (sample(z).w + .009 - inset), wheelY + radius * Math.sin(angle), z];
        };
        surface(body, [arcPoint(angles[0], .416), arcPoint(angles[1], .416), arcPoint(angles[1], .447), arcPoint(angles[0], .447)], m.paint, new THREE.Vector3(side, 0, 0));
        // The dark return gives the arch thickness without exposing the cabin.
        const inward = new THREE.Vector3(0, -Math.sin((angles[0] + angles[1]) / 2), Math.cos((angles[0] + angles[1]) / 2));
        surface(body, [arcPoint(angles[0], .416), arcPoint(angles[0], .416, .16), arcPoint(angles[1], .416, .16), arcPoint(angles[1], .416)], m.carbon, inward);
      }
    }
  }

  // Carbon splitter and separated bumper pockets keep both live gun muzzles clear.
  surface(body, [[-.78, .252, -2.645], [.78, .252, -2.645], [1.01, .233, -2.22], [.93, .213, -2.12], [-.93, .213, -2.12], [-1.01, .233, -2.22]], m.carbon);
  surface(body, [[-.22, .305, -2.585], [.22, .305, -2.585], [.20, .449, -2.578], [-.20, .449, -2.578]], m.carbon);
  for (const side of [-1, 1]) {
    surface(body, [[side * .23, .325, -2.585], [side * .715, .325, -2.585], [side * .858, .461, -2.39], [side * .37, .46, -2.579]], m.carbon);
    surface(body, [[side * .785, .286, -2.4], [side * 1.014, .30, -2.18], [side * .965, .465, -2.20]], m.carbon);
    // Raised outer hood folds and thin black panel gutters catch reflected city lights.
    surface(body, [[side * .27, .536, -2.43], [side * .60, .553, -2.36], [side * .842, .779, -1.57], [side * .51, .856, -1.37], [side * .37, .775, -1.10]], m.paint);
    surface(body, [[side * .274, .545, -2.40], [side * .286, .55, -2.39], [side * .477, .853, -1.38], [side * .463, .854, -1.37]], m.carbon);
    for (let i = 0; i < 4; i++) {
      surface(body, [[side * .61, .825 - i * .008, -1.34 - i * .066], [side * .83, .8 - i * .008, -1.34 - i * .066], [side * .81, .79 - i * .008, -1.38 - i * .066], [side * .60, .815 - i * .008, -1.38 - i * .066]], m.carbon);
    }
    // Quarter buttresses connect the cabin to the wide rear wheel shoulders.
    surface(body, [[side * .56, 1.2, .56], [side * .67, 1.13, .79], [side * .96, .917, 1.40], [side * .825, .91, 1.60], [side * .69, 1.005, .89]], m.paint);
    surface(body, [[side * .585, 1.166, .63], [side * .681, 1.052, .9], [side * .837, .891, 1.47], [side * .713, .914, 1.17]], m.carbon);
    const stem = box(body, [.107, .022, .04], [side * .82, .933, -.46], m.carbon); stem.rotation.z = side * .2;
    const mirror = box(body, [.118, .045, .149], [side * .956, .948, -.43], m.paint); mirror.rotation.y = side * .18;
    box(body, [.087, .027, .005], [side * .956, .948, -.353], m.alloy);
    box(body, [.009, .014, .113], [side * .926, .752, .10], m.carbon);
    box(body, [.011, .018, .086], [side * .926, .759, .25], m.alloy);
  }

  // Slatted engine deck opens between the rear shoulders.
  surface(body, [[-.66, .854, 1.08], [.66, .854, 1.08], [.638, .763, 2.16], [-.638, .763, 2.16]], m.carbon);
  for (let i = 0; i < 9; i++) {
    const louver = box(body, [1.14 - i * .024, .019, .05], [0, .891 - i * .012, 1.13 + i * .112], m.paint);
    louver.rotation.x = -.10;
  }
  surface(body, [[-.975, .817, 2.04], [.975, .817, 2.04], [.94, .753, 2.50], [-.94, .753, 2.50]], m.paint);
  box(body, [1.82, .19, .027], [0, .652, 2.505], m.carbon);
  for (const side of [-1, 1]) {
    surface(body, [[side * .86, .75, 2.48], [side * .965, .756, 2.32], [side * 1.008, .746, 2.1], [side * 1.008, .548, 2.1], [side * .965, .548, 2.32], [side * .86, .553, 2.48]], m.carbon);
  }
  // Roof-height wing and long triangulated stanchions reproduce the reference rear silhouette.
  const wing = box(body, [2.035, .059, .448], [0, 1.316, 2.091], m.carbon); wing.rotation.x = -.035;
  surface(body, [[-1.018, 1.35, 1.866], [1.018, 1.35, 1.866], [1.018, 1.361, 2.294], [-1.018, 1.361, 2.294]], m.paint);
  for (const side of [-1, 1]) {
    verticalPlate(body, side * .754, .041, [[.425, 2.57], [.477, 2.56], [1.308, 2.014], [1.31, 1.907]], m.carbon);
    verticalPlate(body, side * .754, .029, [[.79, 1.908], [.828, 1.833], [1.297, 1.988], [1.302, 2.06]], m.alloy);
    verticalPlate(body, side * 1.013, .025, [[1.27, 1.89], [1.35, 1.85], [1.371, 2.29], [1.286, 2.333]], m.carbon);
    box(body, [.136, .045, .15], [side * .754, .432, 2.488], m.alloy);
    box(body, [.07, .037, .052], [side * .754, 1.281, 2.01], m.alloy);
  }
  // Mechanical diffuser leaves the existing exhaust mouths and boost flame axes clear.
  surface(body, [[-.94, .272, 2.60], [.94, .272, 2.60], [.8, .255, 1.92], [-.8, .255, 1.92]], m.carbon);
  box(body, [1.66, .149, .025], [0, .416, 2.488], m.carbon);
  for (const finX of [-.86, -.34, 0, .34, .86]) {
    verticalPlate(body, finX, .017, [[.218, 2.6], [.382, 2.55], [.301, 1.995], [.245, 1.955]], m.carbon);
  }
  for (const side of [-1, 1]) {
    box(body, [.077, .055, .08], [side * .405, .367, 2.456], m.alloy);
    const brace = box(body, [.025, .143, .022], [side * .352, .355, 2.483], m.alloy); brace.rotation.z = side * .35;
    verticalPlate(body, side * .955, .024, [[.26, 2.585], [.465, 2.535], [.53, 2.34], [.319, 2.29]], m.paint);
  }
  box(body, [.284, .066, .011], [0, .477, 2.528], m.alloy);
  for (let i = 0; i < 12; i++) box(body, [.026, .05, .016], [(i - 5.5) * .108, .523, 2.526], m.carbon);
}

/** Solid folded sheets share the existing paint/carbon batches. */
function surface(parent: THREE.Object3D, points: THREE.Vector3[] | number[][], material: THREE.Material, outward?: THREE.Vector3) {
  const p = points.map(point => point instanceof THREE.Vector3 ? point.clone() : new THREE.Vector3(...point as [number, number, number]));
  const center = p.reduce((sum, v) => sum.add(v), new THREE.Vector3()).multiplyScalar(1 / p.length);
  const normal = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]));
  const reverse = normal.dot(outward ?? center.clone().sub(new THREE.Vector3(0, .5, 0))) < 0;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (const point of p) { positions.push(point.x, point.y, point.z); uv.push(point.x * .5 + point.z * .3, point.y * .6 + point.z * .2); }
  // Flip winding without changing the fan diagonal on mirrored folded panels.
  for (let i = 1; i < p.length - 1; i++) indices.push(0, reverse ? i + 1 : i, reverse ? i : i + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); parent.add(mesh); return mesh;
}

/** Painted pillars and window sills make the canopy part of the body silhouette. */
export function addCyberCabin(body: THREE.Group, m: BodyMaterials) {
  for (const side of [-1, 1]) {
    const outside = [[side * .775, .851, -1.10], [side * .58, 1.272, -.28], [side * .57, 1.286, .61], [side * .78, .89, 1.02]];
    const window = [[side * .746, .888, -.95], [side * .562, 1.223, -.25], [side * .554, 1.237, .52], [side * .75, .915, .86]];
    const normal = new THREE.Vector3(side, .25, 0);
    const glass = surface(body, window, m.glass, normal);
    glass.name = 'Car / framed side window';
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      surface(body, [outside[edge], outside[next], window[next], window[edge]], m.paint, normal);
    }
    surface(body, [outside[0], outside[1], [side * .551, 1.249, -.294], [side * .732, .868, -1.086]], m.paint);
    surface(body, [outside[2], outside[3], [side * .744, .921, 1.024], [side * .551, 1.26, .626]], m.paint);
    surface(body, [[side * .59, 1.255, .36], [side * .60, 1.255, .406], [side * .769, .899, .71], [side * .768, .895, .665]], m.carbon, normal);
    // Wide shoulder bridges the outer door to the narrower cabin, with no daylight slit.
    const shoulder = [[side * .963, .806, -.91], [side * .946, .812, -.30], [side * .974, .855, .60], [side * 1.005, .899, 1.02]];
    const sill = (z: number) => new THREE.Vector3(...outside[0] as [number, number, number]).lerp(new THREE.Vector3(...outside[3] as [number, number, number]), (z + 1.10) / 2.12);
    for (let i = 0; i < shoulder.length - 1; i++) {
      surface(body, [new THREE.Vector3(...shoulder[i] as [number, number, number]), new THREE.Vector3(...shoulder[i + 1] as [number, number, number]), sill(shoulder[i + 1][2]), sill(shoulder[i][2])], m.paint, normal);
    }
    const handle = box(body, [.017, .019, .115], [side * .956, .767, .29], m.alloy);
    handle.name = 'Car / flush door handle';
  }
  surface(body, [[-.732, .868, -1.086], [.732, .868, -1.086], [.551, 1.249, -.294], [-.551, 1.249, -.294]], m.glass);
  surface(body, [[-.775, .851, -1.10], [.775, .851, -1.10], [.732, .868, -1.086], [-.732, .868, -1.086]], m.paint);
  surface(body, [[-.551, 1.249, -.294], [.551, 1.249, -.294], [.58, 1.272, -.28], [-.58, 1.272, -.28]], m.paint);
  surface(body, [[-.58, 1.272, -.28], [.58, 1.272, -.28], [.57, 1.286, .61], [-.57, 1.286, .61]], m.paint);
  const roof = box(body, [.88, .026, .70], [0, 1.288, .165], m.carbon);
  roof.name = 'Car / inset carbon roof';
  surface(body, [[-.551, 1.26, .626], [.551, 1.26, .626], [.744, .921, 1.024], [-.744, .921, 1.024]], m.glass);
  surface(body, [[-.57, 1.286, .61], [.57, 1.286, .61], [.551, 1.26, .626], [-.551, 1.26, .626]], m.paint);
  surface(body, [[-.744, .921, 1.024], [.744, .921, 1.024], [.775, .901, 1.069], [-.775, .901, 1.069]], m.paint);
}

function box(parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); parent.add(mesh); return mesh;
}

function verticalPlate(parent: THREE.Object3D, x: number, thickness: number, points: number[][], material: THREE.Material) {
  const shape = new THREE.Shape();
  points.forEach(([y, z], i) => { if (i === 0) shape.moveTo(-z, y); else shape.lineTo(-z, y); }); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 });
  const mesh = new THREE.Mesh(geometry, material); mesh.rotation.y = Math.PI / 2; mesh.position.x = x - thickness / 2; parent.add(mesh); return mesh;
}

/** The Chiron's full-width rear light is one animated draw call. */
export function addBugattiTailLights(body: THREE.Group, material: THREE.Material) {
  const light = box(body, [1.80, .016, .014], [0, .715, 2.548], material);
  light.name = 'Bugatti / continuous rear LED ribbon';
  return [light];
}

/** Author the repeating forged-wheel parts once, then reuse them on all four wheels. */
export function createBugattiWheelGeometries() {
  const spokes = [-1, 1].map(branch => {
    const shape = new THREE.Shape();
    const outline = [[.073, -.11], [.158, -.045], [.288, branch * .16 - .040], [.299, branch * .16 + .038], [.155, .055], [.074, .12]];
    outline.forEach(([radius, angle], i) => {
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth: .017, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: .0025, bevelThickness: .002 });
  });
  return {
    spokes,
    barrel: new THREE.CylinderGeometry(.298, .298, .17, 40, 1, true),
    rim: new THREE.TorusGeometry(.299, .008, 4, 40),
    innerRim: new THREE.RingGeometry(.284, .290, 36),
    hub: new THREE.CylinderGeometry(.079, .090, .028, 24),
    bolt: new THREE.CylinderGeometry(.006, .006, .007, 6),
    cap: new THREE.CircleGeometry(.038, 24),
  };
}

/** Five sculpted Y-spokes, polished lips and an EB hub expose the live ceramic brake. */
export function addBugattiWheelFace(wheel: THREE.Group, side: number, face: number, materials: { alloy: THREE.Material; carbon: THREE.Material; hub: THREE.Material }, geometries: ReturnType<typeof createBugattiWheelGeometries>) {
  const barrel = new THREE.Mesh(geometries.barrel, materials.carbon);
  barrel.rotation.z = Math.PI / 2; barrel.position.x = face - side * .080; wheel.add(barrel);
  for (const [geometry, offset] of [[geometries.rim, .015], [geometries.innerRim, .007]] as const) {
    const lip = new THREE.Mesh(geometry, materials.alloy);
    lip.rotation.y = side * Math.PI / 2; lip.position.x = face + side * offset; wheel.add(lip);
  }
  for (let pair = 0; pair < 5; pair++) for (const geometry of geometries.spokes) {
    const spoke = new THREE.Mesh(geometry, materials.alloy);
    spoke.rotation.set(0, side * Math.PI / 2, pair * Math.PI * 2 / 5);
    spoke.position.x = face; wheel.add(spoke);
  }
  const hub = new THREE.Mesh(geometries.hub, materials.alloy);
  hub.rotation.z = Math.PI / 2; hub.position.x = face + side * .015; wheel.add(hub);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    const bolt = new THREE.Mesh(geometries.bolt, materials.carbon);
    bolt.rotation.z = Math.PI / 2; bolt.position.set(face + side * .032, Math.cos(angle) * .056, Math.sin(angle) * .056); wheel.add(bolt);
  }
  const cap = new THREE.Mesh(geometries.cap, materials.hub);
  cap.rotation.y = side * Math.PI / 2; cap.position.x = face + side * .031;
  cap.name = 'Bugatti / EB wheel medallion'; wheel.add(cap);
}
