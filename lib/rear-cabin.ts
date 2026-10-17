import * as THREE from 'three';

type RearCabinMaterials = { leather: THREE.Material; dark: THREE.Material; metal: THREE.Material; orangeLeather: THREE.Material };

/** The rear glazing is a real cabin aperture, above the engine bulkhead. */
export function addRearCabin(cabin: THREE.Group, materials: RearCabinMaterials) {
  const rear = new THREE.Group(); rear.name = 'Bugatti cabin / rear window, pillars and parcel shelf'; cabin.add(rear);
  function add(name: string, geometry: THREE.BufferGeometry, material: THREE.Material) {
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `Bugatti cabin / ${name}`;
    Object.assign(mesh.userData, { cockpitDetail: true, noCastShadow: true, rearCabin: true }); rear.add(mesh); return mesh;
  }
  const outer = new THREE.Shape();
  outer.moveTo(-.60, .84); outer.lineTo(.60, .84); outer.lineTo(.53, 1.21); outer.lineTo(-.53, 1.21); outer.closePath();
  const aperture = new THREE.Path();
  aperture.moveTo(-.43, 1.015); aperture.lineTo(-.40, 1.18); aperture.lineTo(.40, 1.18); aperture.lineTo(.43, 1.015); aperture.closePath();
  outer.holes.push(aperture);
  const surround = add('leather rear glass surround and flying buttress returns',
    new THREE.ExtrudeGeometry(outer, { depth: .038, bevelEnabled: true, bevelSize: .006, bevelThickness: .006, bevelSegments: 2, steps: 1 }), materials.leather);
  surround.position.z = .716;
  const gasket = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-.43, 1.015, .708), new THREE.Vector3(-.40, 1.18, .708),
    new THREE.Vector3(.40, 1.18, .708), new THREE.Vector3(.43, 1.015, .708),
  ], true, 'centripetal', .1);
  add('rear window rubber seal', new THREE.TubeGeometry(gasket, 32, .005, 4, true), materials.dark);
  const windowShape = new THREE.Shape();
  windowShape.moveTo(-.43, 1.015); windowShape.lineTo(.43, 1.015); windowShape.lineTo(.40, 1.18); windowShape.lineTo(-.40, 1.18); windowShape.closePath();
  const glass = new THREE.MeshStandardMaterial({ name: 'Bugatti cabin / lightly smoked rear glazing', color: 0x84a4b5,
    transparent: true, opacity: .12, side: THREE.DoubleSide, depthWrite: false, roughness: .20, metalness: 0, envMapIntensity: .12 });
  glass.userData.cockpitDetail = true; glass.userData.noCastShadow = true;
  const rearGlass = add('transparent rear window glass', new THREE.ShapeGeometry(windowShape), glass); rearGlass.position.z = .738;
  const shelf = add('upholstered rear parcel shelf and engine bulkhead cap', new THREE.BoxGeometry(1.16, .038, .25), materials.dark);
  shelf.position.set(0, .852, .77);
  const seam = add('rear shelf orange leather seam', new THREE.BoxGeometry(1.04, .003, .006), materials.orangeLeather);
  seam.position.set(0, .874, .657);
  for (const side of [-1, 1]) {
    const shoulder = add('rear leather shoulder bolster', new THREE.BoxGeometry(.078, .19, .15), materials.leather);
    shoulder.position.set(side * .54, .93, .65); shoulder.rotation.z = side * -.10;
    const anchor = add('rear shoulder belt mounting bezel', new THREE.BoxGeometry(.026, .032, .012), materials.metal);
    anchor.position.set(side * .526, 1.005, .561);
  }
  return { rear, rearGlass };
}

type Vertex = { point: THREE.Vector3; values: number[] };

/**
 * The supplied exterior has a closed engine shell across its rear sightline.
 * Subtract only the actual window's viewing cone for the interior reflection;
 * all normal, exterior and side-mirror passes keep their original geometry.
 */
