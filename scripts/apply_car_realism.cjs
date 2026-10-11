const fs = require('fs');
const path = require('path');

const cityPath = path.join(__dirname, '..', 'lib', 'neon-city.ts');
let city = fs.readFileSync(cityPath, 'utf8');

// 1. Add properties to NeonCity class
const targetProps = `private readonly boostLights: THREE.PointLight[];
  private readonly muzzleFlashes: THREE.Mesh[];`;
const replaceProps = `private readonly boostLights: THREE.PointLight[];
  private readonly muzzleFlashes: THREE.Mesh[];
  private readonly brakeDiscs: THREE.Mesh[];
  private readonly reverseLights: THREE.Mesh[];
  private readonly gunBarrels: THREE.Group[];
  private brakeHeat = 0;
  private minigunRpm = 0;`;

if (city.includes(targetProps)) {
  city = city.replace(targetProps, replaceProps);
  console.log('✓ Added properties (LF)');
} else {
  const crlfTarget = targetProps.replace(/\n/g, '\r\n');
  const crlfReplace = replaceProps.replace(/\n/g, '\r\n');
  if (city.includes(crlfTarget)) {
    city = city.replace(crlfTarget, crlfReplace);
    console.log('✓ Added properties (CRLF)');
  } else {
    console.error('Failed to find targetProps');
    process.exit(1);
  }
}

// 2. Initialize in constructor
const targetInit = `this.boostLights = this.carRig.boostLights;
    this.muzzleFlashes = this.carRig.muzzleFlashes;
    this.glowMap = makeGlowTexture();`;
const replaceInit = `this.boostLights = this.carRig.boostLights;
    this.muzzleFlashes = this.carRig.muzzleFlashes;
    this.brakeDiscs = this.carRig.brakeDiscs;
    this.reverseLights = this.carRig.reverseLights;
    this.gunBarrels = this.carRig.gunBarrels;
    this.glowMap = makeGlowTexture();`;

if (city.includes(targetInit)) {
  city = city.replace(targetInit, replaceInit);
  console.log('✓ Added constructor assignments (LF)');
} else {
  const crlfTarget = targetInit.replace(/\n/g, '\r\n');
  const crlfReplace = replaceInit.replace(/\n/g, '\r\n');
  if (city.includes(crlfTarget)) {
    city = city.replace(crlfTarget, crlfReplace);
    console.log('✓ Added constructor assignments (CRLF)');
  } else {
    console.error('Failed to find targetInit');
    process.exit(1);
  }
}

// 3. Update dynamics loop (suspension pitch/roll, idle vibration, rotor thermal glow, reverse lights, gun spin)
const targetDynamics = `    for (const pivot of this.carRig.steering) pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, steer * .3, 1 - Math.exp(-delta * 12));
    const suspensionEase = 1 - Math.exp(-delta * 8);
    this.carRig.body.rotation.z = THREE.MathUtils.lerp(this.carRig.body.rotation.z, -steer * Math.min(this.velocity.length() / 40, 1) * .045, suspensionEase);
    this.carRig.body.rotation.x = THREE.MathUtils.lerp(this.carRig.body.rotation.x, throttle * .018, suspensionEase);
    this.carRig.body.position.y = Math.sin(this.elapsed * 13) * Math.min(this.velocity.length() / 60, 1) * .012;`;

const replaceDynamics = `    for (const pivot of this.carRig.steering) pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, steer * .3, 1 - Math.exp(-delta * 12));
    const suspensionEase = 1 - Math.exp(-delta * 8);

    // Dynamic firing detection
    const firing = key('f');

    // Realistic suspension pitch: nose dives under braking, squats under acceleration / boost
    const braking = key('s', 'arrowdown') || (longitudinal < -0.5 && this.velocity.length() > 5);
    const speedRatio = Math.min(this.velocity.length() / 35, 1);
    const targetPitch = braking
      ? -0.045 * Math.min(this.velocity.length() / 20, 1)
      : (throttle > 0 ? (boosting ? 0.042 : 0.022) : 0);
    this.carRig.body.rotation.x = THREE.MathUtils.lerp(this.carRig.body.rotation.x, targetPitch, suspensionEase);

    // Realistic body roll into / against cornering with lateral G response
    const targetRoll = -steer * speedRatio * (drifting ? 0.065 : 0.045);
    this.carRig.body.rotation.z = THREE.MathUtils.lerp(this.carRig.body.rotation.z, targetRoll, suspensionEase);

    // Engine idle vibration + high-speed road texture feedback + weapon recoil shudder
    const idleThrum = this.velocity.length() < 1 ? Math.sin(this.elapsed * 26) * 0.0018 : 0;
    const roadRumble = Math.sin(this.elapsed * 44) * speedRatio * 0.0035;
    const recoilShudder = firing ? (Math.random() - 0.5) * 0.006 : 0;
    this.carRig.body.position.y = idleThrum + roadRumble + recoilShudder;

    // Dynamic brake disc thermal heating & dissipation (glowing red-hot carbon rotors)
    if (braking) {
      this.brakeHeat = Math.min(1.0, this.brakeHeat + delta * 2.8);
    } else {
      this.brakeHeat = Math.max(0.0, this.brakeHeat - delta * 0.7);
    }
    for (const disc of this.brakeDiscs) {
      (disc.material as THREE.MeshStandardMaterial).emissiveIntensity = this.brakeHeat * 2.5;
    }

    // Reverse lights
    const reversing = longitudinal < -0.5;
    for (const revLight of this.reverseLights) {
      (revLight.material as THREE.MeshStandardMaterial).emissiveIntensity = reversing ? 2.2 : 0.0;
    }

    // Minigun barrel spinning & recoil kick
    if (firing) {
      this.minigunRpm = Math.min(65, this.minigunRpm + delta * 140);
    } else {
      this.minigunRpm = Math.max(0, this.minigunRpm - delta * 45);
    }
    for (const gun of this.gunBarrels) {
      gun.rotation.z += this.minigunRpm * delta;
      gun.position.z = firing ? -2.48 + (Math.sin(this.elapsed * 90) * 0.012) : -2.48;
    }`;

if (city.includes(targetDynamics)) {
  city = city.replace(targetDynamics, replaceDynamics);
  console.log('✓ Added dynamics (LF)');
} else {
  const crlfTarget = targetDynamics.replace(/\n/g, '\r\n');
  const crlfReplace = replaceDynamics.replace(/\n/g, '\r\n');
  if (city.includes(crlfTarget)) {
    city = city.replace(crlfTarget, crlfReplace);
    console.log('✓ Added dynamics (CRLF)');
  } else {
    console.error('Failed to find targetDynamics');
    process.exit(1);
  }
}

// 4. Remove duplicate `const firing = key('f');` lower down since we defined it above
const oldFiringDecl = `    // ── Firing system — continuous minigun ──
    const firing = key('f');`;
const newFiringDecl = `    // ── Firing system — continuous minigun ──`;

if (city.includes(oldFiringDecl)) {
  city = city.replace(oldFiringDecl, newFiringDecl);
  console.log('✓ Deduplicated firing variable (LF)');
} else {
  const crlfOld = oldFiringDecl.replace(/\n/g, '\r\n');
  const crlfNew = newFiringDecl.replace(/\n/g, '\r\n');
  if (city.includes(crlfOld)) {
    city = city.replace(crlfOld, crlfNew);
    console.log('✓ Deduplicated firing variable (CRLF)');
  } else {
    console.error('Failed to find oldFiringDecl');
    process.exit(1);
  }
}

fs.writeFileSync(cityPath, city, 'utf8');
console.log('✓ All vehicle realism dynamics applied successfully!');
