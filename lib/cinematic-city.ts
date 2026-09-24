import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CYAN = 0x35cde8;
const PINK = 0xff347f;
const metal = new THREE.MeshStandardMaterial({ color: 0x17212a, metalness: .72, roughness: .43 });
const concrete = new THREE.MeshStandardMaterial({ color: 0x29323a, metalness: .18, roughness: .8 });
const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(1.25), toneMapped: false });
const pink = new THREE.MeshBasicMaterial({ color: new THREE.Color(PINK).multiplyScalar(1.2), toneMapped: false });

function box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = metal) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z); parent.add(mesh); return mesh;
}

function cable(parent: THREE.Object3D, points: THREE.Vector3[], radius = .045) {
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 18, radius, 5, false), metal);
  parent.add(mesh);
}

function advertisement(index: number) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 768;
  const c = canvas.getContext('2d')!;
  const warm = index % 2 === 0;
  const color = warm ? '#ff387a' : '#42e2ff';
  c.fillStyle = '#040813'; c.fillRect(0, 0, 512, 768);
  const glow = c.createRadialGradient(250, 310, 20, 250, 310, 330);
  glow.addColorStop(0, warm ? '#b91762' : '#08739b'); glow.addColorStop(1, '#040813');
  c.fillStyle = glow; c.fillRect(0, 0, 512, 768);
  c.strokeStyle = color; c.lineWidth = 3;
  c.strokeRect(18, 18, 476, 732);
  c.fillStyle = color; c.font = '20px monospace'; c.fillText('NIGHT CITY / BROADCAST 0' + index, 40, 59);
  c.save(); c.translate(256, 308);
  for (let i = 0; i < 7; i++) {
    c.rotate(.19); c.strokeStyle = i % 2 ? '#d6fcff' : color;
    c.strokeRect(-125 + i * 10, -125 + i * 10, 250 - i * 20, 250 - i * 20);
  }
  c.restore();
  c.fillStyle = '#edfaff'; c.textAlign = 'center'; c.font = '900 85px Arial';
  c.fillText(['AFTER', 'ORBIT', 'NEURO', 'KAIRO'][index % 4], 256, 557);
  c.font = '900 58px Arial'; c.fillStyle = color;
  c.fillText(['HOURS', 'SYSTEMS', 'LINK', 'DISTRICT'][index % 4], 256, 623);
  c.font = '19px monospace'; c.fillStyle = '#c4dbe6'; c.fillText('THE FUTURE IS ALREADY HERE', 256, 698);
  c.fillStyle = 'rgba(0,0,0,.25)'; for (let y = 0; y < 768; y += 6) c.fillRect(0, y, 512, 2);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Static geometry is merged by material and city block so detail has a bounded draw cost. */
export function batchArchitecture(scene: THREE.Object3D) {
  scene.updateMatrixWorld(true);
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || object.userData.dynamic || Array.isArray(object.material)) return;
    if (object.material.transparent || object.material instanceof THREE.ShaderMaterial) return;
    const m = object.material as THREE.MeshStandardMaterial;
    const p = object.getWorldPosition(new THREE.Vector3());
    const signature = [m.type, m.color?.getHex(), m.emissive?.getHex(), m.emissiveIntensity, m.metalness, m.roughness,
      m.map?.uuid, m.emissiveMap?.uuid, m.bumpMap?.uuid, m.bumpScale, m.envMapIntensity, m.side, m.toneMapped, Math.floor(p.x / 176), Math.floor(p.z / 176)].join('|');
    let bucket = buckets.get(signature);
    if (!bucket) { bucket = { material: m, geometries: [], meshes: [] }; buckets.set(signature, bucket); }
    const g = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    g.applyMatrix4(object.matrixWorld);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    bucket.geometries.push(g); bucket.meshes.push(object);
  });
  const oldGeometries = new Set<THREE.BufferGeometry>();
  const oldMaterials = new Set<THREE.Material>();
  const retainedMaterials = new Set<THREE.Material>();
  for (const bucket of buckets.values()) {
    retainedMaterials.add(bucket.material);
    const geometry = mergeGeometries(bucket.geometries);
    if (geometry) {
      const merged = new THREE.Mesh(geometry, bucket.material);
      merged.name = 'Batched city architecture'; scene.add(merged);
      for (const mesh of bucket.meshes) {
        oldGeometries.add(mesh.geometry); oldMaterials.add(mesh.material as THREE.Material); mesh.removeFromParent();
      }
    }
    bucket.geometries.forEach(g => g.dispose());
  }
  oldGeometries.forEach(g => g.dispose());
  oldMaterials.forEach(m => { if (!retainedMaterials.has(m)) m.dispose(); });
}