export function prepareRearviewOpening(body: THREE.Object3D, origin: THREE.Vector3) {
  const corners = [new THREE.Vector3(-.43, 1.015, .738), new THREE.Vector3(.43, 1.015, .738),
    new THREE.Vector3(.40, 1.18, .738), new THREE.Vector3(-.40, 1.18, .738)];
  const middle = new THREE.Vector3(0, 1.10, .738);
  const planes = corners.map((corner, index) => {
    const plane = new THREE.Plane().setFromCoplanarPoints(origin, corner, corners[(index + 1) % corners.length]);
    if (plane.distanceToPoint(middle) < 0) plane.negate();
    return plane;
  });
  // Start behind the headrests, before the authored engine-cover front lip.
  planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -.56));
  body.updateWorldMatrix(true, true);
  const inverse = body.matrixWorld.clone().invert(), matrix = new THREE.Matrix4();
  const swaps: { mesh: THREE.Mesh; original: THREE.BufferGeometry; interior: THREE.BufferGeometry }[] = [];
  body.traverse(object => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material) || object.userData.cockpitDetail || object.material.userData.cockpitDetail) return;
    const source = object.geometry as THREE.BufferGeometry, position = source.getAttribute('position');
    if (!position || !source.index) return;
    matrix.multiplyMatrices(inverse, object.matrixWorld);
    source.computeBoundingBox();
    const bounds = source.boundingBox!.clone().applyMatrix4(matrix);
    if (bounds.max.z < .56 || bounds.max.y < .84 || bounds.min.y > 1.34) return;
    const attributes = Object.entries(source.attributes), offsets: number[] = [];
    let stride = 0;
    for (const [, attribute] of attributes) { offsets.push(stride); stride += attribute.itemSize; }
    const vertex = (index: number): Vertex => {
      const values: number[] = [];
      for (const [, attribute] of attributes) for (let component = 0; component < attribute.itemSize; component++) values.push(attribute.getComponent(index, component));
      return { point: new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix), values };
    };
    const append: Vertex[] = [], retained: number[] = [];
    let changed = false;
    for (let triangle = 0; triangle < source.index.count; triangle += 3) {
      const indices = [source.index.getX(triangle), source.index.getX(triangle + 1), source.index.getX(triangle + 2)];
      const original = indices.map(vertex);
      if (planes.some(plane => original.every(v => plane.distanceToPoint(v.point) < -1e-7))) { retained.push(...indices); continue; }
      let inside = original;
      const fragments: Vertex[][] = [];
      for (const plane of planes) {
        const inner: Vertex[] = [], outer: Vertex[] = [];
        for (let i = 0; i < inside.length; i++) {
          const a = inside[i], b = inside[(i + 1) % inside.length];
          const da = plane.distanceToPoint(a.point), db = plane.distanceToPoint(b.point);
          (da >= 0 ? inner : outer).push(a);
          if ((da >= 0) !== (db >= 0)) {
            const t = da / (da - db);
            const cut = { point: a.point.clone().lerp(b.point, t), values: a.values.map((value, j) => THREE.MathUtils.lerp(value, b.values[j], t)) };
            inner.push(cut); outer.push(cut);
          }
        }
        if (outer.length >= 3) fragments.push(outer);
        inside = inner;
        if (!inside.length) break;
      }
      if (inside.length < 3) { retained.push(...indices); continue; }
      changed = true;
      for (const polygon of fragments) for (let i = 1; i < polygon.length - 1; i++) append.push(polygon[0], polygon[i], polygon[i + 1]);
    }
    if (!changed) return;
    const geometry = source.clone();
    for (const [attributeIndex, [name, attribute]] of attributes.entries()) {
      const values = new Float32Array((position.count + append.length) * attribute.itemSize);
      for (let i = 0; i < position.count; i++) for (let component = 0; component < attribute.itemSize; component++) values[i * attribute.itemSize + component] = attribute.getComponent(i, component);
      for (const [i, v] of append.entries()) for (let component = 0; component < attribute.itemSize; component++) values[(position.count + i) * attribute.itemSize + component] = v.values[offsets[attributeIndex] + component];
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
    for (let i = 0; i < append.length; i++) retained.push(position.count + i);
    geometry.setIndex(retained); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    swaps.push({ mesh: object, original: source, interior: geometry });
  });
  return {
    swaps,
    begin() { for (const swap of swaps) swap.mesh.geometry = swap.interior; },
    restore() { for (const swap of swaps) swap.mesh.geometry = swap.original; },
    dispose() { for (const swap of swaps) { swap.mesh.geometry = swap.original; swap.interior.dispose(); } },
  };
}
