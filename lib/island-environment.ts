import * as THREE from 'three';
import { makeNorthernLights, northernLightsShader } from './northern-lights';
import {
  ISLAND_HALF_SIZE,
  ISLAND_CORNER_CUT,
  ISLAND_OUTLINE,
  OCEAN_LEVEL,
  DISTANT_SHORE_Z,
  DISTANT_CITY_Z,
} from './island-layout';

type Tower = {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  style: number;
};
type Part = {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  yaw?: number;
  seed?: number;
};

function randomGenerator(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function stoneTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const c = canvas.getContext('2d')!,
    random = randomGenerator(41);
  c.fillStyle = '#64696a';
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 18000; i++) {
    const shade = random() > 0.5 ? '210,217,213' : '16,25,29';
    c.fillStyle = `rgba(${shade},${0.03 + random() * 0.14})`;
    c.fillRect(
      random() * 256,
      random() * 256,
      0.4 + random() * 2,
      0.4 + random() * 2,
    );
  }
  c.strokeStyle = '#353e42';
  c.lineWidth = 2;
  for (let y = 0; y <= 256; y += 64) {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(256, y);
    c.stroke();
    for (let x = y % 128 ? 32 : 0; x < 256; x += 64) {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x, y + 64);
      c.stroke();
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return map;
}

function instances(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parts: Part[],
  parent: THREE.Object3D,
) {
  const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
  mesh.name = name;
  const matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    up = new THREE.Vector3(0, 1, 0);
  const seeds = new Float32Array(parts.length);
  parts.forEach((part, i) => {
    position.set(part.x, part.y, part.z);
    scale.set(part.w, part.h, part.d);
    quaternion.setFromAxisAngle(up, part.yaw || 0);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    seeds[i] = part.seed ?? i * 0.713;
  });
  geometry.setAttribute(
    'towerSeed',
    new THREE.InstancedBufferAttribute(seeds, 1),
  );
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}

