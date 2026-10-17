import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Point = [number, number, number];

/** Fixed automotive light guides, shared glow geometry and two short-range cabin lights. */
export function addCabinAmbience(cabin: THREE.Group, dashboard: THREE.Group) {
  const cyan = new THREE.Color(0x26dfff), violet = new THREE.Color(0xa879ff);
  const guide = new THREE.MeshBasicMaterial({ color: 0x000000, vertexColors: true, toneMapped: false });
  guide.name = 'Bugatti cabin / cyan and violet neon light guides';
  const halo = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false,
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  halo.name = 'Bugatti cabin / soft ambient light diffusion';
  for (const material of [guide, halo]) {
    Object.assign(material.userData, { cockpitDetail: true, cabinAmbient: true, noCastShadow: true });
  }
  const cores: THREE.BufferGeometry[] = [], halos: THREE.BufferGeometry[] = [];
  const doorCores: THREE.BufferGeometry[] = [], doorHalos: THREE.BufferGeometry[] = [];
  const channels: THREE.BufferGeometry[] = [];
  const paths: Record<string, { curve: THREE.Curve<THREE.Vector3>; radius: number }> = {};
  function colorGeometry(geometry: THREE.BufferGeometry, color: THREE.Color, intensity: number) {
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = color.r * intensity; colors[i + 1] = color.g * intensity; colors[i + 2] = color.b * intensity;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }
  function strip(points: Point[], color: THREE.Color, onDashboard = false, onDriverDoor = false, radius = .0016, recessed = false, followPanels = false, pathName?: string) {
    const vertices = points.map(point => new THREE.Vector3(point[0], point[1], point[2] + (onDashboard ? dashboard.position.z : 0)));
    let curve: THREE.Curve<THREE.Vector3>;
    if (followPanels) {
      // The console skin is faceted between its authored rows. Match those
      // segments rather than letting a spline bow above the carbon surface.
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < vertices.length; i++) path.add(new THREE.LineCurve3(vertices[i - 1], vertices[i]));
      curve = path;
    } else curve = new THREE.CatmullRomCurve3(vertices);
    if (pathName) paths[pathName] = { curve, radius };
    const segments = Math.max(12, points.length * 5);
    const core = colorGeometry(new THREE.TubeGeometry(curve, segments, radius, 6, false), color, 3.1);
    const glow = colorGeometry(new THREE.TubeGeometry(curve, segments, radius * 3, 6, false), color, 1.2);
    const channel = recessed ? new THREE.TubeGeometry(curve, segments, radius * 1.9, 6, false) : null;
    // All paths and their diagnostic samples use cabin coordinates.
    channel?.translate(0, -.0016, -.0016);
    if (channel) channels.push(channel);
    (onDriverDoor ? doorCores : cores).push(core);
    (onDriverDoor ? doorHalos : halos).push(glow);
  }
  function fitPassengerCowl(points: Point[]) {
    const cowl = dashboard.getObjectByName('Bugatti cabin / passenger leather cowl');
    if (!(cowl instanceof THREE.Mesh)) return points;
    cowl.updateMatrix();
    const inverse = cowl.matrix.clone().invert();
    const position = cowl.geometry.getAttribute('position'), index = cowl.geometry.getIndex();
    const count = index ? index.count : position.count;
    const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    for (const point of points) {
      ray.origin.set(point[0], point[1], 0).applyMatrix4(inverse);
      ray.direction.set(0, 0, -1).transformDirection(inverse);
      let front = -Infinity;
      for (let triangle = 0; triangle < count; triangle += 3) {
        a.fromBufferAttribute(position, index ? index.getX(triangle) : triangle);
        b.fromBufferAttribute(position, index ? index.getX(triangle + 1) : triangle + 1);
        c.fromBufferAttribute(position, index ? index.getX(triangle + 2) : triangle + 2);
        if (ray.intersectTriangle(a, b, c, false, hit)) front = Math.max(front, hit.applyMatrix4(cowl.matrix).z);
      }
      if (Number.isFinite(front)) point[2] = front + .0014;
    }
    return points;
  }

  strip([[-.635, .858, -.480], [-.586, .872, -.478], [-.531, .882, -.480]], cyan, true, false, .0015, true, false, 'driverFascia');
  // The passenger cowl's rounded upper-front edge is lower and further back
  // than the old floating guide. Begin beyond the spine's x=.251 shoulder,
  // then follow the leather face into its rounded outer end above the vent.
  strip(fitPassengerCowl([[.265, .843, -.4918], [.30, .843, -.4918], [.36, .843, -.4918], [.42, .843, -.4918],
    [.47, .843, -.4918], [.51, .8425, -.492], [.535, .841, -.4925], [.552, .838, -.493],
    [.567, .834, -.4945], [.578, .828, -.497], [.585, .822, -.500]]), cyan, true, false, .0014, true, true, 'passengerFascia');
  strip([[-.59, .725, -.473], [-.31, .726, -.473], [-.13, .732, -.464]], violet, true, false, .0012);
  const spine: Point[] = [[.066, .914, -.574], [.038, .856, -.469], [.018, .786, -.391],
    [0, .716, -.304], [0, .654, -.184], [0, .641, -.040], [0, .654, .060]];
  const widths = [.185, .154, .128, .111, .109, .099, .092];
  for (const side of [-1, 1]) {
    strip(spine.map(([x, y, z], row): Point => [x + side * (widths[row] - .009), y + .004, z + .002]),
      side < 0 ? cyan : violet, true, false, .0013, true, true, side < 0 ? 'centerSpineLeft' : 'centerSpineRight');
    const x = side * .643;
    strip([[x, .839, -.641], [x, .839, -.385], [x, .838, -.16],
      [side * .641, .816, .19], [side * .641, .741, .348]], side < 0 ? cyan : violet, false, side < 0);
    strip([[side * .615, .655, -.20], [side * .608, .655, -.02], [side * .614, .647, .16]],
      side < 0 ? violet : cyan, false, side < 0, .0013);
    strip([[side * .165, .493, -.57], [side * .165, .484, -.23], [side * .165, .480, .08]], violet, false, false, .0013);
    // Recessed under-dash strips wash the pedals and fitted carpet.
    strip([[side * .18, .591, -.88], [side * .35, .591, -.88], [side * .49, .591, -.86]],
      side < 0 ? cyan : violet, false, false, .0020);
  }

  const ledMeshes: THREE.Mesh[] = [];
  function merge(parts: THREE.BufferGeometry[], material: THREE.Material, name: string, driverDoor = false) {
    const geometry = mergeGeometries(parts);
    parts.forEach(part => part.dispose());
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name;
    Object.assign(mesh.userData, { cockpitDetail: true, cabinAmbient: true, noCastShadow: true });
    if (driverDoor) { mesh.userData.carPart = 'driverDoor'; mesh.userData.dynamic = true; }
    // Vertex colors are authored HDR values; preserve them through the general car batcher.
    mesh.userData.dynamic = true;
    mesh.visible = false;
    cabin.add(mesh); ledMeshes.push(mesh);
  }
  merge(cores, guide, 'Bugatti cabin / continuous cyan and violet ambient strips');
  merge(halos, halo, 'Bugatti cabin / diffused dashboard and console neon');
  merge(doorCores, guide, 'Bugatti cabin / hinged driver door ambient strips', true);
  merge(doorHalos, halo, 'Bugatti cabin / hinged driver door neon diffusion', true);

  const channelGeometry = mergeGeometries(channels); channels.forEach(channel => channel.dispose());
  if (channelGeometry) {
    const channelMaterial = new THREE.MeshStandardMaterial({ color: 0x090d12, roughness: .72, metalness: .22 });
    channelMaterial.name = 'Bugatti cabin / recessed satin light guide channels';
    Object.assign(channelMaterial.userData, { cockpitDetail: true, noCastShadow: true });
    const channelMesh = new THREE.Mesh(channelGeometry, channelMaterial);
    channelMesh.name = 'Bugatti cabin / fitted dashboard and console light channels';
    Object.assign(channelMesh.userData, { cockpitDetail: true, noCastShadow: true });
    cabin.add(channelMesh);
  }

  const lights = [new THREE.PointLight(0x55deff, 0, 1.18, 2), new THREE.PointLight(0xad7bff, 0, 1.12, 2)];
  lights[0].position.set(-.28, .68, -.62); lights[1].position.set(.38, .64, -.29);
  for (const [index, light] of lights.entries()) {
    light.name = `Bugatti cabin / ${index ? 'violet' : 'cyan'} interior bounce light`;
    light.castShadow = false; light.userData.cabinAmbient = true; cabin.add(light);
  }
  const materials: (THREE.MeshBasicMaterial | undefined)[] = Array.from({ length: ledMeshes.length });
  let occupiedBefore = false, seatedElapsed = 0, level = 0, appliedLevel = -1;
  let exitElapsed = 0, exitLevel = 0;
  function apply(value: number) {
    level = value;
    const changed = appliedLevel !== value;
    for (let i = 0; i < ledMeshes.length; i++) {
      const mesh = ledMeshes[i], material = mesh.material as THREE.MeshBasicMaterial;
      // addDriverDoor clones the opaque material after this cabin is built.
      // Retain the meshes, then refresh only changed references on update.
      if (changed || materials[i] !== material) {
        materials[i] = material;
        if (material.transparent) material.opacity = .11 * value;
        else material.color.setScalar(value);
        mesh.visible = value > .0001;
      }
    }
    if (changed) { lights[0].intensity = .24 * value; lights[1].intensity = .19 * value; }
    appliedLevel = value;
  }
  function reset(occupied = false) {
    occupiedBefore = occupied; seatedElapsed = 0; exitElapsed = 0; exitLevel = 0;
    apply(0);
  }
  function update(delta: number, occupied: boolean, active = true) {
    if (!active) { reset(); return; }
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (occupied !== occupiedBefore) {
      occupiedBefore = occupied; seatedElapsed = 0; exitElapsed = 0;
      exitLevel = level;
      // A fresh entry always gets its own complete dark welcome delay,
      // including re-entry before an earlier exit fade has finished.
      if (occupied) { apply(0); return; }
    }
    if (occupied) {
      seatedElapsed += dt;
      const progress = THREE.MathUtils.clamp((seatedElapsed - 1) / 1, 0, 1);
      apply(progress * progress * (3 - 2 * progress));
    } else {
      exitElapsed += dt;
      const progress = THREE.MathUtils.clamp(exitElapsed / .35, 0, 1);
      apply(exitLevel * (1 - progress * progress * (3 - 2 * progress)));
    }
  }
  apply(0);
  return { lights, ledMeshes, paths, update, reset, get level() { return level; }, get elapsed() { return seatedElapsed; } };
}