/** Cheap city-shaped studio environment gives the paint/glass readable reflected neon. */
export function cityEnvironment(renderer: THREE.WebGLRenderer) {
  const studio = new THREE.Scene(); studio.background = new THREE.Color(0x0a1224);
  const colors = [0x657080, 0x779092, 0x6e4456, 0x9b9b95];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2 + i % 3, 9 + i % 7),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colors[i % 4]).multiplyScalar(i % 3 ? .55 : 1.3), side: THREE.DoubleSide }));
    panel.position.set(Math.sin(a) * 14, 4, Math.cos(a) * 14); panel.lookAt(0, 4, 0); studio.add(panel);
  }
  const overhead = new THREE.Mesh(new THREE.PlaneGeometry(10, 18), new THREE.MeshBasicMaterial({ color: 0xa7b4c3, side: THREE.DoubleSide }));
  overhead.position.set(-3, 13, -2); overhead.lookAt(0, 0, 0); studio.add(overhead);
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(studio, .06, .1, 80); generator.dispose();
  studio.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  return target;
}

export function addCityDetail(scene: THREE.Scene, facadeTextures: THREE.CanvasTexture[]) {
  const screenMaterials = Array.from({ length: 4 }, (_, i) => new THREE.MeshBasicMaterial({ map: advertisement(i), color: new THREE.Color(1.4, 1.4, 1.4), toneMapped: false, side: THREE.DoubleSide }));
  const screens: THREE.Mesh[] = [];
  const trimMaterials = [cyan, pink];
  for (let ix = 0; ix < 8; ix++) for (let iz = 0; iz < 8; iz++) {
    const x = -154 + ix * 44; const z = -154 + iz * 44; const seed = ix * 8 + iz;
    const group = new THREE.Group(); group.position.set(x, 0, z); scene.add(group);
    const trim = trimMaterials[(ix + iz) % 2];
    // Slab joints, accessible corners, utility channels and illuminated shop fronts.
    for (const side of [-1, 1]) {
      box(group, side * 12.85, .3, 0, .18, .2, 25.7, concrete);
      box(group, 0, .3, side * 12.85, 25.7, .2, .18, concrete);
      box(group, 0, .405, side * 12.6, 22, .018, .05, trim);
      for (let i = -2; i <= 2; i++) {
        box(group, i * 4.7, .25, side * 11.85, .025, .015, 1.3, metal);
        box(group, i * 4.2, 1.55, side * 10.7, 3.5, 1.9, .14, metal);
        box(group, i * 4.2, 2.63, side * 10.8, 3.5, .08, .2, trim);
        box(group, i * 4.2, 1.4, side * 10.82, 2.8, .04, .02, trim);
      }
      for (const k of [-1, 1]) {
        box(group, side * 11.9, .75, k * 11.9, .24, 1.05, .24, metal);
        box(group, side * 11.9, 1.12, k * 11.9, .27, .08, .27, trim);
      }
    }
    // Recessed building services: vents, air handlers, service pipes and canopies.
    box(group, 11.1, 1.15, 4, .85, 1.8, 2.4, metal);
    for (let j = 0; j < 7; j++) box(group, 11.55, .6 + j * .17, 4, .02, .07, 2, concrete);
    for (let j = 0; j < 2; j++) {
      cable(group, [new THREE.Vector3(10.8, .4, -4 + j * .5), new THREE.Vector3(10.8, 4.5, -4 + j * .5), new THREE.Vector3(8, 5, -4 + j * .5)], .09);
    }
    box(group, 0, 3.15, -11.2, 8, .13, 2, metal);
    if (seed % 4 === 0) {
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 9.75), screenMaterials[seed % 3]);
      screen.position.set(0, 10, -11.25); screen.rotation.y = Math.PI; screen.userData.dynamic = true;
      group.add(screen); screens.push(screen);
      box(group, 0, 10, -11.04, 6.85, 10.1, .3, metal);
    }
    // Blade advertisements face the main avenues and create a strong near/mid hierarchy.
    if (Math.abs(x) === 22 && (iz % 2 === 0 || iz === 3)) {
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(6, 18), screenMaterials[(iz + ix) % 4]);
      screen.position.set(x < 0 ? 11.3 : -11.3, iz === 3 ? 14 : 20 + seed % 9, -2);
      screen.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2; screen.userData.dynamic = true;
      group.add(screen); screens.push(screen);
    }
    if (iz % 3 === 0) {
      cable(scene, [new THREE.Vector3(x - 12, 11, z - 13), new THREE.Vector3(x, 9, z - 22), new THREE.Vector3(x + 12, 12, z - 31)], .04);
    }
  }
  // Far skyline is a second city layer, with much larger silhouettes behind the driveable grid.
  for (let i = 0; i < 56; i++) {
    const angle = i / 56 * Math.PI * 2;
    const radius = 284 + (i % 5) * 17;
    const height = 62 + ((i * 37) % 128);
    const material = new THREE.MeshBasicMaterial({ color: 0x526880, map: facadeTextures[i % 5] });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(8 + i % 7, 14 + i % 9, height, i % 3 === 0 ? 12 : 4), material);
    tower.position.set(Math.sin(angle) * radius, height / 2, Math.cos(angle) * radius); scene.add(tower);
    box(scene, tower.position.x, height + 3, tower.position.z, .3, 8, .3, i % 3 ? cyan : pink);
  }
  // A multi-span elevated arterial behind the foreground blocks, with structural trusses.
  for (let i = -4; i < 4; i++) {
    const x = i * 44 + 22;
    box(scene, x, 23.4, -132, 44, .7, 6.4, concrete);
    for (const side of [-1, 1]) {
      box(scene, x, 24.1, -132 + side * 3.1, 44, .08, .08, cyan);
      box(scene, x, 22.7, -132 + side * 2.8, 44, .25, .25, metal);
      box(scene, x, 11.5, -132 + side * 11, 1.2, 23, 1.2, concrete);
      for (let j = 0; j < 8; j++) {
        const brace = box(scene, x - 19 + j * 5.4, 22.8, -132 + side * 3, .12, 2.5, .12, metal);
        brace.rotation.z = j % 2 ? -.85 : .85;
      }
    }
  }
  // Tunnel services, ceiling ribs, tile seams, fans and chevron panels.
  for (let z = 55; z < 78; z += 3.2) for (const side of [-1, 1]) {
    box(scene, side * 8.86, 3.6, z, .06, 6.8, .04, concrete);
    box(scene, side * 8.81, .9, z, .07, .3, 1.4, z % 2 > 1 ? cyan : pink);
    box(scene, side * 7.2, 8.9, z, .2, .23, 3.2, metal);
    box(scene, side * 8.8, 5.9, z, .08, .055, 3.2, cyan);
  }
  for (const z of [57, 66, 75]) {
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(.65, .65, 1.4, 12), metal);
    fan.rotation.x = Math.PI / 2; fan.position.set(0, 8.3, z); scene.add(fan);
    for (let i = 0; i < 3; i++) box(scene, (i - 1) * .3, 8.3, z - .71, .04, 1.05, .04, concrete);
  }
  // Diagonal crosswalks/stop bars remain subtle, broken lane lines stop at junctions.
  const markings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x82919d }), 9 * 9 * 16);
  let count = 0; const matrix = new THREE.Matrix4();
  for (let x = -176; x <= 176; x += 44) for (let z = -176; z <= 176; z += 44) {
    for (const side of [-1, 1]) for (let j = 0; j < 4; j++) {
      matrix.makeScale(.65, .012, 2); matrix.setPosition(x + (j - 1.5) * 1.5, .047, z + side * 8); markings.setMatrixAt(count++, matrix);
      matrix.makeScale(2, .012, .65); matrix.setPosition(x + side * 8, .047, z + (j - 1.5) * 1.5); markings.setMatrixAt(count++, matrix);
    }
  }
  scene.add(markings);
  // Visible infrastructure marks the existing world boundary.
  for (let road = -176; road <= 176; road += 44) for (const side of [-1, 1]) {
    box(scene, road, .65, side * 196, 17, .9, .45, concrete);
    box(scene, road, 1.12, side * 196, 17, .06, .5, pink);
    box(scene, side * 196, .65, road, .45, .9, 17, concrete);
    box(scene, side * 196, 1.12, road, .5, .06, 17, pink);
  }
  return { update(time: number) {
    // Animate shared screen materials; no per-frame canvas redraw/upload.
    screenMaterials.forEach((m, i) => m.color.setScalar(1.25 + Math.sin(time * .85 + i * 1.7) * .18));
  } };
}