function buildSkyline(parent: THREE.Group) {
  const random = randomGenerator(2821),
    towers: Tower[] = [];
  // A separate mainland, with a dense waterfront and a taller central business district.
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 56; column++) {
      const x = -1510 + column * 55 + (random() - 0.5) * 20;
      const z = DISTANT_CITY_Z - row * 125 + (random() - 0.5) * 65;
      const central = Math.exp(-Math.pow(x / 560, 2));
      const height = 46 + random() * (100 + central * 220) + row * 15;
      towers.push({
        x,
        z,
        width: 23 + random() * 23,
        depth: 27 + random() * 27,
        height,
        style: Math.floor(random() * 4),
      });
    }
  towers.push(
    { x: -85, z: -1680, width: 57, depth: 62, height: 465, style: 2 },
    { x: 175, z: -1850, width: 66, depth: 56, height: 395, style: 1 },
    { x: -410, z: -1800, width: 49, depth: 58, height: 340, style: 3 },
  );

  const towerParts: Part[] = [],
    roundParts: Part[] = [],
    roofParts: Part[] = [],
    antennaParts: Part[] = [],
    beacons: Part[] = [];
  for (const [i, t] of towers.entries()) {
    const tiers = t.style === 2 ? 4 : t.style === 1 ? 3 : 1;
    for (let tier = 0; tier < tiers; tier++) {
      const bottom = tier === 0 ? 0 : t.height * (0.64 + (tier - 1) * 0.12);
      const top =
        tier === tiers - 1 ? t.height : t.height * (0.64 + tier * 0.12);
      const inset = 1 - tier * 0.13;
      (t.style === 3 ? roundParts : towerParts).push({
        x: t.x,
        y: (top + bottom) / 2,
        z: t.z,
        w: t.width * inset,
        h: top - bottom,
        d: t.depth * inset,
        seed: i + t.style * 0.17,
      });
    }
    roofParts.push({
      x: t.x,
      y: t.height + 1,
      z: t.z,
      w: t.width * 0.55,
      h: 2,
      d: t.depth * 0.55,
    });
    for (let j = 0; j < 3; j++)
      roofParts.push({
        x: t.x + (j - 1) * t.width * 0.13,
        y: t.height + 3.5,
        z: t.z + 2,
        w: t.width * 0.1,
        h: 4,
        d: t.depth * 0.18,
      });
    if (t.height > 140) {
      const spire = t.height > 350 ? 35 : 9 + random() * 12;
      antennaParts.push({
        x: t.x,
        y: t.height + spire / 2,
        z: t.z,
        w: 0.75,
        h: spire,
        d: 0.75,
      });
      beacons.push({
        x: t.x,
        y: t.height + spire,
        z: t.z,
        w: 1.1,
        h: 1.1,
        d: 1.1,
      });
    }
  }
  const facade = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float towerSeed;
      varying vec3 vWorld; varying vec3 vNormal; varying float vSeed;
      void main() {
        vec4 local = vec4(position, 1.);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          n = normalize(mat3(instanceMatrix) * n);
        #endif
        vec4 world = modelMatrix * local;
        vWorld = world.xyz; vNormal = normalize(mat3(modelMatrix) * n); vSeed = towerSeed;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      varying vec3 vWorld; varying vec3 vNormal; varying float vSeed;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      void main() {
        float across = abs(vNormal.z) > .5 ? vWorld.x : vWorld.z;
        vec2 floorUv = vec2(across / 3.6 + vSeed * 13., vWorld.y / 3.5);
        vec2 cell = fract(floorUv), floorId = floor(floorUv);
        float window = smoothstep(.08,.14,cell.x) * (1.-smoothstep(.80,.86,cell.x))
          * smoothstep(.12,.18,cell.y) * (1.-smoothstep(.73,.79,cell.y));
        window *= 1.-step(.5,abs(vNormal.y));
        float occupancy = step(.49, hash(floorId + vSeed));
        occupancy *= step(.16, hash(vec2(floorId.y, floor(vSeed))));
        float warm = step(.38,hash(floorId*.17 + vSeed));
        vec3 lightColor = mix(vec3(.35,.55,.72),vec3(1.,.72,.40),warm);
        float lightLevel = .12 + hash(floorId + vSeed * 6.) * .30;
        vec3 glass = mix(vec3(.019,.033,.046), vec3(.045,.058,.063),fract(vSeed*.31));
        glass *= .65 + .35 * max(0.,dot(normalize(vNormal),normalize(vec3(.4,.7,.4))));
        vec2 pixelFootprint = fwidth(floorUv);
        float resolved = 1.-smoothstep(.35,1.8,max(pixelFootprint.x,pixelFootprint.y));
        float officeLight = mix(.055,window * occupancy * lightLevel,resolved);
        vec3 color = glass + lightColor * officeLight;
        float distanceFade = 1.-exp(-length(cameraPosition-vWorld)*.00020);
        color = mix(color,vec3(.025,.044,.063),distanceFade * .76);
        gl_FragColor = vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const towerMesh = instances(
    'Across the bay / detailed office towers',
    new THREE.BoxGeometry(1, 1, 1),
    facade,
    towerParts,
    parent,
  );
  instances(
    'Across the bay / curved glass towers',
    new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
    facade,
    roundParts,
    parent,
  );
  const roofMaterial = new THREE.MeshBasicMaterial({
    color: 0x293641,
    fog: false,
  });
  instances(
    'Across the bay / rooftop plant and crowns',
    new THREE.BoxGeometry(1, 1, 1),
    roofMaterial,
    roofParts,
    parent,
  );
  instances(
    'Across the bay / roof antennas',
    new THREE.BoxGeometry(1, 1, 1),
    roofMaterial,
    antennaParts,
    parent,
  );
  instances(
    'Across the bay / aviation beacons',
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xe68878, fog: false }),
    beacons,
    parent,
  );

  const mainland = new THREE.Mesh(
    new THREE.BoxGeometry(4000, 7, 1500),
    new THREE.MeshBasicMaterial({ color: 0x1b2832, fog: false }),
  );
  mainland.name = 'Across the bay / mainland';
  mainland.position.set(0, -3.65, DISTANT_SHORE_Z - 750);
  parent.add(mainland);
  const waterfront: Part[] = [],
    lights: Part[] = [];
  for (let i = 0; i < 200; i++) {
    const x = -1990 + i * 20;
    waterfront.push({ x, y: -2, z: DISTANT_SHORE_Z, w: 20, h: 4.5, d: 3 });
    lights.push({
      x,
      y: 2.2,
      z: DISTANT_SHORE_Z + 0.3,
      w: 1.2,
      h: 0.35,
      d: 0.35,
    });
  }
  instances(
    'Across the bay / waterfront seawall',
    new THREE.BoxGeometry(1, 1, 1),
    roofMaterial,
    waterfront,
    parent,
  );
  instances(
    'Across the bay / waterfront lights',
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xc2a37b, fog: false }),
    lights,
    parent,
  );
  return { towers, towerMesh };
}

