import * as THREE from 'three';
import { batchArchitecture } from './cinematic-city';

export const MINIGUN_SPIN = Math.PI * 16; // 480 rotor RPM, 2,880 rounds/min per gun.
export const BULLET_SPEED = 820;
export const SHOT_IMPULSE = 11.8; // Projectile and propellant momentum, N·s.
const BARREL_STEP = Math.PI / 3;
const CASE_LIMIT = 192;
type Casing = { position: THREE.Vector3; velocity: THREE.Vector3; rotation: THREE.Euler; spin: THREE.Vector3; life: number; bounced: boolean };
export type GunShot = { gun: number; position: THREE.Vector3; direction: THREE.Vector3; tracer: boolean };

function flashGeometry() {
  const positions: number[] = [], uvs: number[] = [];
  for (let plane = 0; plane < 3; plane++) {
    const angle = plane * Math.PI / 3;
    for (const [x, z, u, v] of [[-.12, 0, 0, 0], [.12, 0, 1, 0], [.12, -.48, 1, 1], [-.12, 0, 0, 0], [.12, -.48, 1, 1], [-.12, -.48, 0, 1]]) {
      positions.push(x * Math.cos(angle), x * Math.sin(angle), z); uvs.push(u, v);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function flashMaterial(seed: number) {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, seed: { value: seed }, power: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform float time, seed, power; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      void main(){
        float y=vUv.y, x=abs(vUv.x-.5)*2.0;
        float n=noise(vec2(vUv.x*9.0+seed,y*13.0-time*75.0));
        float width=(.62*(1.0-y)+.12)*(.58+.7*n);
        float edge=1.0-smoothstep(width*.25,width,x);
        float envelope=edge*(1.0-smoothstep(.35,1.0,y))*(.55+.45*n);
        float core=(1.0-smoothstep(.02,.24,x))*(1.0-smoothstep(.02,.42,y));
        vec3 color=mix(vec3(2.8,.32,.025),vec3(4.0,2.4,.65),envelope);
        color=mix(color,vec3(5.0,4.8,3.8),core);
        gl_FragColor=vec4(color,(envelope+core*.5)*power);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
  });
}

/** Exposed, permanently mounted weapons; only rigid metal is batched. */
export function createFrontMiniguns(parent: THREE.Object3D) {
  const mounts: THREE.Group[] = [], barrels: THREE.Group[] = [], muzzleAnchors: THREE.Object3D[] = [];
  const flashes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  const steel = new THREE.MeshStandardMaterial({ color: 0x52606c, metalness: .86, roughness: .28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222a32, metalness: .78, roughness: .42 });
  const bore = new THREE.MeshStandardMaterial({ color: 0x030405, metalness: .15, roughness: .95 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb58b43, metalness: .8, roughness: .32 });
  const cylinder = (group: THREE.Group, radius: number, length: number, z: number, material: THREE.Material, x = 0, y = 0) => {
    const segments = radius <= .006 ? 6 : radius < .02 ? 8 : 12;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material);
    mesh.rotation.x = Math.PI / 2; mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };
  for (const [index, x] of [-.52, .52].entries()) {
    const mount = new THREE.Group(); mount.name = `Front minigun / ${index === 0 ? 'left' : 'right'}`;
    mount.position.set(x, .46, -2.43); parent.add(mount); mounts.push(mount);
    mount.scale.setScalar(.66);
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(.25, .065, .32), dark);
    cradle.position.set(0, -.105, .03); mount.add(cradle);
    cylinder(mount, .104, .25, .025, dark);
    cylinder(mount, .108, .035, -.095, steel);
    for (const side of [-1, 1]) {
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(.026, .15, .17), steel);
      bracket.position.set(side * .122, -.033, .05); mount.add(bracket);
      cylinder(mount, .014, .025, -.045, brass, side * .122, -.015);
    }
    const feed = new THREE.Mesh(new THREE.BoxGeometry(.065, .095, .14), dark);
    feed.position.set(Math.sign(x) * .14, 0, .045); mount.add(feed);
    for (let link = 0; link < 5; link++) {
      cylinder(mount, .010, .075, .045, brass, Math.sign(x) * (.15 + link * .018), -.025 - link * .008);
    }
    const rotor = new THREE.Group(); rotor.name = 'Six exposed rotating barrels'; mount.add(rotor); barrels.push(rotor);
    cylinder(rotor, .019, .58, -.28, dark);
    for (let barrel = 0; barrel < 6; barrel++) {
      const a = barrel * BARREL_STEP, bx = Math.cos(a) * .068, by = Math.sin(a) * .068;
      cylinder(rotor, .016, .57, -.275, steel, bx, by);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(.014, .004, 4, 10), dark);
      lip.position.set(bx, by, -.573); rotor.add(lip);
      // Recessed black bore remains visible through the metal muzzle lip.
      const hole = new THREE.Mesh(new THREE.CircleGeometry(.010, 8), bore);
      hole.rotation.y = Math.PI; hole.position.set(bx, by, -.568); rotor.add(hole);
    }
    for (const z of [-.12, -.37, -.535]) {
      const collar = new THREE.Mesh(new THREE.TorusGeometry(.074, .012, 6, 18), dark);
      collar.position.z = z; rotor.add(collar);
      for (let bolt = 0; bolt < 6; bolt++) {
        const a = bolt * BARREL_STEP;
        cylinder(rotor, .006, .025, z, steel, Math.cos(a) * .084, Math.sin(a) * .084);
      }
    }
    batchArchitecture(rotor, true);
    rotor.traverse(part => { part.userData.dynamic = true; });
    batchArchitecture(mount);
    const anchor = new THREE.Object3D(); anchor.name = 'Live muzzle'; anchor.position.set(0, .068, -.585);
    rotor.add(anchor); muzzleAnchors.push(anchor);
    const flash = new THREE.Mesh(flashGeometry(), flashMaterial(index * 7.3));
    flash.name = 'Hot core and turbulent muzzle fire'; flash.visible = false;
    rotor.add(flash); flashes.push(flash);
    mount.traverse(part => { part.userData.dynamic = true; });
  }
  // Local warm spill keeps the flash grounded without another light in every city shader.
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.7), new THREE.ShaderMaterial({
    uniforms: { power: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `uniform float power; varying vec2 vUv;
      void main(){vec2 a=(vUv-vec2(.23,.5))*vec2(5.,2.8),b=(vUv-vec2(.77,.5))*vec2(5.,2.8);
      float spill=exp(-dot(a,a)*2.)+exp(-dot(b,b)*2.);
      gl_FragColor=vec4(1.4,.36,.055,spill*power*.24);}`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  glow.name = 'Miniguns / local muzzle glow'; glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, -.424, -2.81); glow.visible = false; glow.userData.dynamic = true;
  glow.userData.excludeFromReflection = true; parent.add(glow);
  const casingMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(.006, .007, .047, 6), brass, CASE_LIMIT);
  casingMesh.name = 'Ejected brass / gravity and pavement bounce'; casingMesh.count = 0; casingMesh.visible = false; casingMesh.frustumCulled = false;
  casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); casingMesh.userData.dynamic = true;
  const casings: Casing[] = [];
  const casingPool: Casing[] = Array.from({ length: CASE_LIMIT }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    rotation: new THREE.Euler(), spin: new THREE.Vector3(), life: 0, bounced: false }));
  const freeCasings = [...casingPool];
  const shots: GunShot[] = [];
  const shotPool: GunShot[] = Array.from({ length: 20 }, () => ({ gun: 0, position: new THREE.Vector3(), direction: new THREE.Vector3(), tracer: false }));
  const phase = [0, .5], recoil = [0, 0], recoilVelocity = [0, 0], heat = [0, 0], flashLife = [0, 0], shotCounts = [0, 0];
  const dummy = new THREE.Object3D(), direction = new THREE.Vector3(), casePosition = new THREE.Vector3(), ejection = new THREE.Vector3();
  let spin = 0;
  const reset = () => {
    spin = 0; casings.length = 0; casingMesh.count = 0; casingMesh.visible = false; glow.visible = false; glow.material.uniforms.power.value = 0;
    freeCasings.length = 0; freeCasings.push(...casingPool);
    for (let i = 0; i < 2; i++) {
      phase[i] = i * .5; recoil[i] = recoilVelocity[i] = heat[i] = flashLife[i] = shotCounts[i] = 0;
      barrels[i].position.z = 0; barrels[i].rotation.z = 0; flashes[i].visible = false;
    }
  };
  return {
    mounts, barrels, flashes, muzzleAnchors, glow, casingMesh, casings, heat, recoil, shotCounts,
    get spin() { return spin; }, reset,
    update(delta: number, firing: boolean, elapsed: number, vehicleVelocity: THREE.Vector3, quality = 0): GunShot[] {
      shots.length = 0;
      parent.updateWorldMatrix(true, false);
      for (const mount of mounts) mount.updateWorldMatrix(false, false);
      // Integrate the motor and damped recoil at 240 Hz, independent of render FPS.
      const steps = Math.max(1, Math.ceil(delta * 240)), dt = delta / steps;
      for (let step = 0; step < steps; step++) {
        spin = THREE.MathUtils.clamp(spin + dt * (firing ? MINIGUN_SPIN / .22 : -MINIGUN_SPIN / .65), 0, MINIGUN_SPIN);
        for (let i = 0; i < 2; i++) {
          const rotor = barrels[i]; rotor.rotation.z = (rotor.rotation.z + spin * dt) % (Math.PI * 2);
          recoilVelocity[i] += (-950 * recoil[i] - 48 * recoilVelocity[i]) * dt;
          recoil[i] = Math.max(0, recoil[i] + recoilVelocity[i] * dt);
          rotor.position.z = recoil[i];
          heat[i] = Math.max(0, heat[i] - dt * .20); flashLife[i] = Math.max(0, flashLife[i] - dt);
          if (!firing || spin < MINIGUN_SPIN * .18) continue;
          phase[i] += spin * dt / BARREL_STEP;
          while (phase[i] >= 1) {
            phase[i] -= 1; shotCounts[i]++;
            recoilVelocity[i] += .14; heat[i] = Math.min(1, heat[i] + .012); flashLife[i] = .018;
            const barrelAngle = Math.round((Math.PI / 2 - rotor.rotation.z) / BARREL_STEP) * BARREL_STEP;
            const anchor = muzzleAnchors[i]; anchor.position.set(Math.cos(barrelAngle) * .068, Math.sin(barrelAngle) * .068, -.585);
            flashes[i].position.copy(anchor.position); rotor.updateWorldMatrix(false, false);
            direction.set(0, 0, -1).transformDirection(rotor.matrixWorld);
            let shot = shotPool[shots.length];
            if (!shot) { shot = { gun: i, position: new THREE.Vector3(), direction: new THREE.Vector3(), tracer: false }; shotPool.push(shot); }
            shot.gun = i; shot.position.copy(anchor.position).applyMatrix4(rotor.matrixWorld); shot.direction.copy(direction);
            shot.tracer = shotCounts[i] % 3 === 0; shots.push(shot);
            if (quality >= 2 && shotCounts[i] % 2 !== 0) continue;
            casePosition.set(i === 0 ? -.155 : .155, .025, .05).applyMatrix4(mounts[i].matrixWorld);
            ejection.set(i === 0 ? -2.4 : 2.4, 1.4 + Math.random(), .4).transformDirection(mounts[i].matrixWorld).multiplyScalar(3.2).add(vehicleVelocity);
            const shell = freeCasings.pop() ?? casings.shift()!;
            shell.position.copy(casePosition); shell.velocity.copy(ejection); shell.rotation.set(Math.random()*3, Math.random()*3, 0);
            shell.spin.set(12+Math.random()*14, 8, 17); shell.life = 2; shell.bounced = false; casings.push(shell);
          }
        }
      }
      for (let i = 0; i < 2; i++) {
        const flash = flashes[i]; flash.visible = firing && flashLife[i] > 0;
        flash.material.uniforms.time.value = elapsed; flash.material.uniforms.power.value = .72 + Math.random() * .28;
        flash.scale.set(.85 + Math.random() * .3, .85 + Math.random() * .3, .6 + Math.random() * .55);
      }
      glow.visible = flashes.some(flash => flash.visible); glow.material.uniforms.power.value = glow.visible ? 1 : 0;
      for (let i = casings.length - 1; i >= 0; i--) {
        const shell = casings[i]; shell.life -= delta;
        if (shell.life <= 0) {
          freeCasings.push(shell); const last = casings.pop()!;
          if (i < casings.length) casings[i] = last;
          continue;
        }
        shell.velocity.y -= 9.81 * delta; shell.position.addScaledVector(shell.velocity, delta);
        if (shell.position.y < .04) {
          shell.position.y = .04;
          if (shell.velocity.y < -.35) { shell.velocity.y *= -.28; shell.velocity.x *= .6; shell.velocity.z *= .6; shell.bounced = true; }
          else { shell.velocity.set(0, 0, 0); shell.spin.set(0, 0, 0); }
        }
        shell.rotation.x += shell.spin.x * delta; shell.rotation.y += shell.spin.y * delta; shell.rotation.z += shell.spin.z * delta;
      }
      casings.forEach((shell, i) => {
        dummy.position.copy(shell.position); dummy.rotation.copy(shell.rotation); dummy.updateMatrix(); casingMesh.setMatrixAt(i, dummy.matrix);
      });
      casingMesh.count = casings.length; casingMesh.visible = casings.length > 0;
      if (casings.length > 0) {
        casingMesh.instanceMatrix.clearUpdateRanges(); casingMesh.instanceMatrix.addUpdateRange(0, casings.length * 16);
        casingMesh.instanceMatrix.needsUpdate = true;
      }
      return shots;
    },
  };
}
