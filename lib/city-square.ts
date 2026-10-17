import * as THREE from 'three';
import { CITY_SQUARE_HALF_SIZE, PLAYER_SPAWN, ROAD_WIDTH } from './city-layout';

export type CitySquare = {
  update: (elapsed: number, delta: number) => void;
  dispose: () => void;
};

/** A civic arrival space laid over the original street grid. The four lanes stay open. */
export function addCitySquare(scene: THREE.Scene): CitySquare {
  const squareSize = CITY_SQUARE_HALF_SIZE * 2;
  const group = new THREE.Group();
  group.name = 'Nexus Square / civic arrival plaza';
  scene.add(group);
  const textures: THREE.Texture[] = [];
  const stone = new THREE.MeshStandardMaterial({ color: 0x33424d, metalness: .48, roughness: .29 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x111e29, metalness: .8, roughness: .26 });
  const silver = new THREE.MeshStandardMaterial({ color: 0x8aabb6, metalness: .86, roughness: .22 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x956b4d, metalness: .76, roughness: .33 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x563f39, metalness: .1, roughness: .58 });
  const soil = new THREE.MeshStandardMaterial({ color: 0x102d32, metalness: .1, roughness: .9 });
  const bark = new THREE.MeshStandardMaterial({ color: 0x34444d, metalness: .25, roughness: .7 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xabbfc9, metalness: .12, roughness: .72 });
  const foliage = new THREE.MeshStandardMaterial({ color: 0x477d80, emissive: 0x153b3b, emissiveIntensity: .3, roughness: .65 });
  const blossom = new THREE.MeshStandardMaterial({ color: 0xa9a3c2, emissive: 0x65274a, emissiveIntensity: .14, roughness: .6 });
  const glow = (color: number, brightness = 1) => {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(brightness), toneMapped: false });
    material.userData.noCastShadow = true;
    return material;
  };
  const cyan = glow(0x59e8f0, 1.6);
  const softCyan = glow(0x51b9ca, .7);
  const amber = glow(0xffcd8a, 1.4);
  const pink = glow(0xf48eb5, 1.3);
  const white = glow(0xe5f9ff, 1.05);
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 48);
  const leafGeometry = new THREE.IcosahedronGeometry(1, 1);

  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    parent.add(object);
    return object;
  }
  function box(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = edge, parent: THREE.Object3D = group) {
    const object = mesh(boxGeometry, material, x, y, z, parent);
    object.scale.set(w, h, d);
    return object;
  }
  function cylinder(x: number, y: number, z: number, radius: number, height: number, material: THREE.Material = edge, parent: THREE.Object3D = group) {
    const object = mesh(cylinderGeometry, material, x, y, z, parent);
    object.scale.set(radius, height, radius);
    return object;
  }
  function ring(x: number, y: number, z: number, radius: number, thickness: number, material: THREE.Material, parent: THREE.Object3D = group) {
    const object = mesh(new THREE.TorusGeometry(radius, thickness, 6, 96), material, x, y, z, parent);
    object.rotation.x = Math.PI / 2;
    return object;
  }
  function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, parent: THREE.Object3D = group) {
    return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, radius, 5, false), material, 0, 0, 0, parent);
  }
  function canvasTexture(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    paint(canvas.getContext('2d')!);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    textures.push(texture);
    return texture;
  }

  // One carefully drawn tile field provides close-range detail without hundreds of slabs.
  const paving = canvasTexture(2048, 2048, ctx => {
    ctx.fillStyle = '#182b37'; ctx.fillRect(0, 0, 2048, 2048);
    const world = (v: number) => (v + CITY_SQUARE_HALF_SIZE) / squareSize * 2048;
    for (let ix = 0; ix < 64; ix++) for (let iz = 0; iz < 64; iz++) {
      const shade = ((ix * 11 + iz * 7) % 13) + 26;
      ctx.fillStyle = `rgb(${shade},${shade + 16},${shade + 24})`;
      ctx.fillRect(ix * 32 + 1, iz * 32 + 1, 30.7, 30.7);
      ctx.fillStyle = 'rgba(155,198,212,.08)';
      ctx.fillRect(ix * 32 + 2, iz * 32 + 2, 29, .7);
    }
    ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(153,191,203,.28)';
    for (let line = -54; line <= 54; line += 9) {
      ctx.beginPath(); ctx.moveTo(world(line), 0); ctx.lineTo(world(line), 2048); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, world(line)); ctx.lineTo(2048, world(line)); ctx.stroke();
    }
    // Brass meridian circles connect the central monument to the outer gardens.
    for (const radius of [12, 31.8, 49.5]) {
      ctx.strokeStyle = 'rgba(215,179,119,.38)'; ctx.lineWidth = radius === 31.8 ? 3 : 1.5;
      ctx.beginPath(); ctx.arc(1024, 1024, radius / squareSize * 2048, 0, Math.PI * 2); ctx.stroke();
    }
    // Small brass pin joints and quiet aggregate keep the stone from feeling flat.
    for (let i = 0; i < 18000; i++) {
      const x = (i * 587 + 11) % 2048; const y = (i * 941 + (i % 17) * 41) % 2048;
      ctx.fillStyle = i % 7 ? 'rgba(185,212,219,.055)' : 'rgba(7,13,20,.2)';
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = 'rgba(226,193,142,.45)';
    for (let x = 64; x < 2048; x += 128) for (let y = 64; y < 2048; y += 128) ctx.fillRect(x, y, 2, 2);
  });
  const pavingMaterial = new THREE.MeshStandardMaterial({
    color: 0xb1beca, map: paving, emissive: 0x44515a, emissiveMap: paving, emissiveIntensity: .16,
    roughness: .91, metalness: 0, envMapIntensity: .1,
  });
  // Paving occupies the nine pedestrian islands. Leave the four carriageways
  // open to the same detailed asphalt used throughout the street grid.
  const halfRoad = ROAD_WIDTH / 2;
  const islands = [[-CITY_SQUARE_HALF_SIZE, -22 - halfRoad], [-22 + halfRoad, 22 - halfRoad], [22 + halfRoad, CITY_SQUARE_HALF_SIZE]];
  const floorPositions: number[] = [], floorUvs: number[] = [];
  for (const [x0, x1] of islands) for (const [z0, z1] of islands) {
    for (const [x, z] of [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]]) {
      floorPositions.push(x, 0, z);
      floorUvs.push((x + CITY_SQUARE_HALF_SIZE) / squareSize, (CITY_SQUARE_HALF_SIZE - z) / squareSize);
    }
  }
  const floorGeometry = new THREE.BufferGeometry();
  floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorPositions, 3));
  floorGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(floorUvs, 2));
  floorGeometry.computeVertexNormals();
  const floor = mesh(floorGeometry, pavingMaterial, 0, .012, 0);
  floor.name = 'Nexus Square / flush stone paving';

  // Flush inlaid LEDs delineate islands and arrival bays; nothing on the road is raised.
  for (const x of [-44, 0, 44]) for (const z of [-44, 0, 44]) {
    if (x === 0 && z === 0) continue;
    const accent = x * z < 0 ? amber : softCyan;
    for (const side of [-1, 1]) {
      box(x + side * 10.1, .023, z, .045, .004, 15, accent);
      box(x, .023, z + side * 10.1, 15, .004, .045, accent);
      for (let i = 0; i < 3; i++) {
        box(x + side * (9.9 - i * .38), .023, z + side * 9.9, .16, .004, .16, amber);
      }
    }
  }
  for (const lane of [-22, 22]) for (const offset of [-10, 10]) {
    for (const stretch of [-45, 0, 45]) {
      box(lane + offset, .024, stretch, .035, .004, stretch === 0 ? 18 : 16, softCyan);
      box(stretch, .024, lane + offset, stretch === 0 ? 18 : 16, .004, .035, softCyan);
    }
  }

  const bayTexture = canvasTexture(1024, 512, ctx => {
    ctx.clearRect(0, 0, 1024, 512);
    ctx.strokeStyle = '#72e2e7'; ctx.lineWidth = 5;
    ctx.beginPath();
    for (const x of [35, 989]) for (const y of [28, 484]) {
      const sx = x < 500 ? 1 : -1; const sy = y < 250 ? 1 : -1;
      ctx.moveTo(x + sx * 130, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * 94);
    }
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#c3eff0';
    ctx.font = '600 29px Arial, sans-serif'; ctx.fillText('N E X U S   /   A R R I V A L', 512, 447);
    ctx.fillStyle = '#f1cb92'; ctx.font = '600 22px Arial, sans-serif'; ctx.fillText('01    •    READY TO EXPLORE', 512, 482);
    ctx.fillStyle = 'rgba(107,224,230,.48)';
    for (let i = 0; i < 5; i++) {
      const y = 48 + i * 25;
      ctx.beginPath(); ctx.moveTo(494, y + 12); ctx.lineTo(512, y); ctx.lineTo(530, y + 12); ctx.lineWidth = 3; ctx.stroke();
    }
  });
  const bayMaterial = new THREE.MeshBasicMaterial({ map: bayTexture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
  for (const [x, z] of [[PLAYER_SPAWN.x, PLAYER_SPAWN.z], [-17.6, 36], [26.4, 36], [-17.6, 48], [26.4, 48]]) {
    const bay = mesh(new THREE.PlaneGeometry(3.2, 8), bayMaterial, x, .025, z);
    bay.rotation.x = -Math.PI / 2;
    if (z < 0) bay.rotation.z = Math.PI;
    bay.name = 'Nexus Square / flush arrival marking';
  }

  // A low stone basin anchors the sculpture. All solid elements fit the central island.
  cylinder(0, .24, 0, 9.35, .46, stone);
  cylinder(0, .51, 0, 8.98, .18, edge);
  ring(0, .56, 0, 9.1, .16, silver);
  ring(0, .595, 0, 8.82, .045, cyan);
  ring(0, .16, 0, 9.3, .045, amber);
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2;
    const joint = box(Math.cos(a) * 9.15, .595, Math.sin(a) * 9.15, .035, .013, .24, bronze);
    joint.rotation.y = -a;
  }
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: `varying vec2 vWater; void main(){ vWater=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vWater; uniform float time;
      void main(){ float d=length(vWater); float a=atan(vWater.y,vWater.x);
      float ripple=pow(.5+.5*sin(d*10.0-time*2.7+sin(a*7.0+time)*.32),15.0);
      float caustic=pow(.5+.5*sin(vWater.x*4.1+sin(vWater.y*3.7+time*.6)),14.0);
      vec3 col=mix(vec3(.018,.095,.14),vec3(.13,.61,.68),ripple*.55+caustic*.14);
      float rim=pow(clamp(d/8.74,0.,1.),18.); col+=vec3(.07,.38,.42)*rim;
      gl_FragColor=vec4(col,.9); }`,
  });
  const water = mesh(new THREE.CircleGeometry(8.74, 96), waterMaterial, 0, .615, 0);
  water.rotation.x = -Math.PI / 2; water.userData.dynamic = true;
  cylinder(0, .95, 0, 2.7, 1, edge);
  cylinder(0, 1.48, 0, 2.2, .14, bronze);
  ring(0, 1.56, 0, 2.05, .045, amber);
  const obelisk = mesh(new THREE.CylinderGeometry(.3, .9, 8.6, 6), silver, 0, 5.86, 0);
  obelisk.rotation.y = Math.PI / 6;
  for (const side of [-1, 1]) box(side * .24, 5.4, .47, .028, 6.7, .035, cyan);

  const orbit = new THREE.Group(); orbit.position.y = 11.4; orbit.userData.dynamic = true; group.add(orbit);
  const orbitalRings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const radius = 5.5 + i * .48;
    const orbitRing = ring(0, 0, 0, radius, .055, i === 1 ? amber : cyan, orbit);
    orbitRing.rotation.set(.38 + i * .72, i * 1.05, .22 + i * .24);
    orbitRing.userData.dynamic = true; orbitalRings.push(orbitRing);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(radius + .13, .085, 6, 96), silver);
    rail.rotation.copy(orbitRing.rotation); rail.userData.dynamic = true; orbit.add(rail);
  }
  const core = mesh(new THREE.IcosahedronGeometry(1.43, 1), silver, 0, 0, 0, orbit);
  core.scale.set(1, 1.7, 1); core.userData.dynamic = true;
  const coreLines = new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry), new THREE.LineBasicMaterial({ color: 0x8cf8fa, toneMapped: false }));
  coreLines.scale.copy(core.scale); coreLines.userData.dynamic = true; orbit.add(coreLines);
  const innerCore = mesh(new THREE.OctahedronGeometry(.65), cyan, 0, 0, 0, orbit);
  innerCore.scale.y = 2.9; innerCore.userData.dynamic = true;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    const fin = box(Math.cos(a) * 2.95, 8.1, Math.sin(a) * 2.95, .09, 1.2, .55, i % 3 ? silver : amber);
    fin.rotation.y = -a;
  }
  const monumentLight = new THREE.PointLight(0x70e7ee, 125, 29, 2);
  monumentLight.position.set(0, 7.5, 0); group.add(monumentLight);

  const dropletTexture = canvasTexture(32, 32, ctx => {
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(.2, '#d6fcff');
    gradient.addColorStop(.5, 'rgba(126,235,255,.5)'); gradient.addColorStop(1, 'rgba(64,190,255,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 32, 32);
  });
  const dropletCount = 640;
  const particlePositions = new Float32Array(dropletCount * 3);
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
  const particles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({
    color: 0x9df6ff, size: .12, map: dropletTexture, transparent: true, opacity: .85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  particles.name = 'Nexus Square / choreographed fountain';
  particles.userData.dynamic = true; particles.frustumCulled = false; group.add(particles);

  // Open garden islands occupy only the former building footprints (half-width <= 9.4).
  function bench(x: number, z: number, rotation: number) {
    const benchGroup = new THREE.Group(); benchGroup.position.set(x, 0, z); benchGroup.rotation.y = rotation; group.add(benchGroup);
    box(0, .53, 0, 4.3, .18, 1.05, edge, benchGroup);
    for (let j = 0; j < 5; j++) box(0, .65, -.44 + j * .22, 4.15, .09, .15, wood, benchGroup);
    for (const side of [-1, 1]) box(side * 1.65, .28, 0, .2, .5, .7, silver, benchGroup);
    box(0, .49, .5, 3.75, .035, .035, amber, benchGroup);
    box(0, 1, -.49, 4.3, .12, .12, silver, benchGroup);
    box(0, .88, -.5, 4.15, .15, .08, wood, benchGroup);
  }
  function tree(x: number, z: number, seed: number, scale = 1) {
    const treeGroup = new THREE.Group(); treeGroup.position.set(x, .55, z); treeGroup.scale.setScalar(scale); group.add(treeGroup);
    cylinder(0, 1.7, 0, .18, 3.4, bark, treeGroup);
    for (let j = 0; j < 5; j++) {
      const a = (j / 5 * Math.PI * 2) + seed;
      const ex = Math.cos(a) * 1.45; const ez = Math.sin(a) * 1.45;
      tube([new THREE.Vector3(0, 1.9, 0), new THREE.Vector3(ex * .4, 3.1, ez * .4), new THREE.Vector3(ex, 4 + (j % 2) * .4, ez)], .075, bark, treeGroup);
      const canopy = mesh(leafGeometry, seed % 2 ? blossom : foliage, ex * .75, 4.25 + (j % 2) * .45, ez * .75, treeGroup);
      canopy.scale.set(1.2, .65, 1.12);
      const snowCap = mesh(leafGeometry, snow, ex * .75, 4.62 + (j % 2) * .45, ez * .75, treeGroup);
      snowCap.scale.set(1.06, .18, .99);
      if (j % 2 === 0) {
        const lightX = ex * 1.1; const lightZ = ez * 1.1;
        box(lightX, 3.1, lightZ, .025, 1.2, .025, bronze, treeGroup);
        const lantern = mesh(new THREE.OctahedronGeometry(.13), seed % 2 ? pink : amber, lightX, 2.5, lightZ, treeGroup);
        lantern.scale.y = 1.8;
      }
    }
  }
  function lamp(x: number, z: number) {
    cylinder(x, 1.9, z, .065, 3.8, silver);
    box(x, 3.78, z, .65, .07, .65, silver);
    box(x, 3.73, z, .48, .022, .48, white);
    box(x, .55, z, .12, .045, .12, cyan);
    const light = new THREE.PointLight(0xd4edf5, 38, 14, 2);
    light.position.set(x, 3.6, z); group.add(light);
  }
  for (const x of [-44, 44]) for (const z of [-44, 44]) {
    const garden = new THREE.Group(); garden.position.set(x, 0, z); group.add(garden);
    box(0, .014, 0, 17.4, .014, 17.4, stone, garden);
    box(0, .022, 0, 16.8, .002, 16.8, edge, garden);
    for (const side of [-1, 1]) {
      box(side * 7.9, .025, 0, .05, .004, 14, softCyan, garden);
      box(0, .025, side * 7.9, 14, .004, .05, softCyan, garden);
    }
    for (const sign of [-1, 1]) {
      cylinder(x + sign * 4.6, .5, z - sign * 3.7, 2.45, .7, silver);
      cylinder(x + sign * 4.6, .865, z - sign * 3.7, 2.23, .06, soil);
      ring(x + sign * 4.6, .77, z - sign * 3.7, 2.45, .025, amber);
      tree(x + sign * 4.6, z - sign * 3.7, x + z + sign, 1.14);
      bench(x + sign * 4.9, z + sign * 4.4, sign > 0 ? -.25 : Math.PI - .25);
    }
    lamp(x - 7, z - 7); lamp(x + 7, z + 7);
    // Small, frost-dusted ornamental grasses supply a finer scale around the gardens.
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const cluster = mesh(leafGeometry, foliage, x + Math.cos(a) * 6.9, .61, z + Math.sin(a) * 6.9);
      cluster.scale.set(.38, .25 + (i % 3) * .06, .38);
    }
  }
  // Two quieter garden lounges give the eastern and western approaches depth.
  for (const x of [-44, 44]) {
    cylinder(x, .014, 0, 8.65, .014, stone);
    ring(x, .025, 0, 8.4, .003, softCyan);
    cylinder(x, .56, 0, 3.1, .6, edge);
    cylinder(x, .87, 0, 2.9, .04, soil);
    tree(x, 0, x, 1.35);
    for (const side of [-1, 1]) {
      bench(x, side * 6.2, side > 0 ? Math.PI : 0);
      lamp(x + side * 6.2, -side * 3.2);
    }
  }

  const signTexture = canvasTexture(2048, 512, ctx => {
    ctx.fillStyle = '#0c1b26'; ctx.fillRect(0, 0, 2048, 512);
    const gradient = ctx.createLinearGradient(0, 0, 2048, 0);
    gradient.addColorStop(0, '#55d8e5'); gradient.addColorStop(.55, '#e3fbff'); gradient.addColorStop(1, '#f2ce97');
    ctx.fillStyle = gradient; ctx.textAlign = 'center';
    ctx.font = '500 163px Arial, sans-serif'; ctx.fillText('N E X U S', 1024, 207);
    ctx.fillStyle = '#d3dde2'; ctx.font = '500 77px Arial, sans-serif'; ctx.fillText('S Q U A R E', 1024, 318);
    ctx.fillStyle = '#78bdc8'; ctx.font = '400 30px Arial, sans-serif'; ctx.fillText('THE HEART OF THE CITY     /     ARRIVE • EXPLORE • BELONG', 1024, 416);
    ctx.fillStyle = '#dfba80'; ctx.fillRect(920, 461, 208, 3);
    ctx.fillStyle = '#73c5cf'; ctx.fillRect(150, 53, 163, 3); ctx.fillRect(1735, 53, 163, 3);
  });
  const signMaterial = new THREE.MeshBasicMaterial({ map: signTexture, toneMapped: false });
  // Tall, open civic marquees align with the monument rather than the driving lanes.
  for (const z of [-44, 44]) {
    const marquee = new THREE.Group(); marquee.position.z = z; if (z > 0) marquee.rotation.y = Math.PI; group.add(marquee);
    box(0, .014, 0, 18, .014, 9, stone, marquee);
    for (const side of [-1, 1]) {
      box(side * 7.4, 4.3, 0, .33, 8.6, .5, silver, marquee);
      box(side * 7.2, 4.3, .275, .055, 8.2, .035, cyan, marquee);
      box(side * 7.4, .4, 0, .9, .32, 1.5, edge, marquee);
    }
    box(0, 8.55, 0, 15.1, .32, .7, silver, marquee);
    box(0, 6.65, 0, 14.45, 3.7, .36, edge, marquee);
    mesh(new THREE.PlaneGeometry(14.1, 3.525), signMaterial, 0, 6.65, .19, marquee);
    box(0, 8.77, 0, 14.5, .045, .55, amber, marquee);
    bench(0, z + (z < 0 ? 2.7 : -2.7), z < 0 ? 0 : Math.PI);
    lamp(-8, z - 3); lamp(8, z + 3);
  }

  // Eight airy portals announce the plaza. Their posts sit in the garden strips and
  // every road has a full 29 m opening with 8 m vertical clearance.
  const portalTexture = canvasTexture(1024, 128, ctx => {
    ctx.fillStyle = '#122c38'; ctx.fillRect(0, 0, 1024, 128);
    ctx.textAlign = 'center'; ctx.fillStyle = '#a8e6ec'; ctx.font = '500 42px Arial, sans-serif';
    ctx.fillText('N E X U S   S Q U A R E', 512, 60);
    ctx.fillStyle = '#d6ba8a'; ctx.font = '400 18px Arial, sans-serif'; ctx.fillText('CITY CENTRE     /     WELCOME', 512, 99);
  });
  const portalSignMaterial = new THREE.MeshBasicMaterial({ map: portalTexture, toneMapped: false });
  for (const side of [-1, 1]) for (const lane of [-22, 22]) for (let axis = 0; axis < 2; axis++) {
    const portal = new THREE.Group();
    const perimeter = side * (CITY_SQUARE_HALF_SIZE - 1.2);
    portal.position.set(axis === 0 ? lane : perimeter, 0, axis === 0 ? perimeter : lane);
    portal.rotation.y = axis === 0 ? (side > 0 ? 0 : Math.PI) : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
    group.add(portal);
    for (const post of [-1, 1]) {
      box(post * 14.7, 4.4, 0, .36, 8.8, .7, silver, portal);
      box(post * 14.7, 4.3, .37, .055, 8.4, .025, softCyan, portal);
    }
    box(0, 8.85, 0, 29.75, .32, .7, edge, portal);
    box(0, 8.68, .37, 29.1, .045, .04, cyan, portal);
    box(0, 9.09, 0, 29.3, .045, .72, amber, portal);
    box(0, 9.58, 0, 10.5, .95, .28, edge, portal);
    mesh(new THREE.PlaneGeometry(10.3, 1.2875), portalSignMaterial, 0, 9.6, .151, portal);
  }

  // Decorative light pools are additive decals, avoiding extra real-time shadow lights.
  const poolTexture = canvasTexture(64, 64, ctx => {
    const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(86,232,240,.25)'); gradient.addColorStop(.45, 'rgba(38,163,187,.12)'); gradient.addColorStop(1, 'rgba(20,100,145,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  });
  const poolMaterial = new THREE.MeshBasicMaterial({ map: poolTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  for (const [x, z, size] of [[0, 0, 29], [-44, 0, 17], [44, 0, 17], [-44, -44, 24], [44, -44, 24], [-44, 44, 24], [44, 44, 24]]) {
    const pool = mesh(new THREE.PlaneGeometry(size, size), poolMaterial, x, .0245, z); pool.rotation.x = -Math.PI / 2;
  }

  function update(elapsed: number, _delta: number) {
    waterMaterial.uniforms.time.value = elapsed;
    orbit.rotation.y = elapsed * .13;
    orbit.rotation.z = Math.sin(elapsed * .19) * .055;
    orbit.position.y = 11.4 + Math.sin(elapsed * .7) * .18;
    core.rotation.y = elapsed * -.26; core.rotation.z = Math.sin(elapsed * .38) * .12;
    coreLines.rotation.copy(core.rotation);
    innerCore.rotation.y = elapsed * .4;
    for (let i = 0; i < orbitalRings.length; i++) orbitalRings[i].rotation.z = .22 + i * .24 + Math.sin(elapsed * .21 + i * 2) * .15;
    for (let i = 0; i < dropletCount; i++) {
      const jet = Math.floor(i / 16); const slot = i % 16;
      const a = jet / 40 * Math.PI * 2;
      const phase = (elapsed * (jet % 3 === 0 ? .4 : .31) + slot / 16 + jet * .043) % 1;
      const outer = jet >= 28;
      const radius = outer ? 8.08 - phase * .75 : 6.8 - phase * 3.5;
      const height = outer ? 1.5 : 3.6 + Math.sin(elapsed * .52 + a * 3) * .65;
      const jitter = Math.sin(i * 7.31 + elapsed * 3) * .035;
      particlePositions[i * 3] = Math.cos(a) * radius + jitter;
      particlePositions[i * 3 + 1] = .65 + Math.sin(phase * Math.PI) * height;
      particlePositions[i * 3 + 2] = Math.sin(a) * radius + jitter;
    }
    particleGeometry.attributes.position.needsUpdate = true;
  }
  update(0, 0);
  return { update, dispose: () => textures.forEach(texture => texture.dispose()) };
}
