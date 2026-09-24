import * as THREE from 'three';
import { batchArchitecture } from './cinematic-city';

/** A hand-built, closed performance-car shell. All dimensions are in metres. */
function shell(rings: number[][], material: THREE.Material, wheelWells = false) {
  const vertices: number[] = [], indices: number[] = [];
  const spans = wheelWells ? 100 : 32, sides = 32;
  const profile = new THREE.CatmullRomCurve3(rings.map(r => new THREE.Vector3(r[1], r[3], r[4])), false, 'centripetal');
  for (let i = 0; i <= spans; i++) {
    const t = i / spans;
    const station = t * (rings.length - 1), lower = Math.min(rings.length - 2, Math.floor(station));
    const f = station - lower;
    const z = THREE.MathUtils.lerp(rings[lower][0], rings[lower + 1][0], f);
    const bottom = THREE.MathUtils.lerp(rings[lower][2], rings[lower + 1][2], f);
    const p = profile.getPoint(t), w = p.x, shoulder = p.y, top = p.z;
    const contour = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-w * .76, bottom, z), new THREE.Vector3(-w * .98, bottom + .07, z),
      new THREE.Vector3(-w, shoulder, z), new THREE.Vector3(-w * .86, top - .028, z),
      new THREE.Vector3(-w * .55, top, z), new THREE.Vector3(w * .55, top, z),
      new THREE.Vector3(w * .86, top - .028, z), new THREE.Vector3(w, shoulder, z),
      new THREE.Vector3(w * .98, bottom + .07, z), new THREE.Vector3(w * .76, bottom, z),
    ], true, 'centripetal');
    for (let j = 0; j <= sides; j++) {
      const v = contour.getPoint(j / sides);
      if (wheelWells && Math.abs(v.x) > w * .77) {
        const dz = Math.min(Math.abs(z - 1.43), Math.abs(z + 1.43));
        if (dz < .46) v.y = Math.max(v.y, .395 + Math.sqrt(.46 * .46 - dz * dz));
      }
      vertices.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < spans; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j, b = a + sides + 1;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  // Separate end-cap vertices keep bumper normals crisp while body panels remain smooth.
  for (const end of [0, spans]) {
    const base = vertices.length / 3;
    for (let j = 0; j < sides; j++) {
      const k = (end * (sides + 1) + j) * 3;
      vertices.push(vertices[k], vertices[k + 1], vertices[k + 2]);
    }
    for (let j = 1; j < sides - 1; j++) {
      if (end === 0) indices.push(base, base + j, base + j + 1);
      else indices.push(base, base + j + 1, base + j);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function makeCar() {
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ color: 0x879397, metalness: .72, roughness: .29, clearcoat: 1, clearcoatRoughness: .19, envMapIntensity: 1.25 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x070c13, metalness: .65, roughness: .34 });
  const alloy = new THREE.MeshStandardMaterial({ color: 0x8094a2, metalness: 1, roughness: .2 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x091015, metalness: .35, roughness: .12, clearcoat: 1, envMapIntensity: 1.3 });
  const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x53bacb).multiplyScalar(1.25), toneMapped: false });
  const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe9f1ff).multiplyScalar(2.5), toneMapped: false });
  const box = (parent: THREE.Group, size: number[], pos: number[], material: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size as [number, number, number]), material);
    m.position.set(...pos as [number, number, number]); parent.add(m); return m;
  };
  body.add(shell([
    [-2.5, .68, .31, .43, .55], [-2.05, .98, .28, .57, .68],
    [-1.48, 1.02, .29, .79, .88], [-.65, .91, .29, .7, .83],
    [.7, .95, .29, .7, .85], [1.47, 1.04, .3, .83, .94],
    [2.17, .96, .32, .66, .76], [2.35, .82, .36, .56, .61],
  ], paint, true));
  // Sloping windscreen, tapered canopy and rear glass; no transparent sorting passes.
  body.add(shell([[-1.04, .73, .76, .82, .86], [-.24, .62, .8, 1.17, 1.29],
    [.58, .61, .79, 1.2, 1.31], [1.36, .77, .77, .85, .89]], glass));
  box(body, [.99, .045, .67], [0, 1.324, .19], paint);
  box(body, [.025, .018, .66], [0, 1.35, .19], carbon);
  box(body, [1.43, .055, .38], [0, .28, -2.34], carbon);
  box(body, [.77, .09, .025], [0, .37, -2.508], carbon);
  for (let i = 0; i < 9; i++) box(body, [.013, .063, .015], [(i - 4) * .078, .37, -2.526], alloy);
  box(body, [1.84, .16, .46], [0, .29, 2.07], carbon);
  for (const side of [-1, 1]) {
    box(body, [.12, .13, 2.72], [side * .96, .31, .12], carbon);
    box(body, [.016, .015, 1.75], [side * .982, .365, .1], cyan);
    const intake = box(body, [.045, .23, .56], [side * .965, .57, .73], carbon);
    intake.rotation.z = side * .1;
    box(body, [.22, .11, .32], [side * .9, 1.01, -.43], paint);
    box(body, [.16, .02, .07], [side * .92, 1.04, -.58], cyan);
    for (let j = 0; j < 5; j++) {
      box(body, [.21, .02, .038], [side * .56, .805 - j * .023, -1.65 - j * .075], carbon);
    }
    // Buttresses connect the canopy to the sculpted rear haunches.
    const brace = box(body, [.085, .09, .88], [side * .58, 1.04, .92], paint);
    brace.rotation.x = .51;
    for (const axle of [-1, 1]) {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(.455, .022, 8, 36, Math.PI), paint);
      arch.rotation.y = Math.PI / 2;
      arch.position.set(side * .99, .4, axle * 1.43);
      body.add(arch);
    }
  }
  // Rear wing, supports, cooling louvers and diffuser fins.
  box(body, [1.81, .045, .23], [0, .97, 1.99], carbon);
  for (const x of [-.63, .63]) box(body, [.04, .17, .1], [x, .865, 1.99], alloy);
  for (let i = 0; i < 7; i++) box(body, [1.02, .026, .055], [0, .897 - i * .012, 1.24 + i * .09], carbon);
  for (let i = 0; i < 5; i++) box(body, [.035, .2, .5], [(i - 2) * .22, .27, 2.14], carbon);
  const trim = (points: number[][], radius: number, material: THREE.Material) => {
    const path = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p as [number, number, number])));
    body.add(new THREE.Mesh(new THREE.TubeGeometry(path, 24, radius, 6, false), material));
  };
  for (const side of [-1, 1]) {
    // Window seals, painted pillars, flush door handles and panel gaps.
    trim([[side * .68, .87, -1.03], [side * .57, 1.26, -.26], [side * .56, 1.31, .18], [side * .57, 1.28, .59], [side * .7, .9, 1.29]], .018, paint);
    trim([[side * .92, .72, -.65], [side * .947, .58, -.62], [side * .945, .41, -.43], [side * .962, .42, .61], [side * .97, .7, .71]], .006, carbon);
    box(body, [.025, .028, .18], [side * .94, .737, .34], alloy);
    trim([[side * .21, .849, -.76], [side * .3, .873, -1.32], [side * .39, .741, -1.92], [side * .41, .67, -2.13]], .005, carbon);
    const mirrorGlass = box(body, [.17, .07, .015], [side * .9, 1.012, -.255], glass);
    mirrorGlass.rotation.y = side * .15;
  }
  box(body, [1.55, .16, .055], [0, .53, 2.34], carbon);
  for (let i = 0; i < 15; i++) box(body, [.018, .1, .012], [(i - 7) * .088, .51, 2.376], alloy);
  box(body, [.32, .08, .018], [0, .6, 2.38], alloy);
  const wheels: THREE.Group[] = [];
  const steering: THREE.Group[] = [];
  const rubber = new THREE.MeshStandardMaterial({ color: 0x090b11, roughness: .87, metalness: .05 });
  const rimGeo = new THREE.TorusGeometry(.268, .023, 10, 40);
  for (const side of [-1, 1]) for (const axle of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * .99, .395, axle * 1.43);
    car.add(pivot);
    if (axle < 0) steering.push(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel); wheels.push(wheel);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(.304, .078, 14, 48), rubber);
    tire.rotation.y = Math.PI / 2; tire.scale.z = 1.85; wheel.add(tire);
    const face = side * .15;
    const rim = new THREE.Mesh(rimGeo, alloy); rim.rotation.y = Math.PI / 2; rim.position.x = face; wheel.add(rim);
    const accent = new THREE.Mesh(new THREE.TorusGeometry(.272, .005, 5, 40), cyan);
    accent.rotation.y = Math.PI / 2; accent.position.x = face + side * .008; wheel.add(accent);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.223, .223, .016, 32), alloy);
    disc.rotation.z = Math.PI / 2; disc.position.x = face - side * .04; wheel.add(disc);
    for (let spoke = 0; spoke < 10; spoke++) {
      const a = spoke * Math.PI / 5;
      const fin = box(wheel, [.038, .2, .023], [face + side * .013, Math.cos(a) * .14, Math.sin(a) * .14], alloy);
      fin.rotation.x = a + .15;
      const drill = new THREE.Mesh(new THREE.CircleGeometry(.009, 6), carbon);
      drill.rotation.y = side * Math.PI / 2; drill.position.set(face - side * .029, Math.cos(a) * .18, Math.sin(a) * .18); wheel.add(drill);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.062, .062, .045, 16), carbon);
    hub.rotation.z = Math.PI / 2; hub.position.x = face + side * .025; wheel.add(hub);
    const caliper = box(pivot, [.06, .13, .08], [face - side * .01, .08, .19], new THREE.MeshStandardMaterial({ color: 0x942d22, metalness: .4, roughness: .38 }));
    caliper.rotation.x = -.4;
  }
  const headlights: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    box(body, [.4, .084, .035], [side * .4, .493, -2.515], carbon);
    for (let i = 0; i < 3; i++) headlights.push(box(body, [.085, .023, .015], [side * (.28 + i * .11), .513, -2.538], white));
    box(body, [.35, .012, .02], [side * .4, .47, -2.539], cyan);
    const light = new THREE.SpotLight(0xe1edff, 95, 40, .39, .8, 1.5);
    light.position.set(side * .6, .62, -2.36); light.target.position.set(side * 1.9, 0, -23);
    car.add(light, light.target);
  }
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x420408, emissive: 0xe91624, emissiveIntensity: 1.6, roughness: .25 });
  const brakeLights = [box(body, [1.56, .03, .025], [0, .66, 2.38], brakeMat)];
  for (const x of [-.7, .7]) brakeLights.push(box(body, [.02, .1, .03], [x, .605, 2.38], brakeMat));
  const exhausts: THREE.Mesh[] = [];
  const flames: THREE.Mesh[] = [];
  for (const x of [-.61, .61]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(.11, .15, .3, 12, 1, true), alloy);
    nozzle.rotation.x = Math.PI / 2; nozzle.position.set(x, .39, 2.29); body.add(nozzle);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.082, .082, .28, 12),
      new THREE.MeshStandardMaterial({ color: 0x151b20, emissive: 0x1b6173, emissiveIntensity: .3 }));
    core.rotation.x = Math.PI / 2; core.position.copy(nozzle.position); body.add(core); exhausts.push(core);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(.115, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x8cefff, transparent: true, opacity: .65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    flame.rotation.x = Math.PI / 2; flame.position.set(x, .39, 2.91); flame.visible = false; body.add(flame); flames.push(flame);
  }
  const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64;
  const ctx = glowCanvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff'); gradient.addColorStop(.35, '#aaa'); gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  const glowMap = new THREE.CanvasTexture(glowCanvas);
  const underglow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.4),
    new THREE.MeshBasicMaterial({ color: 0x00a5bb, alphaMap: glowMap, transparent: true, opacity: .12, blending: THREE.AdditiveBlending, depthWrite: false }));
  underglow.rotation.x = -Math.PI / 2; underglow.position.y = .04; car.add(underglow);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 5.9),
    new THREE.MeshBasicMaterial({ color: 0x000006, alphaMap: glowMap, transparent: true, opacity: .9, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .037; car.add(shadow);
  const boostLight = new THREE.PointLight(0x36dfff, 0, 8, 2); boostLight.position.set(0, .65, 2.8); car.add(boostLight);
  for (const part of [...brakeLights, ...exhausts]) part.userData.dynamic = true;
  batchArchitecture(body);
  for (const wheel of wheels) {
    // Bake geometry in wheel-local coordinates, retaining the animated steering pivots.
    const parent = wheel.parent!;
    parent.remove(wheel);
    batchArchitecture(wheel);
    parent.add(wheel);
  }
  car.traverse(object => {
    if (object instanceof THREE.Mesh && !(object.material as THREE.Material).transparent) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  car.position.y = .015;
  return { car, body, wheels, steering, flames, brakeLights, exhausts, headlights, underglow, boostLights: [boostLight] };
}
