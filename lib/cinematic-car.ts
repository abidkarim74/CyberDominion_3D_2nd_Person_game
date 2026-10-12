import * as THREE from 'three';
import { batchArchitecture } from './cinematic-city';
import { addDriverDoor } from './car-door';
import { addDriverCockpit } from './driver-cockpit';
import { addBugattiWheelFace, createBugattiWheelGeometries } from './cyber-car-body';
import { addBlenderCarBody } from './blender-car';
import { addBugattiRearAero } from './bugatti-rear-aero';
import { createNitroEffects, NITRO_OUTLETS } from './nitro-effects';
import { createFrontMiniguns } from './front-miniguns';
import { addPerformanceTire, createPerformanceTireAssets } from './performance-tires';

/** Small repeating 2x2 twill; all fiber detail is generated once at startup. */
function makeCarbonTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#181b20';
  ctx.fillRect(0, 0, 64, 64);
  const step = 8;
  for (let y = 0; y < 64; y += step) {
    for (let x = 0; x < 64; x += step) {
      const isAlt = ((x / step - y / step + 8) % 4) < 2;
      const grad = isAlt
        ? ctx.createLinearGradient(x, y, x + step, y)
        : ctx.createLinearGradient(x, y, x, y + step);
      if (isAlt) {
        grad.addColorStop(0, '#1d2126');
        grad.addColorStop(0.5, '#353a40');
        grad.addColorStop(1, '#1c2025');
      } else {
        grad.addColorStop(0, '#14181d');
        grad.addColorStop(0.5, '#2a3036');
        grad.addColorStop(1, '#15191e');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, step, step);
      ctx.strokeStyle = isAlt ? 'rgba(115,126,139,.14)' : 'rgba(111,122,134,.1)';
      ctx.lineWidth = .45;
      for (let fiber = 1; fiber < step; fiber += 2) {
        ctx.beginPath();
        if (isAlt) { ctx.moveTo(x + fiber, y); ctx.lineTo(x + fiber, y + step); }
        else { ctx.moveTo(x, y + fiber); ctx.lineTo(x + step, y + fiber); }
        ctx.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(12, 12);
  return texture;
}

/** Procedural cross-drilled carbon-ceramic brake rotor */
function makeRotorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#77818a';
  ctx.fillRect(0, 0, 128, 128);

  // Concentric machining wear rings
  for (let r = 24; r < 60; r += 2) {
    ctx.beginPath();
    ctx.arc(64, 64, r, 0, Math.PI * 2);
    ctx.strokeStyle = r % 4 === 0 ? '#a0a9b2' : '#636e79';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Cross-drilled circular cooling holes
  ctx.fillStyle = '#080a0d';
  for (let spoke = 0; spoke < 12; spoke++) {
    const baseAngle = (spoke / 12) * Math.PI * 2;
    for (let h = 0; h < 5; h++) {
      const radius = 28 + h * 6;
      const angle = baseAngle + h * 0.12;
      const x = 64 + Math.cos(angle) * radius;
      const y = 64 + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Dark anodized center hat
  ctx.beginPath();
  ctx.arc(64, 64, 22, 0, Math.PI * 2);
  ctx.fillStyle = '#111418';
  ctx.fill();
  ctx.strokeStyle = '#5a636d';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Small wheel crest, shared by all four center caps. */
function makeWheelBadgeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#121720'; ctx.fillRect(0, 0, 64, 64);
  ctx.beginPath(); ctx.ellipse(32, 32, 24, 17, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#8f1522'; ctx.fill();
  ctx.strokeStyle = '#c7d0d8'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#eff4f8'; ctx.font = 'bold 22px Georgia';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('EB', 32, 33);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function makeCar() {
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);

  // ── Textures ──
  const carbonTexture = makeCarbonTexture();
  const rotorMap = makeRotorTexture();
  const tireAssets = createPerformanceTireAssets();

  // Pearl-white lacquer keeps the entire silhouette readable in the night city.
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xf4f5f2,
    metalness: 0.08,
    roughness: 0.23,
    clearcoat: 1.0,
    clearcoatRoughness: 0.14,
    ior: 1.54,
    envMapIntensity: 1.35,
  });
  paint.name = 'Bugatti / pearl white gloss clearcoat';
  paint.userData.vehiclePaint = true;
  const secondaryPaint = paint.clone();
  secondaryPaint.name = 'Bugatti / pearl white rear shell';

  // Authentic 2x2 twill weave carbon fiber with micro bump definition
  const carbon = new THREE.MeshPhysicalMaterial({
    color: 0x20252a,
    // The source includes thin carbon laminations visible from both sides.
    side: THREE.DoubleSide,
    map: carbonTexture,
    metalness: 0.12,
    roughness: 0.4,
    clearcoat: 0.85,
    clearcoatRoughness: 0.22,
    bumpMap: carbonTexture,
    bumpScale: 0.0007,
    envMapIntensity: 1.15,
  });
  carbon.name = 'Car / resin-coated woven carbon';

  // Aerospace brushed alloy & titanium
  const alloy = new THREE.MeshStandardMaterial({
    color: 0x7b8790,
    metalness: 0.96,
    roughness: 0.28,
    envMapIntensity: 1.25,
  });
  alloy.name = 'Car / machined gunmetal alloy';
  const wheelAlloy = new THREE.MeshStandardMaterial({
    color: 0x87919a, metalness: .88, roughness: .28, envMapIntensity: 1.25,
  });
  wheelAlloy.name = 'Bugatti / satin titanium forged wheels';
  const polishedRim = new THREE.MeshStandardMaterial({
    color: 0xc5cbd0, metalness: .96, roughness: .19, envMapIntensity: 1.4,
  });
  polishedRim.name = 'Bugatti / polished machined wheel lips';
  const wheelBadge = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: makeWheelBadgeTexture(), metalness: .25, roughness: .27,
  });

  // Tinted, reflective glass keeps the cockpit visible without a second full-city refraction render.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x151c22,
    metalness: 0.03,
    roughness: 0.22,
    specularIntensity: 0.5,
    transmission: 0,
    opacity: 0.88,
    depthWrite: false,
    transparent: true,
    ior: 1.52,
    clearcoat: 0.35,
    clearcoatRoughness: 0.26,
    envMapIntensity: 0.65,
  });
  glass.name = 'Car / smoked laminated canopy';

  // Cockpit indicators and automotive LED emitters.
  const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xcd8847).multiplyScalar(.9), toneMapped: false });
  cyan.name = 'Bugatti / warm cabin accent lighting';
  const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf0f6ff).multiplyScalar(2.4), toneMapped: false });
  const redAccent = new THREE.MeshStandardMaterial({ color: 0xc5091b, metalness: .25, roughness: .30 });

  const amber = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb45c).multiplyScalar(1.05), toneMapped: false });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x480308,
    emissive: 0xee1422,
    emissiveIntensity: 1.8,
    roughness: .25,
  });

  // Dynamic cross-drilled carbon-ceramic brake disc material (supports thermal red-hot glow on hard braking)
  const brakeDiscMat = new THREE.MeshStandardMaterial({
    color: 0x8e949b,
    map: rotorMap,
    bumpMap: rotorMap,
    bumpScale: 0.0015,
    metalness: 0.72,
    roughness: 0.39,
    emissive: new THREE.Color(0xff3300),
    emissiveIntensity: 0.0,
  });

  // Red monobloc calipers are visible through the open forged-wheel spokes.
  const caliperMat = new THREE.MeshStandardMaterial({
    color: 0xc5091b,
    metalness: 0.38,
    roughness: 0.31,
  });

  // Helper box creator
  const box = (parent: THREE.Group, size: number[], pos: number[], material: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size as [number, number, number]), material);
    m.position.set(...pos as [number, number, number]); parent.add(m); return m;
  };

  const trim = new THREE.MeshStandardMaterial({ color: 0x11191f, metalness: .25, roughness: .55 });
  trim.name = 'Car / recessed satin trim';
  const { headlights, brakeLights } = addBlenderCarBody(body, { paint, secondaryPaint, carbon, alloy, amber, glass, trim, redAccent, white, red: brakeMat });
  addBugattiRearAero(body, { carbon, paint, trim, alloy });

  const cockpit = addDriverCockpit(body, { carbon, alloy, cyan });

  // ═══════════════════════════════════════════════════════
  // 5. HYPER-DETAILED WHEELS, TIRES & DYNAMIC BRAKES
  // ═══════════════════════════════════════════════════════
  const wheels: THREE.Group[] = [];
  const steering: THREE.Group[] = [];
  const brakeDiscs: THREE.Mesh[] = [];

  const rotorGeo = new THREE.CylinderGeometry(.244, .244, .018, 40);
  const pistonGeo = new THREE.CylinderGeometry(.016, .016, .01, 12);
  const wheelGeometries = createBugattiWheelGeometries();
  const caliperShape = new THREE.Shape();
  caliperShape.moveTo(-.028, -.078); caliperShape.lineTo(.028, -.078);
  caliperShape.quadraticCurveTo(.047, -.078, .047, -.055);
  caliperShape.lineTo(.047, .055); caliperShape.quadraticCurveTo(.047, .078, .028, .078);
  caliperShape.lineTo(-.028, .078); caliperShape.quadraticCurveTo(-.047, .078, -.047, .055);
  caliperShape.lineTo(-.047, -.055); caliperShape.quadraticCurveTo(-.047, -.078, -.028, -.078);
  const caliperGeo = new THREE.ExtrudeGeometry(caliperShape, { depth: .045, bevelEnabled: true, bevelSize: .003, bevelThickness: .003, bevelSegments: 1, curveSegments: 3, steps: 1 });

  for (const side of [-1, 1]) for (const axle of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (axle < 0 ? .827 : .8075), .385, axle * 1.43);
    car.add(pivot);
    if (axle < 0) steering.push(pivot);

    const wheel = new THREE.Group();
    wheel.name = 'Bugatti / forged wheel and performance tire';
    wheel.userData.side = side;
    pivot.add(wheel);
    wheels.push(wheel);

    addPerformanceTire(wheel, side, tireAssets);

    const face = side * .108;

    addBugattiWheelFace(wheel, side, face, { alloy: wheelAlloy, lip: polishedRim, carbon, hub: wheelBadge }, wheelGeometries);

    // Carbon-ceramic cross-drilled rotor (marked dynamic for thermal braking glow)
    const disc = new THREE.Mesh(rotorGeo, brakeDiscMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = face - side * .04;
    disc.userData.dynamic = true;
    wheel.add(disc);
    brakeDiscs.push(disc);

    // High performance 6-piston monobloc brake caliper
    const caliper = new THREE.Mesh(caliperGeo, caliperMat);
    caliper.position.set(face - side * .020, .08, .19);
    caliper.rotation.set(-.4, side * Math.PI / 2, 0);
    pivot.add(caliper);
    // Caliper dual piston details
    for (const p of [-.04, .04]) {
      const piston = new THREE.Mesh(pistonGeo, alloy);
      piston.rotation.z = Math.PI / 2;
      piston.position.set(face - side * .035, .08 + p, .19);
      pivot.add(piston);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 6. HEADLIGHTS & FRONT LIGHTING
  // ═══════════════════════════════════════════════════════
  const headlightBeams: THREE.SpotLight[] = [];

  for (const side of [-1, 1]) {
    // Realistic front spotlight beam
    const light = new THREE.SpotLight(0xe1edff, 110, 48, .42, .82, 1.5);
    light.position.set(side * .700, .650, -2.0);
    light.target.position.set(side * 1.8, 0, -26);
    car.add(light, light.target);
    headlightBeams.push(light);
  }

  // ═══════════════════════════════════════════════════════
  // 7. AUTHENTIC 6-BARREL ROTARY MINIGUNS
  // ═══════════════════════════════════════════════════════
  const miniguns = createFrontMiniguns(body);
  const gunBarrels = miniguns.barrels;
  const muzzleFlashes = miniguns.flashes;

  // ═══════════════════════════════════════════════════════
  // 8. TAILLIGHTS, REVERSE LIGHTS & TITANIUM EXHAUSTS
  // ═══════════════════════════════════════════════════════
  // Xenon reverse lights (illuminate when reversing)
  const reverseMat = new THREE.MeshStandardMaterial({
    color: 0x101520,
    emissive: 0xe8f4ff,
    emissiveIntensity: 0.0,
    roughness: .2,
  });
  const reverseLights = [
    box(body, [.09, .014, .012], [-.19, .540, 2.395], reverseMat),
    box(body, [.09, .014, .012], [.19, .540, 2.395], reverseMat),
  ];

  // Keep the native center cans; add compact outlets at both bumper ends.
  const exhausts: THREE.Mesh[] = [];
  const flames: THREE.Mesh[] = [];
  const exhaustCoreGeo = new THREE.CylinderGeometry(.033, .033, .08, 16);
  const exhaustCoreMat = new THREE.MeshStandardMaterial({ color: 0x080b0e, metalness: .55, roughness: .65, emissive: 0x0c6321, emissiveIntensity: .3 });
  const sideNozzleGeo = new THREE.CylinderGeometry(.078, .065, .16, 16, 1, true);
  const sideCoreGeo = new THREE.CylinderGeometry(.057, .057, .08, 16);

  for (const outlet of NITRO_OUTLETS) {
    const sideOutlet = Math.abs(outlet.x) > .5;
    if (sideOutlet) {
      const nozzle = new THREE.Mesh(sideNozzleGeo, alloy);
      nozzle.name = 'Nitro / titanium bumper-end outlet';
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(outlet.x, outlet.y, outlet.z - .08);
      body.add(nozzle);
    }
    // Internal catalyst core mesh glowing with heat
    const core = new THREE.Mesh(sideOutlet ? sideCoreGeo : exhaustCoreGeo, exhaustCoreMat);
    core.rotation.x = Math.PI / 2;
    core.position.set(outlet.x, outlet.y, outlet.z - (sideOutlet ? .045 : .09));
    body.add(core);
    exhausts.push(core);
  }
  const nitroEffects = createNitroEffects(body);

  // ═══════════════════════════════════════════════════════
  // 9. UNDERGLOW & SHADOW
  // ═══════════════════════════════════════════════════════
  const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64;
  const ctx = glowCanvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff'); gradient.addColorStop(.35, '#aaa'); gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  const glowMap = new THREE.CanvasTexture(glowCanvas);

  const underglow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.4),
    new THREE.MeshBasicMaterial({ color: 0x00a5bb, alphaMap: glowMap, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  underglow.rotation.x = -Math.PI / 2; underglow.position.y = .04;
  underglow.visible = false; car.add(underglow);

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 5.9),
    new THREE.MeshBasicMaterial({ color: 0x000006, alphaMap: glowMap, transparent: true, opacity: .9, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .037; car.add(shadow);

  // Nitrous glow uses the effects' existing draw, avoiding another per-pixel city light.
  const boostLights: THREE.PointLight[] = [];

  // These emitters animate a shared material while their geometry stays fixed
  // within the body. Consolidate each set and keep its live material controls.
  for (const emitters of [reverseLights, exhausts]) {
    const assembly = new THREE.Group();
    assembly.name = 'Bugatti / shared animated emitters';
    assembly.userData.dynamic = true;
    body.add(assembly);
    for (const mesh of emitters) assembly.attach(mesh);
    batchArchitecture(assembly, true);
    emitters.splice(0, emitters.length, ...assembly.children.filter((part): part is THREE.Mesh => part instanceof THREE.Mesh));
  }

  // Mark all dynamic and animated parts so batching never merges them
  for (const part of [...headlights, ...brakeLights, ...reverseLights, ...exhausts, ...brakeDiscs, ...gunBarrels, ...muzzleFlashes]) {
    part.userData.dynamic = true;
    part.traverse(c => { c.userData.dynamic = true; });
  }

  const driverDoor = addDriverDoor(body);

  // Batch static architecture
  batchArchitecture(body);
  const wheelGeometryCache = new Map<string, THREE.BufferGeometry>();
  for (const wheel of wheels) {
    const parent = wheel.parent!;
    parent.remove(wheel);
    batchArchitecture(wheel);
    // Front and rear wheels on each side reuse the same final GPU buffers.
    for (const child of wheel.children) {
      if (!(child instanceof THREE.Mesh) || child.userData.dynamic) continue;
      const key = `${wheel.userData.side}:${(child.material as THREE.Material).uuid}`;
      const shared = wheelGeometryCache.get(key);
      if (shared) { child.geometry.dispose(); child.geometry = shared; }
      else wheelGeometryCache.set(key, child.geometry);
    }
    parent.add(wheel);
  }

  car.traverse(object => {
    if (object instanceof THREE.Mesh && (object.material as THREE.Material).userData.cockpitDetail) object.userData.cockpitDetail = true;
    if (object instanceof THREE.Mesh && !(object.material as THREE.Material).transparent && !object.userData.cockpitDetail) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  car.position.y = .015;

  return {
    car, body, cockpit, driverDoor, wheels, steering, flames, brakeLights, exhausts,
    headlights, underglow, boostLights, nitroEffects, miniguns, gunBarrels,
    muzzleFlashes, brakeDiscs, reverseLights, headlightBeams
  };
}