function reflectionAtlas(towers: Tower[]) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 512;
  const c = canvas.getContext('2d')!,
    random = randomGenerator(713);
  c.clearRect(0, 0, 2048, 512);
  const sx = 2048 / 4000,
    sy = 512 / 540;
  for (const t of [...towers].sort((a, b) => a.z - b.z)) {
    const x = (t.x + 2000) * sx,
      w = t.width * sx,
      h = t.height * sy;
    c.fillStyle = '#182c3b';
    c.fillRect(x - w / 2, 512 - h, w, h);
    for (let y = 5; y < t.height; y += 7)
      for (let at = -t.width / 2 + 3; at < t.width / 2; at += 7) {
        if (random() < 0.54) continue;
        c.fillStyle = random() > 0.36 ? '#c2a17a' : '#7596b2';
        c.globalAlpha = 0.28 + random() * 0.55;
        c.fillRect(
          x + at * sx,
          512 - y * sy,
          Math.max(0.8, 3 * sx),
          Math.max(0.8, 2 * sy),
        );
      }
    c.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function addSky(parent: THREE.Group, aurora: ReturnType<typeof makeNorthernLights>) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4900, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: aurora.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 vDirection;
      void main(){vDirection=position;gl_Position=projectionMatrix*viewMatrix*vec4(cameraPosition+position,1.);}`,
      fragmentShader: `
      ${northernLightsShader}
      varying vec3 vDirection;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
      void main(){
        vec3 d=normalize(vDirection);float elevation=max(d.y,0.);
        vec3 color=mix(vec3(.032,.055,.080),vec3(.003,.007,.017),smoothstep(0.,.7,elevation));
        float clouds=noise(d.xz*7.+d.y*3.)*.65+noise(d.xz*17.)*.35;
        float lowBank=exp(-pow((d.y-.105)*6.,2.))*smoothstep(.42,.74,clouds);
        color+=vec3(.011,.014,.019)*lowBank;
        float cityGlow=exp(-pow(d.x*1.7,2.))*smoothstep(.3,.9,-d.z)*exp(-pow(d.y*8.,2.));
        color+=vec3(.022,.017,.010)*cityGlow;
        color+=northernLights(d, auroraDetail) * (1.-lowBank*.42);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    }),
  );
  sky.name = 'Island / blue hour sky and marine haze';
  sky.userData.dynamic = true;
  sky.frustumCulled = false;
  // Draw after opaque city geometry so the depth buffer rejects hidden sky pixels.
  sky.renderOrder = 10000;
  parent.add(sky);
  const moonMap = document.createElement('canvas');
  moonMap.width = moonMap.height = 128;
  const c = moonMap.getContext('2d')!,
    random = randomGenerator(221);
  c.fillStyle = '#d4dbdc';
  c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 80; i++) {
    const x = random() * 128,
      y = random() * 128,
      r = 1 + random() * 13;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(55,72,85,.24)');
    g.addColorStop(0.8, 'rgba(80,96,105,.08)');
    g.addColorStop(1, 'rgba(80,96,105,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const map = new THREE.CanvasTexture(moonMap);
  map.colorSpace = THREE.SRGBColorSpace;
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(24, 24, 16),
    new THREE.MeshBasicMaterial({ map, color: 0xc6d9e8, fog: false }),
  );
  moon.name = 'Island / moon';
  moon.position.set(-1850, 1150, -3750);
  parent.add(moon);
}

