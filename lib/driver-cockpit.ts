import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { batchArchitecture } from './cinematic-city';
import { makeBugattiInstruments, makeCabinDetailAtlas, makeCabinLeather, type CabinInstruments } from './bugatti-cabin-textures';

type CabinMaterials = { carbon: THREE.Material; alloy: THREE.Material; cyan: THREE.Material };
type Point = [number, number, number];

/** Rounded upholstery with analytical edge normals and a small vertex budget. */
function upholsteredGeometry(size: Point, radius: number) {
  const geometry = new THREE.BoxGeometry(...size, 2, 2, 2);
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const half = new THREE.Vector3(...size).multiplyScalar(.5);
  const r = Math.min(radius, half.x * .8, half.y * .8, half.z * .8);
  const inner = half.clone().addScalar(-r), lower = inner.clone().negate();
  const p = new THREE.Vector3(), closest = new THREE.Vector3(), direction = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i); closest.copy(p).clamp(lower, inner);
    direction.copy(p).sub(closest).normalize(); p.copy(closest).addScaledVector(direction, r);
    position.setXYZ(i, p.x, p.y, p.z); normal.setXYZ(i, direction.x, direction.y, direction.z);
  }
  return geometry;
}

/** Built once; only the steering assembly and instrument texture change while driving. */
export function addDriverCockpit(body: THREE.Group, materials: CabinMaterials) {
  const leatherMap = makeCabinLeather(), quiltingMap = makeCabinLeather(true);
  const detailAtlas = makeCabinDetailAtlas(), instruments = makeBugattiInstruments();
  const leather = new THREE.MeshStandardMaterial({ color: 0x25262a, map: leatherMap, bumpMap: leatherMap, bumpScale: .00055,
    roughness: .83, metalness: .025, emissive: 0x141414, emissiveIntensity: .23, envMapIntensity: .6 });
  leather.name = 'Bugatti cabin / fine grained black leather';
  // The reference uses orange hide framed by black bolsters. Reuse the grain
  // as a bump map so its gray albedo does not muddy the saturated upholstery.
  const orangeLeather = leather.clone(); orangeLeather.map = null;
  orangeLeather.color.setHex(0xe16c16); orangeLeather.emissive.setHex(0x6c2705);
  orangeLeather.emissiveIntensity = .14; orangeLeather.roughness = .76;
  orangeLeather.name = 'Bugatti cabin / burnt orange leather inserts';
  const quilting = orangeLeather.clone(); quilting.bumpMap = quiltingMap;
  quilting.bumpScale = .0022; quilting.name = 'Bugatti cabin / orange diamond stitched leather';
  const metal = new THREE.MeshStandardMaterial({ color: 0xb7c0c8, metalness: .83, roughness: .42, envMapIntensity: .55 });
  metal.name = 'Bugatti cabin / brushed aluminum';
  const dark = new THREE.MeshStandardMaterial({ color: 0x161c23, metalness: .25, roughness: .45, emissive: 0x101721, emissiveIntensity: .14 });
  dark.name = 'Bugatti cabin / satin control recesses';
  // Keep the authored weave and micro bump, with a single matte PBR layer.
  // The close console fills many pixels; an extra exterior lacquer layer here
  // costs more than its subtle highlight contributes to the cabin.
  const carbon = materials.carbon instanceof THREE.MeshStandardMaterial
    ? new THREE.MeshStandardMaterial({ color: materials.carbon.color, map: materials.carbon.map,
      bumpMap: materials.carbon.bumpMap, bumpScale: materials.carbon.bumpScale,
      metalness: materials.carbon.metalness, roughness: .46, side: materials.carbon.side, envMapIntensity: .62 })
    : materials.carbon.clone();
  carbon.name = 'Bugatti cabin / resin coated carbon trim';
  const piping = new THREE.MeshStandardMaterial({ color: 0x9c4b16, roughness: .76 });
  piping.name = 'Bugatti cabin / subtle orange seam piping';
  const lit = new THREE.MeshBasicMaterial({ color: 0x617383, toneMapped: false });
  lit.name = 'Bugatti cabin / softly illuminated switch legends';
  const labels = new THREE.MeshStandardMaterial({ map: detailAtlas, alphaTest: .4, roughness: .44, metalness: .32, emissive: 0x2a3035, emissiveIntensity: .15 });
  labels.name = 'Bugatti cabin / engraved badges and controls';
  const dialMaterial = new THREE.MeshBasicMaterial({ map: instruments.map, alphaTest: .35, toneMapped: false });
  dialMaterial.name = 'Bugatti cabin / live analog instruments';
  for (const material of [leather, orangeLeather, quilting, metal, dark, carbon, piping, lit, labels, dialMaterial, materials.cyan]) {
    material.userData.cockpitDetail = true; material.userData.noCastShadow = true;
  }
  const cabin = new THREE.Group(); cabin.name = 'Bugatti / sculpted leather and aluminum cabin'; body.add(cabin);
  const frontCabin = new THREE.Group();
  frontCabin.name = 'Bugatti cabin / dashboard and driving controls';
  frontCabin.position.z = -.30; cabin.add(frontCabin);
  function add(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, material: THREE.Material, position: Point = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `Bugatti cabin / ${name}`;
    mesh.position.set(...position); mesh.userData.cockpitDetail = true; parent.add(mesh); return mesh;
  }
  function box(parent: THREE.Object3D, size: Point, position: Point, material: THREE.Material = dark) {
    return add(parent, 'fitted trim', new THREE.BoxGeometry(...size), material, position);
  }
  function soft(parent: THREE.Object3D, name: string, size: Point, position: Point, material: THREE.Material = leather, radius = .022) {
    return add(parent, name, upholsteredGeometry(size, radius), material, position);
  }
  function tube(parent: THREE.Object3D, name: string, points: Point[], radius: number, material: THREE.Material, segments = 12, sides = 4, capped = false, endRadius = radius) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    const sweep = new THREE.TubeGeometry(curve, segments, radius, sides, false);
    let geometry: THREE.BufferGeometry = sweep;
    if (endRadius !== radius) {
      const position = sweep.getAttribute('position'), normal = sweep.getAttribute('normal');
      const vertex = new THREE.Vector3(), outward = new THREE.Vector3();
      const taperStart = .84, length = curve.getLength();
      for (let row = 0; row <= segments; row++) {
        const t = row / segments, u = THREE.MathUtils.clamp((t - taperStart) / (1 - taperStart), 0, 1);
        const scale = THREE.MathUtils.lerp(radius, endRadius, u * u * (3 - 2 * u)) / radius;
        const slope = (endRadius - radius) * 6 * u * (1 - u) / ((1 - taperStart) * length);
        const center = curve.getPointAt(t);
        for (let side = 0; side <= sides; side++) {
          const index = row * (sides + 1) + side;
          vertex.fromBufferAttribute(position, index).sub(center).multiplyScalar(scale).add(center);
          position.setXYZ(index, vertex.x, vertex.y, vertex.z);
          outward.fromBufferAttribute(normal, index).addScaledVector(sweep.tangents[row], -slope).normalize();
          normal.setXYZ(index, outward.x, outward.y, outward.z);
        }
      }
    }
    if (capped) {
      const caps = [0, 1].map(end => {
        const cap = new THREE.CircleGeometry(end === 0 ? radius : endRadius, sides);
        const ring = end * segments, direction = end === 0 ? -1 : 1;
        // Use the sweep's frame so the polygonal cap meets every rim vertex.
        cap.applyMatrix4(new THREE.Matrix4().makeBasis(sweep.normals[ring],
          sweep.binormals[ring].clone().multiplyScalar(direction), sweep.tangents[ring].clone().multiplyScalar(direction)));
        const center = curve.getPointAt(end); cap.translate(center.x, center.y, center.z);
        return cap;
      });
      const closed = mergeGeometries([geometry, ...caps]);
      caps.forEach(cap => cap.dispose());
      if (closed) { geometry.dispose(); geometry = closed; }
    }
    return add(parent, name, geometry, material);
  }
  function ring(parent: THREE.Object3D, name: string, radius: number, thickness: number, position: Point, material: THREE.Material = metal, segments = 24) {
    return add(parent, name, new THREE.RingGeometry(radius - thickness, radius, segments), material, position);
  }
  function disc(parent: THREE.Object3D, name: string, radius: number, position: Point, material: THREE.Material = dark, segments = 20) {
    return add(parent, name, new THREE.CircleGeometry(radius, segments), material, position);
  }
  function detail(parent: THREE.Object3D, name: string, size: [number, number], position: Point, region: [number, number, number, number]) {
    const geometry = new THREE.PlaneGeometry(...size), uv = geometry.getAttribute('uv');
    const [x, y, width, height] = region;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * width) / 1024, 1 - (y + (1 - uv.getY(i)) * height) / 512);
    return add(parent, name, geometry, labels, position);
  }

  // Continuous crowned dash rolls into the instrument hood and passenger cowl.
  const section: [number, number][] = [[.60, -.56], [.75, -.52], [.84, -.55], [.89, -.65], [.87, -.82], [.78, -.91], [.60, -.77]];
  section.reverse();
  const spans = [-.68, -.58, -.47, -.32, -.17, 0, .22, .47, .60, .68];
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (const x of spans) {
    const hood = .045 * Math.exp(-(((x + .32) / .22) ** 2)) + .024 * Math.exp(-(((x - .35) / .27) ** 2));
    for (const [y, z] of section) {
      positions.push(x, y + hood * THREE.MathUtils.smoothstep(y, .75, .89), z + .055 * (Math.abs(x) / .68) ** 2);
      uv.push((x + .68) * 1.2, (z + .91) * 2);
    }
  }
  for (let i = 0; i < spans.length - 1; i++) for (let j = 0; j < section.length; j++) {
    const a = i * section.length + j, b = i * section.length + (j + 1) % section.length;
    indices.push(a, b, b + section.length, a, b + section.length, a + section.length);
  }
  const caps = THREE.ShapeUtils.triangulateShape(section.map(([y, z]) => new THREE.Vector2(y, z)), []);
  for (const [a, b, c] of caps) {
    indices.push(c, b, a);
    const end = (spans.length - 1) * section.length; indices.push(end + a, end + b, end + c);
  }
  const dashGeometry = new THREE.BufferGeometry();
  dashGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  dashGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); dashGeometry.setIndex(indices); dashGeometry.computeVertexNormals();
  add(frontCabin, 'continuous sculpted dashboard', dashGeometry, leather);
  // Fine seams trace the dash crown and instrument hood. They merge with the
  // existing piping draw rather than creating a draw for each stitch.
  for (const inset of [0, .007]) tube(frontCabin, 'dashboard crown double stitching', [
    [-.62, .879, -.635 - inset], [-.48, .925, -.638 - inset], [-.32, .937, -.648 - inset],
    [-.16, .923, -.638 - inset], [0, .892, -.632 - inset], [.28, .905, -.630 - inset], [.60, .878, -.609 - inset],
  ], .0012, piping, 28, 3);

  // Join the dash to the curved lower windshield instead of leaving the
  // exterior shell and wiper hardware exposed through an open scuttle.
  const cowlPositions: number[] = [], cowlUv: number[] = [], cowlIndices: number[] = [];
  const cowlColumns = 20, cowlRows = 5;
  for (let row = 0; row <= cowlRows; row++) {
    const t = row / cowlRows;
    for (let column = 0; column <= cowlColumns; column++) {
      const x = (column / cowlColumns * 2 - 1) * .69;
      const shoulder = (Math.abs(x) / .69) ** 2;
      cowlPositions.push(x, THREE.MathUtils.lerp(.875, .916 + .035 * shoulder, t),
        THREE.MathUtils.lerp(-1.11 + .135 * shoulder, -1.365 + .39 * shoulder, t));
      cowlUv.push(column / cowlColumns * 1.4, t * .55);
    }
  }
  for (let row = 0; row < cowlRows; row++) for (let column = 0; column < cowlColumns; column++) {
    const a = row * (cowlColumns + 1) + column, b = a + cowlColumns + 1;
    cowlIndices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const cowlGeometry = new THREE.BufferGeometry();
  cowlGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cowlPositions, 3));
  cowlGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(cowlUv, 2));
  cowlGeometry.setIndex(cowlIndices); cowlGeometry.computeVertexNormals();
  add(cabin, 'fitted windshield dashboard cowl', cowlGeometry, leather);
  const lowerSeal: Point[] = Array.from({ length: 21 }, (_, i) => {
    const x = (i / 20 * 2 - 1) * .69, shoulder = (Math.abs(x) / .69) ** 2;
    return [x, .918 + .035 * shoulder, -1.361 + .39 * shoulder];
  });
  tube(cabin, 'lower windshield rubber seal', lowerSeal, .006, dark, 24, 5);
  // Closed pillar ends and a shared header endpoint prevent a hollow notch
  // where the thicker A-pillars meet the inner roof on either side.
  const pillarRoofJoinY = 1.210, pillarRoofJoinZ = -.496;
  for (const side of [-1, 1]) {
    tube(cabin, 'upholstered front windshield pillar', [
      [side * .69, .950, -.971], [side * .649, 1.048, -.802],
      [side * .605, 1.146, -.588], [side * .570, pillarRoofJoinY, pillarRoofJoinZ],
      [side * .555, 1.224, -.457],
    ], .036, leather, 16, 8, true, .006);
    tube(cabin, 'windshield pillar rubber gasket', [
      [side * .676, .951, -.978], [side * .635, 1.048, -.806],
      [side * .591, 1.146, -.592], [side * .558, pillarRoofJoinY, pillarRoofJoinZ - .008],
    ], .004, dark, 14, 4, true);
    const demister = box(cabin, [.192, .004, .030], [side * .38, .906, -1.051], dark);
    demister.rotation.y = side * -.17;
    for (let slot = 0; slot < 7; slot++) {
      box(cabin, [.003, .003, .025], [side * .38 + (slot - 3) * .021, .909, -1.051], carbon);
    }
  }
  tube(cabin, 'leather windshield header', [
    [-.570, pillarRoofJoinY, pillarRoofJoinZ], [-.32, 1.230, -.501], [0, 1.235, -.505],
    [.32, 1.230, -.501], [.570, pillarRoofJoinY, pillarRoofJoinZ],
  ], .017, leather, 18, 6, true);

  const shadeCanvas = document.createElement('canvas'); shadeCanvas.width = 4; shadeCanvas.height = 64;
  const shadeContext = shadeCanvas.getContext('2d')!;
  const shadeGradient = shadeContext.createLinearGradient(0, 0, 0, 64);
  shadeGradient.addColorStop(0, 'rgba(12, 27, 35, .9)');
  shadeGradient.addColorStop(.45, 'rgba(15, 34, 44, .3)');
  shadeGradient.addColorStop(1, 'rgba(15, 34, 44, 0)');
  shadeContext.fillStyle = shadeGradient; shadeContext.fillRect(0, 0, 4, 64);
  const shadeMap = new THREE.CanvasTexture(shadeCanvas); shadeMap.colorSpace = THREE.SRGBColorSpace;
  const shadeMaterial = new THREE.MeshBasicMaterial({ map: shadeMap, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  shadeMaterial.name = 'Bugatti cabin / graduated windshield sun strip';
  shadeMaterial.userData.cockpitDetail = true; shadeMaterial.userData.noCastShadow = true;
  const shadePositions: number[] = [], shadeUv: number[] = [], shadeIndices: number[] = [];
  for (let row = 0; row < 2; row++) for (let column = 0; column <= 16; column++) {
    const x = (column / 16 * 2 - 1) * (.557 + row * .014), shoulder = (Math.abs(x) / .571) ** 2;
    shadePositions.push(x, 1.228 - .029 * shoulder - row * .042, -.532 + .018 * shoulder - row * .104);
    shadeUv.push(column / 16, 1 - row);
  }
  for (let column = 0; column < 16; column++) shadeIndices.push(column, column + 1, column + 17, column + 1, column + 18, column + 17);
  const shadeGeometry = new THREE.BufferGeometry();
  shadeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(shadePositions, 3));
  shadeGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(shadeUv, 2));
  shadeGeometry.setIndex(shadeIndices); shadeGeometry.computeVertexNormals();
  add(cabin, 'windshield graduated tint band', shadeGeometry, shadeMaterial);

  // A real inner roof closes the outward-facing shell above the windshield.
  const roofSections = [[-.505, 1.232, .57], [-.20, 1.240, .58], [.20, 1.235, .58], [.55, 1.211, .565], [.76, 1.175, .55]];
  const roofPositions: number[] = [], roofUv: number[] = [], roofIndices: number[] = [];
  const roofColumns = 12;
  for (const [z, y, width] of roofSections) for (let column = 0; column <= roofColumns; column++) {
    const t = column / roofColumns * 2 - 1;
    roofPositions.push(t * width, y - .028 * t * t, z); roofUv.push(column / roofColumns, z + .505);
  }
  for (let row = 0; row < roofSections.length - 1; row++) for (let column = 0; column < roofColumns; column++) {
    const a = row * (roofColumns + 1) + column, b = a + roofColumns + 1;
    roofIndices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const roofGeometry = new THREE.BufferGeometry();
  roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
  roofGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(roofUv, 2));
  roofGeometry.setIndex(roofIndices); roofGeometry.computeVertexNormals();
  add(cabin, 'contoured leather roof headliner', roofGeometry, leather);
  for (const side of [-1, 1]) soft(cabin, 'folded leather sun visor', [.30, .018, .12], [side * .30, 1.215, -.385], leather, .007);

  const mirrorGlass = new THREE.MeshStandardMaterial({ color: 0x7e929e, metalness: 1, roughness: .055, envMapIntensity: .85 });
  mirrorGlass.name = 'Bugatti cabin / reflective rearview mirror';
  mirrorGlass.userData.cockpitDetail = true; mirrorGlass.userData.noCastShadow = true;
  box(cabin, [.012, .028, .012], [0, 1.219, -.568], dark);
  soft(cabin, 'rearview mirror housing', [.162, .045, .018], [0, 1.191, -.574], dark, .008);
  soft(cabin, 'rearview mirror reflective insert', [.147, .031, .003], [0, 1.191, -.563], mirrorGlass, .005);
  soft(frontCabin, 'passenger leather cowl', [.48, .145, .18], [.36, .797, -.575], leather, .04);
  tube(frontCabin, 'passenger dashboard double seam', [[.13, .858, -.477], [.31, .86, -.470], [.52, .839, -.47], [.60, .815, -.46]], .0017, piping, 10, 3);
  detail(frontCabin, 'passenger Bugatti signature', [.122, .032], [.345, .801, -.480], [512, 0, 512, 128]);
  soft(frontCabin, 'glove box lid', [.47, .125, .024], [.36, .674, -.50], leather, .015);
  box(frontCabin, [.06, .008, .009], [.36, .702, -.482], metal);
  box(frontCabin, [1.22, .023, .029], [0, .722, -.492], carbon);

  // Tall outer vents flank the leather dash; the center belongs to the Chiron spine.
  for (const [x, y, z, r] of [[-.60, .804, -.492, .030], [.61, .798, -.469, .030]]) {
    const vent = new THREE.Group(); vent.position.set(x, y, z); vent.scale.y = 1.5; frontCabin.add(vent);
    disc(vent, 'recessed air vent', r, [0, 0, 0], dark);
    ring(vent, 'machined vent bezel', r + .004, .004, [0, 0, .002]);
    for (let i = -2; i <= 2; i++) {
      const width = 2 * Math.sqrt(r * r - (i * r * .31) ** 2) * .83;
      box(vent, [width, .002, .008], [0, i * r * .31, .004], metal);
    }
    box(vent, [.008, .018, .007], [0, 0, .009], dark);
  }

  // Central analog speedometer with two compact blue digital side displays.
  const binnacle = disc(frontCabin, 'elliptical instrument recess', 1, [-.32, .868, -.558], dark, 32); binnacle.scale.set(.238, .107, 1);
  const hood = add(frontCabin, 'curved leather instrument hood', new THREE.SphereGeometry(1, 16, 6, Math.PI, Math.PI, 0, Math.PI / 2), leather, [-.32, .860, -.559]);
  hood.scale.set(.242, .110, .148);
  const display = add(frontCabin, 'live analog instrument faces', new THREE.PlaneGeometry(.444, .222), dialMaterial, [-.32, .889, -.553]);
  ring(frontCabin, 'central speedometer aluminum surround', .079, .0028, [-.32, .885, -.551]);
  display.userData.dynamic = true;

  // The reference's continuous curved carbon spine sweeps down into the tunnel.
  // Its four machined rotary controls sit in a single vertical row.
  const spineProfile: Point[] = [[.066, .914, -.574], [.038, .856, -.469], [.018, .786, -.391],
    [0, .716, -.304], [0, .654, -.184], [0, .641, -.040], [0, .654, .060]];
  const spineVertices: number[] = [], spineUV: number[] = [], spineIndex: number[] = [];
  const widths = [.185, .154, .128, .111, .109, .099, .092];
  for (let row = 0; row < spineProfile.length; row++) {
    const [x, y, z] = spineProfile[row];
    for (const side of [-1, 1]) { spineVertices.push(x + side * widths[row], y, z); spineUV.push(side < 0 ? 0 : 1, row / 3); }
    if (row < spineProfile.length - 1) { const i = row * 2; spineIndex.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  }
  const spineGeometry = new THREE.BufferGeometry();
  spineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(spineVertices, 3));
  spineGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(spineUV, 2));
  spineGeometry.setIndex(spineIndex); spineGeometry.computeVertexNormals();
  add(frontCabin, 'continuous curved carbon center spine', spineGeometry, carbon);
  for (const side of [-1, 1]) {
    const edge = spineProfile.map(([x, y, z], row): Point => [x + side * widths[row], y + .001, z]);
    tube(frontCabin, 'center spine brushed aluminum edge', edge, .003, metal, 20, 4);
    tube(frontCabin, 'center spine contrast stitching', edge.map(([x, y, z]): Point => [x - side * .007, y + .002, z]), .0013, piping, 20, 3);
  }
  for (const [index, [x, y, z]] of [[.045, .862, -.456], [.025, .797, -.389], [.010, .735, -.319], [0, .676, -.224]].entries()) {
    const control = new THREE.Group(); control.position.set(x, y, z); control.rotation.x = -.76; frontCabin.add(control);
    const barrel = add(control, 'machined rotary control barrel', new THREE.CylinderGeometry(.022, .024, .022, 16), metal, [0, 0, .004]);
    barrel.rotation.x = Math.PI / 2;
    disc(control, 'climate rotary dial', .018, [0, 0, .018], dark, 16);
    ring(control, 'knurled climate knob edge', .024, .003, [0, 0, .018], metal, 16);
    ring(control, 'climate knob illuminated collar', .017, .0004, [0, 0, .019], lit, 16);
    detail(control, 'rotary control temperature and mode legend', [.025, .013], [0, 0, .020], [index * 128, 352, 128, 32]);
  }
  soft(frontCabin, 'leather transmission tunnel', [.216, .162, .82], [0, .541, .00], leather, .035);
  soft(frontCabin, 'brushed gear selector surround', [.146, .025, .277], [0, .631, -.077], metal, .009);
  soft(frontCabin, 'selector carbon inset', [.111, .014, .236], [0, .648, -.080], carbon, .005);
  const shiftBoot = add(frontCabin, 'stitched selector boot', new THREE.CylinderGeometry(.024, .039, .047, 12), leather, [0, .675, -.066]); shiftBoot.rotation.x = -.11;
  const shiftStem = add(frontCabin, 'polished selector stem', new THREE.CylinderGeometry(.010, .014, .072, 10), metal, [0, .721, -.071]); shiftStem.rotation.x = -.10;
  const knob = add(frontCabin, 'leather and aluminum selector knob', new THREE.SphereGeometry(1, 12, 8), leather, [0, .760, -.075]); knob.scale.set(.025, .035, .024);
  box(frontCabin, [.009, .028, .008], [0, .766, -.051], metal);
  const gearLegend = detail(frontCabin, 'gear position engraving', [.092, .028], [0, .658, -.171], [512, 352, 512, 68]); gearLegend.rotation.x = -Math.PI / 2;
  soft(frontCabin, 'orange leather center armrest', [.185, .075, .315], [0, .638, .237], orangeLeather, .025);
  box(frontCabin, [.0016, .0016, .259], [0, .677, .238], piping);

  // Contoured diamond-quilted seats, bolsters and integrated headrests.
  for (const side of [-1, 1]) {
    const seat = new THREE.Group(); seat.position.x = side * .32; cabin.add(seat);
    soft(seat, 'sculpted seat base', [.364, .075, .490], [0, .477, .137], leather, .022);
    soft(seat, 'diamond quilted seat cushion', [.245, .032, .370], [0, .520, .107], quilting, .013);
    for (const edge of [-1, 1]) {
      const bolster = soft(seat, 'raised seat side bolster', [.060, .088, .420], [edge * .143, .517, .127], leather, .020); bolster.rotation.z = -edge * .10;
      box(seat, [.002, .002, .349], [edge * .109, .538, .109], piping);
    }
    const back = new THREE.Group(); back.position.set(0, .733, .397); back.rotation.x = .20; seat.add(back);
    soft(back, 'contoured leather seat back', [.345, .398, .080], [0, 0, 0], leather, .023);
    soft(back, 'diamond quilted back insert', [.230, .315, .027], [0, .015, -.052], quilting, .011);
    for (const edge of [-1, 1]) {
      soft(back, 'seat back side bolster', [.055, .338, .072], [edge * .14, 0, -.043], leather, .022);
      box(back, [.002, .305, .002], [edge * .108, .018, -.068], piping);
    }
    soft(back, 'integrated orange leather headrest', [.216, .129, .073], [0, .257, -.005], orangeLeather, .024);
    const crest = detail(back, 'headrest EB crest', [.042, .042], [0, .255, -.043], [0, 0, 256, 256]); crest.rotation.y = Math.PI;
    box(seat, [.034, .049, .038], [-side * .190, .481, .261], dark);
    box(seat, [.020, .009, .025], [-side * .190, .508, .261], piping);
  }

  // The moving driver's door carries its fitted authored lining and controls.
  // Adding another inner card here makes it float above that complete lining.
  for (const side of [1]) {
    const doorTrim = new THREE.Group();
    doorTrim.name = 'Bugatti cabin / passenger door trim';
    cabin.add(doorTrim);
    soft(doorTrim, 'leather door card', [.039, .296, .882], [side * .675, .703, .006], leather, .015);
    soft(doorTrim, 'orange leather door insert', [.012, .117, .414], [side * .651, .763, -.095], orangeLeather, .004);
    soft(doorTrim, 'orange padded door armrest', [.081, .053, .351], [side * .627, .670, .067], orangeLeather, .019);
    tube(doorTrim, 'curved aluminum door pull', [[side * .636, .802, -.203], [side * .622, .791, -.128], [side * .614, .697, .015], [side * .622, .654, .070]], .010, metal, 12, 4);
    tube(doorTrim, 'door stitching and ambient piping', [[side * .644, .835, -.385], [side * .644, .835, -.16], [side * .642, .813, .19], [side * .642, .735, .348]], .0018, piping, 10, 3);
    const handle = ring(doorTrim, 'oval metal door release', .024, .004, [side * .636, .772, -.279], metal, 16); handle.rotation.y = -side * Math.PI / 2; handle.scale.x = 1.45;
    for (let i = 0; i < 2; i++) box(doorTrim, [.029, .006, .014], [side * .612, .699, -.030 + i * .025], dark);
    box(doorTrim, [.035, .045, .366], [side * .661, .560, .164], dark);
  }
  // A closed cabin tub joins the dash, door sills and seat platform. The old
  // narrow floor stopped short of the door lining and left the road visible
  // beside the seats and beyond the pedals. Overlap the solid returns so the
  // dropped footwell remains sealed even while the body pitches over the road.
  const carpet = new THREE.MeshStandardMaterial({ name: 'Bugatti / charcoal footwell carpet', color: 0x101214, roughness: .98 });
  carpet.userData.cockpitDetail = true; carpet.userData.noCastShadow = true;
  add(cabin, 'continuous sealed carpet floor pan', new THREE.BoxGeometry(1.44, .042, 1.92), carpet, [0, .242, -.16]);
  add(cabin, 'raised seat platform', new THREE.BoxGeometry(1.44, .031, .85), dark, [0, .422, .375]);
  add(cabin, 'closed footwell step riser', new THREE.BoxGeometry(1.44, .194, .036), dark, [0, .340, -.030]);
  add(cabin, 'front footwell firewall', new THREE.BoxGeometry(1.44, .597, .040), carpet, [0, .5415, -1.103]);
  add(cabin, 'lower rear cabin bulkhead', new THREE.BoxGeometry(1.44, .55, .042), dark, [0, .515, .781]);
  for (const side of [-1, 1]) {
    add(cabin, 'closed lower sill return', new THREE.BoxGeometry(.050, .260, 1.91), dark, [side * .695, .370, -.160]);
    add(cabin, 'front footwell kick panel', new THREE.BoxGeometry(.050, .590, .350), carpet, [side * .695, .540, -.940]);
    // Keep the threshold below the door lining so the authored driver door
    // still opens above the fixed sill instead of carrying a duplicate card.
    soft(cabin, 'leather door sill threshold', [.140, .032, 1.60], [side * .680, .489, -.110], leather, .009);
  }
  for (const side of [-1, 1]) {
    soft(cabin, 'fitted carpet footwell mat', [.40, .008, .59], [side * .32, .265, -.41], carpet, .012);
    box(cabin, [.005, .003, .54], [side * .32 - .19, .271, -.41], piping);
    box(cabin, [.005, .003, .54], [side * .32 + .19, .271, -.41], piping);
  }
  for (const x of [-.406, -.327, -.238]) {
    const pedal = box(cabin, [.046, .067, .012], [x, .312, -.603], metal); pedal.rotation.x = -.32;
    for (let i = -1; i <= 1; i++) box(cabin, [.031, .0028, .008], [x, .312 + i * .013, -.593], dark);
  }
  soft(cabin, 'overhead leather console', [.156, .030, .118], [0, 1.224, -.377], leather, .008);
  for (const side of [-1, 1]) box(cabin, [.027, .004, .035], [side * .047, 1.204, -.377], lit);

  // Three-spoke leather wheel, brushed spokes, paddles, controls and EB hub.
  // Telescope the rim into the seated driver's natural reach; the dashboard
  // remains forward while the column bridges it to the hands.
  const column = new THREE.Group(); column.position.set(-.32, .806, -.03); column.rotation.x = -.17; frontCabin.add(column);
  const steeringWheel = new THREE.Group(); steeringWheel.name = 'Bugatti / leather three spoke steering wheel'; column.add(steeringWheel);
  box(cabin, [.047, .049, .260], [-.32, .79, -.465], dark);
  const rimPoints = Array.from({ length: 36 }, (_, i) => {
    const angle = i / 36 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * .157, Math.max(Math.sin(angle) * .157, -.132), 0);
  });
  add(steeringWheel, 'stitched leather steering rim', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPoints, true), 48, .019, 6, true), leather);
  for (const depth of [-.006, .006]) {
    const seam = rimPoints.map(p => new THREE.Vector3(p.x * .90, p.y * .90, depth));
    add(steeringWheel, 'steering rim twin stitched seam', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seam, true), 64, .001, 3, true), piping);
  }
  for (const side of [-1, 1]) {
    const spoke = soft(steeringWheel, 'brushed aluminum horizontal spoke', [.102, .030, .019], [side * .087, -.002, .009], metal, .005); spoke.rotation.z = side * .08;
    soft(steeringWheel, 'steering switch recess', [.055, .032, .008], [side * .101, .002, .022], dark, .003);
    detail(steeringWheel, side < 0 ? 'volume switch engraving' : 'cruise switch engraving',
      [.050, .019], [side * .101, .002, .031], [side < 0 ? 0 : 256, 256, 256, 96]);
    for (let i = 0; i < 2; i++) {
      disc(steeringWheel, 'steering multifunction button', .007, [side * .090 + (i ? side * .024 : 0), .004, .028], dark, 12);
      box(steeringWheel, [.004, .0015, .002], [side * .090 + (i ? side * .024 : 0), .004, .030], lit);
    }
    const paddle = soft(steeringWheel, 'aluminum shift paddle', [.026, .090, .012], [side * .122, .017, -.041], metal, .005); paddle.rotation.z = side * .15;
    box(steeringWheel, [.015, .006, .004], [side * .137, .018, .018], piping);
  }
  soft(steeringWheel, 'split lower steering spoke', [.032, .092, .017], [0, -.076, .003], metal, .005);
  soft(steeringWheel, 'rounded leather airbag hub', [.114, .118, .034], [0, -.008, .016], leather, .035);
  ring(steeringWheel, 'polished airbag hub surround', .055, .002, [0, -.008, .035], metal, 24);
  detail(steeringWheel, 'EB steering badge', [.086, .086], [0, -.008, .036], [0, 0, 256, 256]);
  for (const side of [-1, 1]) {
    disc(steeringWheel, 'steering mode and engine button', .013, [side * .074, -.060, .025], dark, 16);
    ring(steeringWheel, 'steering lower button bezel', .014, .0015, [side * .074, -.060, .026], metal, 16);
    detail(steeringWheel, 'steering mode and engine engraving', [.022, .012], [side * .074, -.060, .027],
      side < 0 ? [256, 256, 256, 96] : [0, 384, 256, 96]);
  }
  const topMark = box(steeringWheel, [.010, .012, .009], [0, .157, .019], metal); topMark.rotation.x = -.05;
  batchArchitecture(steeringWheel, true);
  column.userData.dynamic = true; steeringWheel.userData.dynamic = true;
  steeringWheel.traverse(object => { object.userData.dynamic = true; object.userData.cockpitDetail = true; });
  body.userData.interior = 'Bugatti inspired orange and black leather cabin / analog instruments';
  let timer = 0;
  return {
    // Sit over the cushion with room to see the wheel and center controls;
    // the eye still clears the binnacle and remains below the roof lining.
    steeringWheel, dashboardMap: instruments.map, eye: new THREE.Vector3(-.32, 1.17, .04),
    get readout() { return instruments.readout; },
    update(delta: number, frame: CabinInstruments, steer: number, visible: boolean) {
      steeringWheel.rotation.z = THREE.MathUtils.lerp(steeringWheel.rotation.z, steer * 1.18, 1 - Math.exp(-delta * 28));
      if (!visible) return;
      timer += delta;
      if (timer >= .1) { timer %= .1; instruments.paint(frame); }
    },
    refresh(frame: CabinInstruments) { timer = 0; instruments.paint(frame); },
  };
}