export function wetStreetReflection(scene: THREE.Scene) {
  const mirror = new Reflector(new THREE.PlaneGeometry(398, 398), { textureWidth: 768, textureHeight: 432, clipBias: .002, multisample: 0 });
  mirror.rotation.x = -Math.PI / 2; mirror.position.y = .026;
  const material = mirror.material as THREE.ShaderMaterial;
  material.transparent = true; material.depthWrite = false;
  material.uniforms.time = { value: 0 };
  material.vertexShader = `uniform mat4 textureMatrix;
    varying vec4 vUv; varying vec3 vWorld;
    void main() { vUv = textureMatrix * vec4(position,1.); vWorld = (modelMatrix * vec4(position,1.)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`;
  material.fragmentShader = `uniform sampler2D tDiffuse; uniform float time;
    varying vec4 vUv; varying vec3 vWorld;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){
      vec2 uv = vUv.xy / vUv.w;
      float ripple = sin(vWorld.z*18.+time*2.3)*sin(vWorld.x*14.-time*1.6);
      float grain = hash(floor(vWorld.xz*85.));
      uv += vec2(ripple*.00015, ripple*.00025);
      vec3 reflected = texture2D(tDiffuse,uv).rgb*.42;
      reflected += texture2D(tDiffuse,uv+vec2(.001,.002)).rgb*.29;
      reflected += texture2D(tDiffuse,uv-vec2(.001,.002)).rgb*.29;
      float grazing = 1.-clamp(normalize(cameraPosition-vWorld).y,0.,1.);
      float wetness = .5+.5*smoothstep(.2,.8,sin(vWorld.x*.73+sin(vWorld.z*.36)));
      // Asphalt stays visible: stronger wet patches beside the kerbs, weaker in the lanes.
      vec2 block = abs(mod(vWorld.xz+22.,44.)-22.);
      float edge = smoothstep(5.8,8.6,min(block.x,block.y));
      float luminance = dot(reflected,vec3(.2126,.7152,.0722));
      reflected *= min(1., .65 / max(luminance,.001));
      float strength = (.012+pow(grazing,2.)*.11)*mix(.42,1.,edge)*wetness;
      gl_FragColor=vec4(reflected*vec3(.8,.85,.9),strength*(.85+grain*.15));
    }`;
  scene.add(mirror);
  return { mirror, update(time: number) { material.uniforms.time.value = time; }, dispose() { mirror.getRenderTarget().dispose(); } };
}

/** Select four local practical lights; the shader never pays for the whole city's lamps. */
export function poolStreetLights(scene: THREE.Scene) {
  const sources: { position: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; decay: number }[] = [];
  const remove: THREE.PointLight[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => { if (o instanceof THREE.PointLight) {
    sources.push({ position: o.getWorldPosition(new THREE.Vector3()), color: o.color.clone(), intensity: o.intensity, distance: o.distance, decay: o.decay }); remove.push(o);
  } });
  remove.forEach(l => l.removeFromParent());
  const pool = Array.from({ length: 4 }, () => { const light = new THREE.PointLight(); scene.add(light); return light; });
  return (position: THREE.Vector3) => {
    sources.sort((a, b) => a.position.distanceToSquared(position) - b.position.distanceToSquared(position));
    pool.forEach((light, i) => { const s = sources[i]; if (!s) return;
      light.position.copy(s.position); light.color.copy(s.color); light.intensity = s.intensity; light.distance = s.distance; light.decay = s.decay;
    });
  };
}