function addWater(parent: THREE.Group, reflection: THREE.Texture, aurora: ReturnType<typeof makeNorthernLights>) {
  const uniforms = {
    ...aurora.uniforms,
    time: { value: 0 },
    skylineReflection: { value: reflection },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.FrontSide,
    vertexShader: `
      uniform float time; varying vec3 vWorld; varying float vWave;
      void main(){
        vec3 p=position;
        float a=p.x*.043+p.z*.021-time*.85;
        float b=p.x*-.025+p.z*.079+time*.57;
        float wave=sin(a)*.24+sin(b)*.15;
        p.y+=wave;vWave=wave;
        vWorld=(modelMatrix*vec4(p,1.)).xyz;
        gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
      }`,
    fragmentShader: `
      ${northernLightsShader}
      uniform float time; uniform sampler2D skylineReflection;
      varying vec3 vWorld; varying float vWave;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
      void main(){
        vec2 p=vWorld.xz;
        float a=p.x*.043+p.y*.021-time*.85;
        float b=p.x*-.025+p.y*.079+time*.57;
        vec2 slope=vec2(.01032*cos(a)-.00375*cos(b),.00504*cos(a)+.01185*cos(b));
        float rippleFade=1.-smoothstep(180.,1500.,length(cameraPosition-vWorld));
        slope+=(vec2(noise(p*.32+vec2(time*.14,time*.09)),
          noise(p*.29+vec2(27.2+time*.11,-time*.13)))-.5)*.06*rippleFade;
        slope+=vec2(sin(p.x*1.8-p.y*.6+time*2.),cos(p.x*.9+p.y*1.7-time*1.5))*.004*rippleFade;
        vec3 normal=normalize(vec3(-slope.x,1.,-slope.y));
        vec3 view=normalize(cameraPosition-vWorld), ray=reflect(-view,normal);
        float fresnel=.035+.965*pow(1.-max(dot(view,normal),0.),5.);
        vec3 sky=mix(vec3(.016,.029,.043),vec3(.049,.075,.101),1.-smoothstep(0.,.7,ray.y));
        vec3 reflection=sky;
        reflection+=northernLights(ray, 0.)*.55;
        float t=(${DISTANT_CITY_Z.toFixed(1)}-vWorld.z)/min(ray.z,-.001);
        vec3 hit=vWorld+ray*t;
        vec2 atlasUv=vec2((hit.x+2000.)/4000.,hit.y/540.);
        if(ray.z<-.02&&t>0.&&atlasUv.x>0.&&atlasUv.x<1.&&atlasUv.y>0.&&atlasUv.y<1.){
          vec4 city=texture2D(skylineReflection,atlasUv);
          reflection=mix(reflection,city.rgb*.62,city.a*.75);
        }
        vec3 color=mix(vec3(.006,.019,.025),reflection, .28+fresnel*.72);
        vec3 moonDirection=normalize(vec3(-.42,.26,-.85));
        float moon=pow(max(dot(ray,moonDirection),0.),260.);
        color+=vec3(.48,.59,.68)*moon*(.2+.8*fresnel);
        float coast=max(max(abs(p.x),abs(p.y))-${ISLAND_HALF_SIZE.toFixed(1)},
          (abs(p.x)+abs(p.y)-${(ISLAND_HALF_SIZE * 2 - ISLAND_CORNER_CUT).toFixed(1)})*.7071);
        float shoreWave=sin(p.x*.16+p.y*.11-time*1.4)*.5+.5;
        float foam=exp(-pow((coast-1.5-shoreWave*1.2)/1.6,2.));
        foam*=.25+.25*sin(p.x*.8-p.y*.6+time*1.1)*sin(p.y*.93+time*.4);
        color=mix(color,vec3(.25,.34,.37),clamp(foam,0.,.45));
        float mist=1.-exp(-length(cameraPosition-vWorld)*.00016);
        color=mix(color,vec3(.028,.045,.060),mist*.7);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  // Normal shading supplies the small waves; the distant ocean needs only a coarse displacement grid.
  const geometry = new THREE.PlaneGeometry(9000, 9000, 180, 180);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Island / animated ocean';
  mesh.renderOrder = 9998;
  mesh.position.y = OCEAN_LEVEL;
  mesh.frustumCulled = false;
  parent.add(mesh);
  return { mesh, uniforms };
}

function addShore(parent: THREE.Group) {
  const map = stoneTexture();
  const stone = new THREE.MeshStandardMaterial({
    map,
    bumpMap: map,
    bumpScale: 0.06,
    color: 0x708087,
    roughness: 0.9,
    metalness: 0.05,
  });
  const paving = new THREE.MeshStandardMaterial({
    map,
    color: 0x424e55,
    roughness: 0.86,
    metalness: 0.09,
  });
  const shape = new THREE.Shape();
  ISLAND_OUTLINE.forEach(([x, z], i) =>
    i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z),
  );
  shape.closePath();
  const land = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, {
      depth: 6,
      bevelEnabled: false,
      steps: 1,
    }),
    [paving, stone],
  );
  land.geometry.rotateX(-Math.PI / 2);
  land.position.y = -6.19;
  land.name = 'Island / raised ground and stone seawall';
  land.receiveShadow = true;
  parent.add(land);
  const caps: Part[] = [],
    posts: Part[] = [],
    rails: Part[] = [],
    stones: Part[] = [],
    lamps: Part[] = [],
    lampsGlow: Part[] = [];
  const random = randomGenerator(677);
  for (let side = 0; side < ISLAND_OUTLINE.length; side++) {
    const [ax, az] = ISLAND_OUTLINE[side],
      [bx, bz] = ISLAND_OUTLINE[(side + 1) % ISLAND_OUTLINE.length];
    const length = Math.hypot(bx - ax, bz - az),
      tx = (bx - ax) / length,
      tz = (bz - az) / length;
    const nx = tz,
      nz = -tx,
      yaw = Math.atan2(tx, tz);
    const segments = Math.ceil(length / 8);
    for (let i = 0; i < segments; i++) {
      const along = ((i + 0.5) * length) / segments,
        x = ax + tx * along,
        z = az + tz * along;
      caps.push({
        x,
        y: 0.1,
        z,
        w: 1.4,
        h: 0.42,
        d: length / segments + 0.03,
        yaw,
      });
      posts.push({
        x: x - nx * 1.1,
        y: 0.85,
        z: z - nz * 1.1,
        w: 0.12,
        h: 1.65,
        d: 0.12,
      });
      for (const y of [0.6, 1.55])
        rails.push({
          x: x - nx * 1.1,
          y,
          z: z - nz * 1.1,
          w: 0.08,
          h: 0.08,
          d: length / segments + 0.08,
          yaw,
        });
      for (let j = 0; j < 2; j++)
        stones.push({
          x: x + nx * (1.8 + j * 1.9) + (random() - 0.5) * 1.2,
          y: OCEAN_LEVEL + 0.35 + random() * 0.45,
          z: z + nz * (1.8 + j * 1.9) + (random() - 0.5) * 1.2,
          w: 1.8 + random() * 2.6,
          h: 1 + random() * 1.4,
          d: 1.8 + random() * 2.4,
          yaw: random() * Math.PI,
        });
      if (i % 5 === 0) {
        const lx = x - nx * 7,
          lz = z - nz * 7;
        lamps.push({ x: lx, y: 2.8, z: lz, w: 0.14, h: 5.7, d: 0.14 });
        lamps.push({ x: lx, y: 5.65, z: lz, w: 1.5, h: 0.16, d: 0.5, yaw });
        lampsGlow.push({
          x: lx,
          y: 5.56,
          z: lz,
          w: 1.2,
          h: 0.055,
          d: 0.3,
          yaw,
        });
      }
    }
  }
  instances(
    'Island / seawall coping stones',
    new THREE.BoxGeometry(1, 1, 1),
    stone,
    caps,
    parent,
  );
  const steel = new THREE.MeshStandardMaterial({
    color: 0x5a676d,
    roughness: 0.44,
    metalness: 0.75,
  });
  instances(
    'Island / coastal rail posts',
    new THREE.BoxGeometry(1, 1, 1),
    steel,
    posts,
    parent,
  );
  instances(
    'Island / coastal guardrails',
    new THREE.BoxGeometry(1, 1, 1),
    steel,
    rails,
    parent,
  );
  instances(
    'Island / breakwater boulders',
    new THREE.IcosahedronGeometry(0.5, 0),
    stone,
    stones,
    parent,
  );
  instances(
    'Island / promenade lighting fixtures',
    new THREE.BoxGeometry(1, 1, 1),
    steel,
    lamps,
    parent,
  );
  instances(
    'Island / warm coastal lights',
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xe5bc88 }),
    lampsGlow,
    parent,
  );
  const piers: Part[] = [],
    piles: Part[] = [];
  for (const x of [-154, 154]) {
    piers.push({ x, y: -0.05, z: -444, w: 12, h: 0.5, d: 34 });
    for (const side of [-1, 1])
      for (const z of [-432, -442, -452, -461])
        piles.push({ x: x + side * 5, y: -2.6, z, w: 0.5, h: 6, d: 0.5 });
  }
  instances(
    'Island / harbor service piers',
    new THREE.BoxGeometry(1, 1, 1),
    paving,
    piers,
    parent,
  );
  instances(
    'Island / pier piles',
    new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
    steel,
    piles,
    parent,
  );
  return { land, stone, map, segments: caps.length };
}

function addBoats(parent: THREE.Group) {
  const boats: THREE.Group[] = [];
  const hull = new THREE.MeshStandardMaterial({
    color: 0x333f48,
    roughness: 0.58,
    metalness: 0.38,
  });
  const cabin = new THREE.MeshStandardMaterial({
    color: 0xa6ada8,
    roughness: 0.65,
    metalness: 0.15,
  });
  const glass = new THREE.MeshBasicMaterial({ color: 0x8b998b, fog: false });
  function piece(
    group: THREE.Group,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    material: THREE.Material,
  ) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
  }
  for (const [i, [x, z]] of [
    [-110, -540],
    [210, -820],
    [-450, -1010],
  ].entries()) {
    const boat = new THREE.Group();
    boat.name = 'Island / harbor vessel';
    boat.position.set(x, OCEAN_LEVEL + 0.25, z);
    boat.rotation.y = i * 0.9 - 0.4;
    piece(boat, 0, 0.3, 0, 3.5, 1.3, 12, hull);
    piece(boat, 0, 1.8, 1, 2.9, 2.2, 3.8, cabin);
    piece(boat, 0, 2.25, -0.95, 2.45, 0.8, 0.06, glass);
    piece(boat, -1.46, 2.2, 1, 0.04, 0.75, 2.8, glass);
    piece(boat, 1.46, 2.2, 1, 0.04, 0.75, 2.8, glass);
    piece(boat, 0, 3.8, 1, 0.1, 2, 0.1, hull);
    for (const side of [-1, 1])
      piece(
        boat,
        side * 1.5,
        2.9,
        1,
        0.25,
        0.12,
        0.25,
        new THREE.MeshBasicMaterial({
          color: side < 0 ? 0xc85443 : 0x6ba48b,
          fog: false,
        }),
      );
    piece(
      boat,
      0,
      4.85,
      1,
      0.2,
      0.15,
      0.2,
      new THREE.MeshBasicMaterial({ color: 0xd4c5a2, fog: false }),
    );
    parent.add(boat);
    boats.push(boat);
  }
  return boats;
}

/** Ocean waves and vessel motion update without allocating geometry or render targets. */
export function addIslandEnvironment(scene: THREE.Scene) {
  const group = new THREE.Group();
  group.name = 'Island / environment';
  const skyline = new THREE.Group();
  skyline.name = 'Across the bay / distant city';
  group.add(skyline);
  const { towers, towerMesh } = buildSkyline(skyline);
  const reflection = reflectionAtlas(towers);
  const aurora = makeNorthernLights();
  addSky(group, aurora);
  const water = addWater(group, reflection, aurora);
  const shore = addShore(group);
  const boats = addBoats(group);
  scene.add(group);
  return {
    group,
    skyline,
    water: water.mesh,
    land: shore.land,
    towerMesh,
    aurora,
    stats: {
      towers: towers.length,
      coastSegments: shore.segments,
      waterVertices: water.mesh.geometry.getAttribute('position').count,
      waterLevel: OCEAN_LEVEL,
      shorelineHalfSize: ISLAND_HALF_SIZE,
      mainlandShore: DISTANT_SHORE_Z,
    },
    update(time: number) {
      aurora.update(time);
      water.uniforms.time.value = time;
      boats.forEach((boat, i) => {
        boat.position.y = OCEAN_LEVEL + 0.25 + Math.sin(time * 0.8 + i) * 0.11;
        boat.rotation.z = Math.sin(time * 0.55 + i) * 0.018;
      });
    },
    dispose() {
      aurora.dispose();
      reflection.dispose();
      group.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
      });
    },
  };
}
