import * as THREE from 'three';
import { makeSnowContact, type SnowContact } from './snow-surface';

const CAPACITY = 8192,
  CELL = 2,
  WIDTH = 0.246,
  POWDER_COUNT = 192;
type Sample = (x: number, z: number, out: SnowContact) => SnowContact;
/** Bounded world-space tire ribbons, with tread, compressed centers and displaced powder edges. */
export function addSnowTracks(scene: THREE.Scene, sample: Sample) {
  const positions = new Float32Array(CAPACITY * 12),
    uv = new Float32Array(CAPACITY * 8),
    marks = new Float32Array(CAPACITY * 16);
  const indices = new Uint16Array(CAPACITY * 6);
  for (let i = 0; i < CAPACITY; i++) {
    const v = i * 4,
      k = i * 6;
    indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], k);
  }
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const uvAttribute = new THREE.BufferAttribute(uv, 2).setUsage(
    THREE.DynamicDrawUsage,
  );
  const markAttribute = new THREE.BufferAttribute(marks, 4).setUsage(
    THREE.DynamicDrawUsage,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('uv', uvAttribute);
  geometry.setAttribute('mark', markAttribute);
  geometry.setDrawRange(0, 0);
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    time: { value: 0 },
    carPosition: { value: new THREE.Vector3() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: `attribute vec4 mark; uniform float time; varying vec2 local; varying vec4 detail; varying vec3 world;
      #include <fog_pars_vertex>
      void main(){ local=uv; detail=mark; world=position;
        vec4 mvPosition=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mvPosition;
        if(time-mark.x>240.)gl_Position=vec4(2.,2.,2.,1.);
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float time; uniform vec3 carPosition; varying vec2 local; varying vec4 detail; varying vec3 world;
      #include <fog_pars_fragment>
      void main(){
        float across=abs(local.x-.5)*2.;
        float edge=1.-smoothstep(.80,1.,across);
        float rim=smoothstep(.65,.86,across)*(1.-smoothstep(.86,1.,across));
        float channel=1.-smoothstep(.42,.74,across);
        float tread=smoothstep(.52,.62,fract(local.y*18.+abs(local.x-.5)*3.8));
        float grooves=(1.-smoothstep(.035,.075,abs(local.x-.27)))+(1.-smoothstep(.035,.075,abs(local.x-.73)));
        float smear=clamp(detail.w,0.,1.);
        float compression=mix(.38,.57,clamp(detail.z/.16,0.,1.));
        vec3 color=mix(vec3(.15,.20,.24),vec3(.05,.075,.10),channel*compression);
        color-=vec3(.015,.018,.022)*(tread*.5+grooves*.4)*(1.-smear*.85);
        color=mix(color,vec3(.30,.38,.43),rim*.85);
        float illumination=1.-smoothstep(8.,28.,distance(world.xz,carPosition.xz));
        color*=.72+illumination*.22;
        float alpha=edge*detail.y*(.67+channel*.16+rim*.10)*(1.-smoothstep(150.,240.,time-detail.x));
        if(alpha<.012)discard;
        gl_FragColor=vec4(color,alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Snow / tire ruts and tread';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  const ax = new Float32Array(CAPACITY),
    az = new Float32Array(CAPACITY),
    bx = new Float32Array(CAPACITY),
    bz = new Float32Array(CAPACITY),
    born = new Float32Array(CAPACITY).fill(-1000),
    widths = new Float32Array(CAPACITY);
  const bins = new Map<string, Set<number>>(),
    slotCells: string[][] = Array.from({ length: CAPACITY }, () => []);
  const last = Array.from({ length: 4 }, () => ({
    x: 0,
    z: 0,
    distance: 0,
    valid: false,
  }));
  const scratch = makeSnowContact();
  let cursor = 0,
    used = 0,
    now = 0;
  const stats = { emitted: 0, powderEmitted: 0 };
  function emit(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    distance: number,
    time: number,
    slip: number,
  ) {
    const dx = x2 - x1,
      dz = z2 - z1,
      length = Math.hypot(dx, dz);
    const half = WIDTH / 2 + Math.min(0.12, slip * 0.018),
      nx = (-dz / length) * half,
      nz = (dx / length) * half;
    sample((x1 + x2) * 0.5, (z1 + z2) * 0.5, scratch);
    if (scratch.coverage < 0.12 || scratch.depth < 0.012) return;
    const slot = cursor,
      oldCells = slotCells[slot];
    for (const key of oldCells) {
      const cell = bins.get(key);
      cell?.delete(slot);
      if (cell?.size === 0) bins.delete(key);
    }
    oldCells.length = 0;
    ax[slot] = x1;
    az[slot] = z1;
    bx[slot] = x2;
    bz[slot] = z2;
    born[slot] = time;
    widths[slot] = half;
    const points = [
      [x1 - nx, z1 - nz],
      [x1 + nx, z1 + nz],
      [x2 - nx, z2 - nz],
      [x2 + nx, z2 + nz],
    ];
    for (let v = 0; v < 4; v++) {
      const [x, z] = points[v];
      sample(x, z, scratch);
      const p = (slot * 4 + v) * 3,
        u = (slot * 4 + v) * 2,
        m = (slot * 4 + v) * 4;
      positions[p] = x;
      positions[p + 1] = scratch.height + 0.01;
      positions[p + 2] = z;
      uv[u] = v % 2;
      uv[u + 1] = distance + (v >= 2 ? length : 0);
      marks[m] = time;
      marks[m + 1] = scratch.coverage;
      marks[m + 2] = scratch.depth;
      marks[m + 3] = Math.min(1, slip / 4);
    }
    positionAttribute.addUpdateRange(slot * 12, 12);
    uvAttribute.addUpdateRange(slot * 8, 8);
    markAttribute.addUpdateRange(slot * 16, 16);
    for (
      let x = Math.floor((Math.min(x1, x2) - half) / CELL);
      x <= Math.floor((Math.max(x1, x2) + half) / CELL);
      x++
    )
      for (
        let z = Math.floor((Math.min(z1, z2) - half) / CELL);
        z <= Math.floor((Math.max(z1, z2) + half) / CELL);
        z++
      ) {
        const key = x + ':' + z;
        let cell = bins.get(key);
        if (!cell) {
          cell = new Set();
          bins.set(key, cell);
        }
        cell.add(slot);
        oldCells.push(key);
      }
    cursor = (cursor + 1) % CAPACITY;
    used = Math.min(CAPACITY, used + 1);
    stats.emitted++;
  }

  const powderGeometry = new THREE.BufferGeometry(),
    origins = new Float32Array(POWDER_COUNT * 3),
    kicks = new Float32Array(POWDER_COUNT * 3),
    births = new Float32Array(POWDER_COUNT).fill(-1000);
  const originAttribute = new THREE.BufferAttribute(origins, 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
    kickAttribute = new THREE.BufferAttribute(kicks, 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
    birthAttribute = new THREE.BufferAttribute(births, 1).setUsage(
      THREE.DynamicDrawUsage,
    );
  powderGeometry.setAttribute('position', originAttribute);
  powderGeometry.setAttribute('kick', kickAttribute);
  powderGeometry.setAttribute('birth', birthAttribute);
  powderGeometry.setDrawRange(0, 0);
  const powderUniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    time: { value: 0 },
    resolution: { value: 900 },
  };
  const powderMaterial = new THREE.ShaderMaterial({
    uniforms: powderUniforms,
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: `attribute vec3 kick;attribute float birth;uniform float time;uniform float resolution;varying float alpha;
      #include <fog_pars_vertex>
      void main(){float age=time-birth;vec3 p=position+kick*age;p.y-=age*age*2.1;
        vec4 mvPosition=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mvPosition;
        gl_PointSize=clamp(resolution*(.035+age*.09)/max(1.,-mvPosition.z),1.,14.);alpha=(1.-smoothstep(.08,.65,age))*.32;
        if(age<0.||age>.65||p.y<position.y-.035)gl_Position=vec4(2.,2.,2.,1.);
        #include <fog_vertex>
      }`,
    fragmentShader: `varying float alpha;
      #include <fog_pars_fragment>
      void main(){vec2 p=gl_PointCoord-.5;float a=(1.-smoothstep(.12,.49,length(p)))*alpha;if(a<.01)discard;
        gl_FragColor=vec4(.62,.70,.77,a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const powder = new THREE.Points(powderGeometry, powderMaterial);
  powder.name = 'Snow / displaced tire powder';
  powder.frustumCulled = false;
  powder.renderOrder = 3;
  scene.add(powder);
  let powderCursor = 0,
    powderUsed = 0,
    powderCooldown = 0;
  return {
    mesh,
    powder,
    stats,
    resetContinuity() {
      for (const p of last) p.valid = false;
    },
    compactionAt(x: number, z: number) {
      const cell = bins.get(Math.floor(x / CELL) + ':' + Math.floor(z / CELL));
      if (!cell) return 0;
      for (const i of cell) {
        if (now - born[i] > 240) continue;
        const dx = bx[i] - ax[i],
          dz = bz[i] - az[i];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - ax[i]) * dx + (z - az[i]) * dz) / (dx * dx + dz * dz),
          ),
        );
        if (
          Math.hypot(x - ax[i] - t * dx, z - az[i] - t * dz) <
          widths[i] * 0.8
        )
          return 1 - smoothFade(now - born[i]);
      }
      return 0;
    },
    update(
      time: number,
      contacts: readonly SnowContact[],
      yaw: number,
      speed: number,
      slip: number,
      height: number,
      delta: number,
    ) {
      now = time;
      uniforms.time.value = time;
      uniforms.carPosition.value.set(
        (contacts[0].x + contacts[3].x) / 2,
        0,
        (contacts[0].z + contacts[3].z) / 2,
      );
      powderUniforms.time.value = time;
      powderUniforms.resolution.value = height;
      const before = stats.emitted;
      positionAttribute.clearUpdateRanges();
      uvAttribute.clearUpdateRanges();
      markAttribute.clearUpdateRanges();
      for (let wheel = 0; wheel < 4; wheel++) {
        const c = contacts[wheel],
          p = last[wheel],
          length = Math.hypot(c.x - p.x, c.z - p.z);
        if (speed < 0.15 || c.coverage < 0.12 || c.depth < 0.012) {
          p.x = c.x;
          p.z = c.z;
          p.valid = false;
          continue;
        }
        if (!p.valid || length > 5) {
          p.x = c.x;
          p.z = c.z;
          p.valid = true;
          continue;
        }
        if (length < 0.09) continue;
        const steps = Math.ceil(length / 0.22),
          dx = (c.x - p.x) / steps,
          dz = (c.z - p.z) / steps;
        for (let j = 0; j < steps; j++) {
          const x = p.x + dx,
            z = p.z + dz;
          emit(p.x, p.z, x, z, p.distance, time, slip);
          p.distance += Math.hypot(dx, dz);
          p.x = x;
          p.z = z;
        }
      }
      if (stats.emitted > before) {
        positionAttribute.needsUpdate = true;
        uvAttribute.needsUpdate = true;
        markAttribute.needsUpdate = true;
        geometry.setDrawRange(0, used * 6);
      }
      powderCooldown -= delta;
      if (speed > 2 && powderCooldown <= 0) {
        for (const wheel of [1, 3]) {
          const c = contacts[wheel];
          if (c.coverage < 0.4 || c.depth < 0.04) continue;
          const i = powderCursor,
            o = i * 3,
            side = wheel === 1 ? -1 : 1;
          origins[o] = c.x;
          origins[o + 1] = c.height + 0.015;
          origins[o + 2] = c.z;
          kicks[o] =
            Math.cos(yaw) * side * (0.28 + speed * 0.015) +
            Math.sin(yaw) * 0.24;
          kicks[o + 1] = 0.48 + Math.min(speed, 25) * 0.024;
          kicks[o + 2] =
            -Math.sin(yaw) * side * (0.28 + speed * 0.015) +
            Math.cos(yaw) * 0.24;
          births[i] = time;
          originAttribute.addUpdateRange(o, 3);
          kickAttribute.addUpdateRange(o, 3);
          birthAttribute.addUpdateRange(i, 1);
          powderCursor = (i + 1) % POWDER_COUNT;
          powderUsed = Math.min(POWDER_COUNT, powderUsed + 1);
          stats.powderEmitted++;
        }
        if (powderUsed) {
          originAttribute.needsUpdate = true;
          kickAttribute.needsUpdate = true;
          birthAttribute.needsUpdate = true;
          powderGeometry.setDrawRange(0, powderUsed);
        }
        powderCooldown = 0.065;
      }
    },
  };
}
function smoothFade(age: number) {
  const t = Math.max(0, Math.min(1, (age - 150) / 90));
  return t * t * (3 - 2 * t);
}
