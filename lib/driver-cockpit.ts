import * as THREE from 'three';
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
  const leather = new THREE.MeshStandardMaterial({ color: 0x62656b, map: leatherMap, bumpMap: leatherMap, bumpScale: .00055,
    roughness: .83, metalness: .025, emissive: 0x131a23, emissiveIntensity: .23, envMapIntensity: .6 });
  leather.name = 'Bugatti cabin / fine grained anthracite leather';
  const quilting = leather.clone(); quilting.map = quilting.bumpMap = quiltingMap;
  quilting.color.setHex(0x7e838b); quilting.bumpScale = .0022; quilting.name = 'Bugatti cabin / diamond stitched leather';
  const metal = new THREE.MeshStandardMaterial({ color: 0xb7c0c8, metalness: .83, roughness: .3, envMapIntensity: .85 });
  metal.name = 'Bugatti cabin / brushed aluminum';
  const dark = new THREE.MeshStandardMaterial({ color: 0x161c23, metalness: .25, roughness: .45, emissive: 0x101721, emissiveIntensity: .14 });
  dark.name = 'Bugatti cabin / satin control recesses';
  const carbon = materials.carbon.clone(); carbon.name = 'Bugatti cabin / resin coated carbon trim';
  const piping = new THREE.MeshStandardMaterial({ color: 0x8d3a41, roughness: .76 });
  piping.name = 'Bugatti cabin / burgundy seam piping';
  const lit = new THREE.MeshBasicMaterial({ color: 0xa8bbc9, toneMapped: false });
  lit.name = 'Bugatti cabin / softly illuminated switch legends';
  const labels = new THREE.MeshStandardMaterial({ map: detailAtlas, alphaTest: .4, roughness: .44, metalness: .32, emissive: 0x2a3035, emissiveIntensity: .15 });
  labels.name = 'Bugatti cabin / engraved badges and controls';
  const dialMaterial = new THREE.MeshBasicMaterial({ map: instruments.map, alphaTest: .35, toneMapped: false });
  dialMaterial.name = 'Bugatti cabin / live analog instruments';
  for (const material of [leather, quilting, metal, dark, carbon, piping, lit, labels, dialMaterial, materials.cyan]) {
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
  function tube(parent: THREE.Object3D, name: string, points: Point[], radius: number, material: THREE.Material, segments = 12, sides = 4) {
    return add(parent, name, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), segments, radius, sides, false), material);
  }
  function ring(parent: THREE.Object3D, name: string, radius: number, thickness: number, position: Point, material = metal, segments = 24) {
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
  for (const side of [-1, 1]) {
    tube(cabin, 'upholstered front windshield pillar', [
      [side * .69, .950, -.971], [side * .649, 1.048, -.802],
      [side * .605, 1.146, -.588], [side * .570, 1.199, -.497],
    ], .021, leather, 14, 6);
    tube(cabin, 'windshield pillar rubber gasket', [
      [side * .676, .951, -.978], [side * .635, 1.048, -.806],
      [side * .591, 1.146, -.592], [side * .558, 1.199, -.505],
    ], .004, dark, 14, 4);
    const demister = box(cabin, [.192, .004, .030], [side * .38, .906, -1.051], dark);
    demister.rotation.y = side * -.17;
    for (let slot = 0; slot < 7; slot++) {
      box(cabin, [.003, .003, .025], [side * .38 + (slot - 3) * .021, .909, -1.051], carbon);
    }
  }
  tube(cabin, 'leather windshield header', [
    [-.570, 1.213, -.492], [-.32, 1.230, -.501], [0, 1.235, -.505],
    [.32, 1.230, -.501], [.570, 1.213, -.492],
  ], .017, leather, 18, 6);

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

  // Round recessed vents, metal rings, directional vanes and thumb adjusters.
  for (const [x, y, z, r] of [[-.60, .804, -.492, .039], [.61, .798, -.469, .039], [-.041, .807, -.458, .027], [.041, .807, -.458, .027]]) {
    disc(frontCabin, 'recessed air vent', r, [x, y, z], dark);
    ring(frontCabin, 'machined vent bezel', r + .004, .004, [x, y, z + .002]);
    for (let i = -2; i <= 2; i++) {
      const width = 2 * Math.sqrt(r * r - (i * r * .31) ** 2) * .83;
      box(frontCabin, [width, .002, .008], [x, y + i * r * .31, z + .004], metal);
    }
    box(frontCabin, [.008, .018, .007], [x, y, z + .009], dark);
  }

  // Three round instruments in a recessed binnacle, with no tactical screen.
  const binnacle = disc(frontCabin, 'elliptical instrument recess', 1, [-.32, .868, -.558], dark, 32); binnacle.scale.set(.238, .107, 1);
  const hood = add(frontCabin, 'curved leather instrument hood', new THREE.SphereGeometry(1, 16, 6, Math.PI, Math.PI, 0, Math.PI / 2), leather, [-.32, .860, -.559]);
  hood.scale.set(.242, .110, .148);
  const display = add(frontCabin, 'live analog instrument faces', new THREE.PlaneGeometry(.444, .222), dialMaterial, [-.32, .889, -.553]);
  for (const [x, y, r] of [[-.32, .885, .079], [-.468, .880, .055], [-.172, .880, .055]]) ring(frontCabin, 'instrument dial surround', r, .0028, [x, y, -.551]);
  display.userData.dynamic = true;

  // Narrow Bugatti center spine, clock and stacked tactile climate controls.
  soft(frontCabin, 'aluminum center console spine', [.182, .327, .052], [0, .731, -.508], metal, .029);
  soft(frontCabin, 'inset carbon control panel', [.149, .283, .012], [0, .737, -.476], carbon, .024);
  disc(frontCabin, 'center console analog clock', .027, [0, .864, -.464]);
  ring(frontCabin, 'clock bezel', .0295, .003, [0, .864, -.462]);
  detail(frontCabin, 'clock face', [.052, .052], [0, .864, -.460], [256, 0, 256, 256]);
  detail(frontCabin, 'engraved climate control legends', [.136, .087], [0, .707, -.458], [512, 128, 512, 200]);
  for (const y of [.750, .681]) {
    for (const side of [-1, 1]) {
      const x = side * .046;
      disc(frontCabin, 'climate rotary dial', .019, [x, y, -.459], dark, 16);
      ring(frontCabin, 'knurled climate knob edge', .020, .003, [x, y, -.455], metal, 16);
      box(frontCabin, [.0018, .010, .004], [x, y + .003, -.451], lit);
    }
    box(frontCabin, [.028, .006, .008], [0, y, -.457], metal);
  }
  soft(frontCabin, 'leather transmission tunnel', [.216, .162, .82], [0, .541, .00], leather, .035);
  soft(frontCabin, 'brushed gear selector surround', [.146, .025, .277], [0, .631, -.187], metal, .009);
  soft(frontCabin, 'selector carbon inset', [.111, .014, .236], [0, .648, -.190], carbon, .005);
  const shiftBoot = add(frontCabin, 'stitched selector boot', new THREE.CylinderGeometry(.024, .039, .047, 12), leather, [0, .675, -.176]); shiftBoot.rotation.x = -.11;
  const shiftStem = add(frontCabin, 'polished selector stem', new THREE.CylinderGeometry(.010, .014, .072, 10), metal, [0, .721, -.181]); shiftStem.rotation.x = -.10;
  const knob = add(frontCabin, 'leather and aluminum selector knob', new THREE.SphereGeometry(1, 12, 8), leather, [0, .760, -.185]); knob.scale.set(.025, .035, .024);
  box(frontCabin, [.009, .028, .008], [0, .766, -.161], metal);
  const gearLegend = detail(frontCabin, 'gear position engraving', [.092, .028], [0, .658, -.281], [512, 352, 512, 68]); gearLegend.rotation.x = -Math.PI / 2;
  const start = disc(frontCabin, 'start stop button', .015, [0, .666, -.070], dark, 16); start.rotation.x = -Math.PI / 2;
  const startRing = ring(frontCabin, 'start stop button bezel', .018, .003, [0, .667, -.070], metal, 16); startRing.rotation.x = -Math.PI / 2;
  soft(frontCabin, 'leather center armrest', [.185, .075, .315], [0, .638, .237], leather, .025);
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
    soft(back, 'integrated leather headrest', [.216, .129, .073], [0, .257, -.005], leather, .024);
    const crest = detail(back, 'headrest EB crest', [.042, .042], [0, .255, -.043], [0, 0, 256, 256]); crest.rotation.y = Math.PI;
    box(seat, [.034, .049, .038], [-side * .190, .481, .261], dark);
    box(seat, [.020, .009, .025], [-side * .190, .508, .261], piping);
  }

  // Deep door cards and curved metal pulls continue the cockpit's C-shaped trim.
  for (const side of [-1, 1]) {
    soft(cabin, 'leather door card', [.039, .296, .882], [side * .675, .703, .006], leather, .015);
    soft(cabin, 'carbon door insert', [.012, .117, .414], [side * .651, .763, -.095], carbon, .004);
    soft(cabin, 'padded door armrest', [.081, .053, .351], [side * .627, .670, .067], leather, .019);
    tube(cabin, 'curved aluminum door pull', [[side * .636, .802, -.203], [side * .622, .791, -.128], [side * .614, .697, .015], [side * .622, .654, .070]], .010, metal, 12, 4);
    tube(cabin, 'door stitching and ambient piping', [[side * .644, .835, -.385], [side * .644, .835, -.16], [side * .642, .813, .19], [side * .642, .735, .348]], .0018, materials.cyan, 10, 3);
    const handle = ring(cabin, 'oval metal door release', .024, .004, [side * .636, .772, -.279], metal, 16); handle.rotation.y = -side * Math.PI / 2; handle.scale.x = 1.45;
    for (let i = 0; i < 2; i++) box(cabin, [.029, .006, .014], [side * .612, .699, -.030 + i * .025], dark);
    box(cabin, [.035, .045, .366], [side * .661, .560, .164], dark);
  }
  box(cabin, [1.19, .031, 1.44], [0, .422, .033], dark);
  for (const x of [-.406, -.327, -.238]) {
    const pedal = box(cabin, [.046, .067, .012], [x, .469, -.538], metal); pedal.rotation.x = -.32;
    for (let i = -1; i <= 1; i++) box(cabin, [.031, .0028, .008], [x, .469 + i * .013, -.528], dark);
  }
  soft(cabin, 'overhead leather console', [.156, .030, .118], [0, 1.224, -.377], leather, .008);
  for (const side of [-1, 1]) box(cabin, [.027, .004, .035], [side * .047, 1.204, -.377], lit);

  // Three-spoke leather wheel, brushed spokes, paddles, controls and EB hub.
  const column = new THREE.Group(); column.position.set(-.32, .806, -.291); column.rotation.x = -.17; frontCabin.add(column);
  const steeringWheel = new THREE.Group(); steeringWheel.name = 'Bugatti / leather three spoke steering wheel'; column.add(steeringWheel);
  box(cabin, [.047, .049, .190], [-.32, .79, -.404], dark);
  const rimPoints = Array.from({ length: 36 }, (_, i) => {
    const angle = i / 36 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * .157, Math.max(Math.sin(angle) * .157, -.132), 0);
  });
  add(steeringWheel, 'stitched leather steering rim', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPoints, true), 48, .019, 6, true), leather);
  for (const side of [-1, 1]) {
    const spoke = soft(steeringWheel, 'brushed aluminum horizontal spoke', [.102, .030, .019], [side * .087, -.002, .009], metal, .005); spoke.rotation.z = side * .08;
    soft(steeringWheel, 'steering switch recess', [.055, .032, .008], [side * .101, .002, .022], dark, .003);
    for (let i = 0; i < 2; i++) {
      disc(steeringWheel, 'steering multifunction button', .007, [side * .090 + (i ? side * .024 : 0), .004, .028], dark, 12);
      box(steeringWheel, [.004, .0015, .002], [side * .090 + (i ? side * .024 : 0), .004, .030], lit);
    }
    const paddle = soft(steeringWheel, 'aluminum shift paddle', [.026, .090, .012], [side * .122, .017, -.041], metal, .005); paddle.rotation.z = side * .15;
    box(steeringWheel, [.015, .006, .004], [side * .137, .018, .018], piping);
  }
  soft(steeringWheel, 'split lower steering spoke', [.032, .092, .017], [0, -.076, .003], metal, .005);
  const hub = add(steeringWheel, 'round leather airbag hub', new THREE.CylinderGeometry(.053, .054, .029, 20), leather, [0, -.008, .016]); hub.rotation.x = Math.PI / 2;
  detail(steeringWheel, 'EB steering badge', [.087, .087], [0, -.008, .032], [0, 0, 256, 256]);
  const topMark = box(steeringWheel, [.010, .012, .009], [0, .157, .019], metal); topMark.rotation.x = -.05;
  batchArchitecture(steeringWheel, true);
  column.userData.dynamic = true; steeringWheel.userData.dynamic = true;
  steeringWheel.traverse(object => { object.userData.dynamic = true; object.userData.cockpitDetail = true; });
  body.userData.interior = 'Bugatti inspired sculpted leather cabin / analog instruments';
  let timer = 0;
  return {
    // The eye clears the instrument binnacle so the real bonnet is visible
    // beyond the windshield, while remaining below the car's roof lining.
    steeringWheel, dashboardMap: instruments.map, eye: new THREE.Vector3(-.32, 1.12, -.18),
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
