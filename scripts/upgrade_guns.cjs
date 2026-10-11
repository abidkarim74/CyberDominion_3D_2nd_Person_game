const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════
// 1. UPGRADE AUDIO — Continuous minigun sound
// ═══════════════════════════════════════════════════════
const audioPath = path.join(__dirname, '..', 'lib', 'city-audio.ts');
let audio = fs.readFileSync(audioPath, 'utf8');

// Add minigun state fields
audio = audio.replace(
  'private gunNoiseBuffer?: AudioBuffer;',
  `private gunNoiseBuffer?: AudioBuffer;
  private minigunSource?: AudioBufferSourceNode;
  private minigunGain?: GainNode;
  private minigunFilter?: BiquadFilterNode;
  private minigunSpinOsc?: OscillatorNode;
  private minigunSpinGain?: GainNode;
  private minigunActive = false;
  private minigunSpinUp = 0;`
);

// Replace the gun noise buffer creation and add minigun loop buffer
audio = audio.replace(
  `// Pre-generate a short noise buffer for gun crack
      const gunNoiseLen = Math.floor(context.sampleRate * 0.08);
      const gunNoiseBuf = context.createBuffer(1, gunNoiseLen, context.sampleRate);
      const gunData = gunNoiseBuf.getChannelData(0);
      for (let i = 0; i < gunNoiseLen; i++) gunData[i] = Math.random() * 2 - 1;
      this.gunNoiseBuffer = gunNoiseBuf;`,
  `// Pre-generate a short noise buffer for gun crack
      const gunNoiseLen = Math.floor(context.sampleRate * 0.08);
      const gunNoiseBuf = context.createBuffer(1, gunNoiseLen, context.sampleRate);
      const gunData = gunNoiseBuf.getChannelData(0);
      for (let i = 0; i < gunNoiseLen; i++) gunData[i] = Math.random() * 2 - 1;
      this.gunNoiseBuffer = gunNoiseBuf;

      // Continuous minigun loop — layered noise burst for rapid-fire rattling
      const minigunLen = Math.floor(context.sampleRate * 0.5);
      const minigunBuf = context.createBuffer(1, minigunLen, context.sampleRate);
      const mgData = minigunBuf.getChannelData(0);
      // Generate a rapid periodic burst pattern (~40 rounds/sec)
      const burstRate = 40;
      const samplesPerBurst = Math.floor(context.sampleRate / burstRate);
      for (let i = 0; i < minigunLen; i++) {
        const phase = i % samplesPerBurst;
        const burstEnv = phase < samplesPerBurst * 0.3 ? 1 - (phase / (samplesPerBurst * 0.3)) : 0;
        const noise = Math.random() * 2 - 1;
        mgData[i] = noise * burstEnv * 0.9;
      }
      const minigunSource = context.createBufferSource();
      minigunSource.buffer = minigunBuf;
      minigunSource.loop = true;
      // Bandpass for metallic rattle
      const minigunFilter = context.createBiquadFilter();
      minigunFilter.type = 'bandpass';
      minigunFilter.frequency.value = 1800;
      minigunFilter.Q.value = 0.8;
      const minigunGain = context.createGain();
      minigunGain.gain.value = 0;
      minigunSource.connect(minigunFilter);
      minigunFilter.connect(minigunGain);
      minigunGain.connect(gunMasterGain);
      minigunSource.start();
      this.minigunSource = minigunSource;
      this.minigunGain = minigunGain;
      this.minigunFilter = minigunFilter;
      this.nodes.push(minigunFilter, minigunGain, minigunSource);

      // Barrel spin whine oscillator
      const spinOsc = context.createOscillator();
      spinOsc.type = 'sawtooth';
      spinOsc.frequency.value = 60;
      const spinGain = context.createGain();
      spinGain.gain.value = 0;
      const spinFilter = context.createBiquadFilter();
      spinFilter.type = 'bandpass';
      spinFilter.frequency.value = 420;
      spinFilter.Q.value = 2.5;
      spinOsc.connect(spinFilter);
      spinFilter.connect(spinGain);
      spinGain.connect(gunMasterGain);
      spinOsc.start();
      this.minigunSpinOsc = spinOsc;
      this.minigunSpinGain = spinGain;
      this.oscillators.push(spinOsc);
      this.nodes.push(spinFilter, spinGain);`
);

// Replace the fireGun method with startFiring/stopFiring + enhanced single shot
const oldFireGun = `  /** Fire a single procedural gunshot sound. */
  fireGun() {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running' || !this.gunMaster || !this.gunNoiseBuffer) return;
    const t = ctx.currentTime;
    // Noise crack
    const noise = ctx.createBufferSource(); noise.buffer = this.gunNoiseBuffer;
    const bandpass = ctx.createBiquadFilter(); bandpass.type = 'bandpass'; bandpass.frequency.value = 2200; bandpass.Q.value = 1.2;
    const noiseEnv = ctx.createGain(); noiseEnv.gain.setValueAtTime(.42, t);
    noiseEnv.gain.exponentialRampToValueAtTime(.001, t + .06);
    noise.connect(bandpass); bandpass.connect(noiseEnv); noiseEnv.connect(this.gunMaster);
    noise.start(t); noise.stop(t + .07);
    // Low thump
    const thump = ctx.createOscillator(); thump.type = 'sine'; thump.frequency.setValueAtTime(180, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + .05);
    const thumpEnv = ctx.createGain(); thumpEnv.gain.setValueAtTime(.35, t);
    thumpEnv.gain.exponentialRampToValueAtTime(.001, t + .06);
    thump.connect(thumpEnv); thumpEnv.connect(this.gunMaster);
    thump.start(t); thump.stop(t + .07);
  }`;

const newFireGun = `  /** Start or maintain minigun firing — call every frame while trigger is held. */
  fireGun() {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running' || !this.gunMaster || !this.gunNoiseBuffer) return;
    if (!this.minigunActive) {
      this.minigunActive = true;
      this.minigunSpinUp = 0;
    }
    this.minigunSpinUp = Math.min(1, this.minigunSpinUp + 0.08);
    const t = ctx.currentTime;
    // Continuous minigun rattle volume
    if (this.minigunGain) {
      this.minigunGain.gain.setTargetAtTime(0.38 * this.minigunSpinUp, t, 0.02);
    }
    // Barrel spin whine ramps up
    if (this.minigunSpinGain) {
      this.minigunSpinGain.gain.setTargetAtTime(0.025 * this.minigunSpinUp, t, 0.03);
    }
    if (this.minigunSpinOsc) {
      this.minigunSpinOsc.frequency.setTargetAtTime(60 + 340 * this.minigunSpinUp, t, 0.04);
    }
    if (this.minigunFilter) {
      this.minigunFilter.frequency.setTargetAtTime(1400 + 1200 * this.minigunSpinUp, t, 0.03);
    }
    // Per-shot metallic crack layered on top (reduced rate to avoid saturation)
    if (Math.random() < 0.35) {
      const noise = ctx.createBufferSource(); noise.buffer = this.gunNoiseBuffer;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800 + Math.random() * 800; bp.Q.value = 1.5;
      const env = ctx.createGain(); env.gain.setValueAtTime(0.18 * this.minigunSpinUp, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      noise.connect(bp); bp.connect(env); env.connect(this.gunMaster);
      noise.start(t); noise.stop(t + 0.05);
      // Shell casing clink
      const clink = ctx.createOscillator(); clink.type = 'sine';
      clink.frequency.setValueAtTime(4200 + Math.random() * 1800, t);
      clink.frequency.exponentialRampToValueAtTime(1200, t + 0.03);
      const clinkEnv = ctx.createGain(); clinkEnv.gain.setValueAtTime(0.04, t);
      clinkEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      clink.connect(clinkEnv); clinkEnv.connect(this.gunMaster);
      clink.start(t); clink.stop(t + 0.03);
    }
  }

  /** Stop minigun firing — call when trigger released. */
  stopFiring() {
    if (!this.minigunActive) return;
    this.minigunActive = false;
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // Spin down
    if (this.minigunGain) this.minigunGain.gain.setTargetAtTime(0, t, 0.15);
    if (this.minigunSpinGain) this.minigunSpinGain.gain.setTargetAtTime(0, t, 0.3);
    if (this.minigunSpinOsc) this.minigunSpinOsc.frequency.setTargetAtTime(60, t, 0.4);
    this.minigunSpinUp = 0;
  }`;

audio = audio.replace(oldFireGun, newFireGun);

fs.writeFileSync(audioPath, audio, 'utf8');
console.log('✓ Audio upgraded to minigun sound');

// ═══════════════════════════════════════════════════════
// 2. UPGRADE BULLETS — Thicker, realistic projectile trails
// 3. UPGRADE SMOKE — Gunsmoke particles from barrels
// ═══════════════════════════════════════════════════════
const cityPath = path.join(__dirname, '..', 'lib', 'neon-city.ts');
let city = fs.readFileSync(cityPath, 'utf8');

// Add smoke particle type and arrays
city = city.replace(
  "type Bullet = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; trail: THREE.Vector3[] };",
  "type Bullet = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; trail: THREE.Vector3[] };\ntype SmokeParticle = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; maxLife: number; size: number; opacity: number };"
);

// Add smoke system fields after bulletTrails
city = city.replace(
  "  private bulletGunIndex = 0; // alternates between left/right gun",
  `  private bulletGunIndex = 0; // alternates between left/right gun
  private readonly smokeParticles: SmokeParticle[] = [];
  private readonly smokeGeometry = new THREE.BufferGeometry();
  private readonly smokePositions = new Float32Array(300 * 3);
  private readonly smokeSizes = new Float32Array(300);
  private readonly smokeOpacities = new Float32Array(300);
  private readonly smokeMesh: THREE.Points;
  private gunSmokeTimer = 0;`
);

// Update bullet trail material — make it brighter and more visible
city = city.replace(
  `this.bulletTrails = new THREE.LineSegments(
      this.bulletGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        linewidth: 2,
      }),
    );`,
  `this.bulletTrails = new THREE.LineSegments(
      this.bulletGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        linewidth: 2,
      }),
    );`
);

// After bulletTrails scene.add, add smoke particle system initialization
city = city.replace(
  "this.scene.add(this.bulletTrails);",
  `this.scene.add(this.bulletTrails);
    // ── Gun smoke particle system ──
    this.smokeGeometry.setAttribute('position', new THREE.BufferAttribute(this.smokePositions, 3));
    this.smokeGeometry.setAttribute('size', new THREE.BufferAttribute(this.smokeSizes, 1));
    this.smokeGeometry.setAttribute('opacity', new THREE.BufferAttribute(this.smokeOpacities, 1));
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = smokeCanvas.height = 64;
    const sCtx = smokeCanvas.getContext('2d')!;
    const smokeGrad = sCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    smokeGrad.addColorStop(0, 'rgba(180,180,170,0.7)');
    smokeGrad.addColorStop(0.3, 'rgba(140,140,135,0.4)');
    smokeGrad.addColorStop(0.7, 'rgba(90,90,85,0.15)');
    smokeGrad.addColorStop(1, 'rgba(60,60,55,0)');
    sCtx.fillStyle = smokeGrad;
    sCtx.fillRect(0, 0, 64, 64);
    const smokeTexture = new THREE.CanvasTexture(smokeCanvas);
    smokeTexture.colorSpace = THREE.SRGBColorSpace;
    const smokeMaterial = new THREE.PointsMaterial({
      map: smokeTexture,
      color: 0xb8b4a8,
      size: 0.8,
      transparent: true,
      opacity: 0.6,
      blending: THREE.NormalBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    smokeMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float size;\\nattribute float opacity;\\nvarying float vOpacity;\\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        'gl_PointSize = size;',
        'gl_PointSize = size;\\nvOpacity = opacity;'
      );
      shader.fragmentShader = 'varying float vOpacity;\\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <premultiplied_alpha_fragment>',
        'gl_FragColor.a *= vOpacity;\\n#include <premultiplied_alpha_fragment>'
      );
    };
    this.smokeMesh = new THREE.Points(this.smokeGeometry, smokeMaterial);
    this.scene.add(this.smokeMesh);`
);

// Upgrade bullet colors for brighter, more visible projectiles
city = city.replace(
  `        // Neon orange-to-cyan gradient
        this.bulletColors[idx] = 1.0 * fade;
        this.bulletColors[idx + 1] = 0.5 * fade;
        this.bulletColors[idx + 2] = 0.2 * fade;
        this.bulletColors[idx + 3] = 0.3 * fade;
        this.bulletColors[idx + 4] = 0.9 * fade;
        this.bulletColors[idx + 5] = 1.0 * fade;`,
  `        // Hot tracer round: bright orange-yellow head, fading red tail
        this.bulletColors[idx] = 1.0 * fade;
        this.bulletColors[idx + 1] = 0.85 * fade;
        this.bulletColors[idx + 2] = 0.3 * fade;
        this.bulletColors[idx + 3] = 1.0 * fade * 0.5;
        this.bulletColors[idx + 4] = 0.25 * fade * 0.5;
        this.bulletColors[idx + 5] = 0.08 * fade * 0.5;`
);

// Upgrade spawnBullet to add gunsmoke and more sparks
city = city.replace(
  `  private spawnBullet() {
    // Alternate between left and right gun
    const gunOffsets = [-0.45, 0.45];
    const gunX = gunOffsets[this.bulletGunIndex % 2];
    this.bulletGunIndex++;
    // Compute world-space gun tip position
    const localGunTip = new THREE.Vector3(gunX, 0.38, -3.2);
    localGunTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const position = this.carPosition.clone().add(localGunTip);
    // Bullet velocity = car forward * bullet speed + car velocity
    const bulletSpeed = 120;
    const velocity = this.forward.clone().multiplyScalar(bulletSpeed).add(this.velocity);
    this.bullets.push({ position, velocity, life: 1.5, trail: [position.clone()] });
    if (this.bullets.length > 200) this.bullets.shift();
    // Spawn muzzle spark particles
    for (let i = 0; i < 3; i++) {
      const sparkPos = position.clone();
      sparkPos.y += (Math.random() - 0.5) * 0.15;
      const sparkVel = velocity.clone().multiplyScalar(0.08);
      sparkVel.x += (Math.random() - 0.5) * 8;
      sparkVel.y += Math.random() * 3;
      sparkVel.z += (Math.random() - 0.5) * 8;
      this.particles.push({ position: sparkPos, velocity: sparkVel, life: 0.15, color: new THREE.Color(0xff6633) });
      if (this.particles.length > 180) this.particles.shift();
    }
  }`,
  `  private spawnBullet() {
    // Alternate between left and right gun
    const gunOffsets = [-0.45, 0.45];
    const gunX = gunOffsets[this.bulletGunIndex % 2];
    this.bulletGunIndex++;
    // Compute world-space gun tip position
    const localGunTip = new THREE.Vector3(gunX, 0.38, -3.2);
    localGunTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const position = this.carPosition.clone().add(localGunTip);
    // Bullet velocity = car forward * bullet speed + car velocity
    const bulletSpeed = 160;
    const velocity = this.forward.clone().multiplyScalar(bulletSpeed).add(this.velocity);
    this.bullets.push({ position, velocity, life: 1.2, trail: [position.clone()] });
    if (this.bullets.length > 200) this.bullets.shift();
    // Spawn bright muzzle sparks — hot metal fragments
    for (let i = 0; i < 5; i++) {
      const sparkPos = position.clone();
      sparkPos.x += (Math.random() - 0.5) * 0.12;
      sparkPos.y += (Math.random() - 0.5) * 0.12;
      const sparkVel = velocity.clone().multiplyScalar(0.05 + Math.random() * 0.04);
      sparkVel.x += (Math.random() - 0.5) * 12;
      sparkVel.y += 1 + Math.random() * 5;
      sparkVel.z += (Math.random() - 0.5) * 12;
      const sparkColor = Math.random() > 0.5 ? 0xff8833 : 0xffcc44;
      this.particles.push({ position: sparkPos, velocity: sparkVel, life: 0.1 + Math.random() * 0.12, color: new THREE.Color(sparkColor) });
      if (this.particles.length > 180) this.particles.shift();
    }
    // Spawn gunsmoke from the muzzle
    this.spawnGunSmoke(position);
  }

  private spawnGunSmoke(muzzlePos: THREE.Vector3) {
    for (let i = 0; i < 3; i++) {
      const pos = muzzlePos.clone();
      pos.x += (Math.random() - 0.5) * 0.15;
      pos.y += 0.05 + Math.random() * 0.1;
      pos.z += (Math.random() - 0.5) * 0.15;
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        0.8 + Math.random() * 1.5,
        (Math.random() - 0.5) * 1.5,
      );
      // Add some of the car's velocity so smoke trails behind
      vel.addScaledVector(this.velocity, 0.08);
      const maxLife = 0.6 + Math.random() * 0.8;
      this.smokeParticles.push({
        position: pos,
        velocity: vel,
        life: maxLife,
        maxLife,
        size: 0.3 + Math.random() * 0.4,
        opacity: 0.5 + Math.random() * 0.3,
      });
      if (this.smokeParticles.length > 300) this.smokeParticles.shift();
    }
  }`
);

// Add updateSmoke call in the frame loop — after updateBullets
city = city.replace(
  "this.updateBullets(delta);",
  "this.updateBullets(delta);\n    this.updateSmoke(delta);"
);

// Add the updateSmoke method — insert before updateParticles
const updateParticlesIdx = city.indexOf('  private updateParticles(delta: number)');
if (updateParticlesIdx !== -1) {
  const smokeUpdateMethod = `  private updateSmoke(delta: number) {
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.life -= delta;
      if (p.life <= 0) {
        this.smokeParticles.splice(i, 1);
        continue;
      }
      // Smoke rises and expands, slows down
      p.velocity.y += delta * 0.5;
      p.velocity.multiplyScalar(1 - delta * 2.5);
      p.position.addScaledVector(p.velocity, delta);
      p.size += delta * 1.2; // Expand as it dissipates
    }
    for (let i = 0; i < 300; i++) {
      const p = this.smokeParticles[i];
      const idx = i * 3;
      if (p) {
        const t = p.life / p.maxLife; // 1 = fresh, 0 = gone
        this.smokePositions[idx] = p.position.x;
        this.smokePositions[idx + 1] = p.position.y;
        this.smokePositions[idx + 2] = p.position.z;
        this.smokeSizes[i] = p.size * (1 + (1 - t) * 2);
        this.smokeOpacities[i] = p.opacity * t * t; // Fade out quadratically
      } else {
        this.smokePositions[idx] = 0;
        this.smokePositions[idx + 1] = -1000;
        this.smokePositions[idx + 2] = 0;
        this.smokeSizes[i] = 0;
        this.smokeOpacities[i] = 0;
      }
    }
    this.smokeGeometry.setDrawRange(0, this.smokeParticles.length);
    this.smokeGeometry.attributes.position.needsUpdate = true;
    (this.smokeGeometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.smokeGeometry.attributes.opacity as THREE.BufferAttribute).needsUpdate = true;
    this.smokeGeometry.computeBoundingSphere();
  }

`;
  city = city.substring(0, updateParticlesIdx) + smokeUpdateMethod + city.substring(updateParticlesIdx);
}

// Update the firing system to call fireGun every frame (continuous) and stopFiring when released
// Also add continuous smoke while firing
city = city.replace(
  `    // ── Firing system ──
    const firing = key('f');
    this.fireCooldown -= delta;
    this.muzzleFlashTimer -= delta;
    if (firing && this.fireCooldown <= 0) {
      this.spawnBullet();
      this.fireCooldown = 0.08; // fire rate: ~12.5 rounds/sec
      this.muzzleFlashTimer = 0.04;
      this.audio.fireGun();
    }
    // Muzzle flash visibility
    for (const flash of this.muzzleFlashes) {
      flash.visible = this.muzzleFlashTimer > 0;
      if (flash.visible) {
        flash.scale.set(0.7 + Math.random() * 0.6, 0.7 + Math.random() * 0.5, 1);
        flash.rotation.z = Math.random() * Math.PI * 2;
      }
    }`,
  `    // ── Firing system — continuous minigun ──
    const firing = key('f');
    this.fireCooldown -= delta;
    this.muzzleFlashTimer -= delta;
    this.gunSmokeTimer -= delta;
    if (firing) {
      this.audio.fireGun(); // Called every frame for continuous minigun sound
      if (this.fireCooldown <= 0) {
        this.spawnBullet();
        this.fireCooldown = 0.045; // fire rate: ~22 rounds/sec (minigun)
        this.muzzleFlashTimer = 0.03;
      }
      // Continuous barrel smoke while firing
      if (this.gunSmokeTimer <= 0) {
        for (const gunX of [-0.45, 0.45]) {
          const localTip = new THREE.Vector3(gunX, 0.38, -3.0);
          localTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
          const smokePos = this.carPosition.clone().add(localTip);
          // Wispy barrel smoke
          const vel = new THREE.Vector3(
            (Math.random() - 0.5) * 0.8,
            0.5 + Math.random() * 1.0,
            (Math.random() - 0.5) * 0.8,
          );
          vel.addScaledVector(this.velocity, 0.06);
          const maxLife = 0.8 + Math.random() * 0.6;
          this.smokeParticles.push({
            position: smokePos,
            velocity: vel,
            life: maxLife,
            maxLife,
            size: 0.15 + Math.random() * 0.2,
            opacity: 0.3 + Math.random() * 0.2,
          });
          if (this.smokeParticles.length > 300) this.smokeParticles.shift();
        }
        this.gunSmokeTimer = 0.03;
      }
    } else {
      this.audio.stopFiring();
    }
    // Muzzle flash visibility — rapid flicker for minigun
    for (const flash of this.muzzleFlashes) {
      flash.visible = this.muzzleFlashTimer > 0;
      if (flash.visible) {
        flash.scale.set(0.5 + Math.random() * 0.8, 0.5 + Math.random() * 0.7, 0.8 + Math.random() * 0.4);
        flash.rotation.z = Math.random() * Math.PI * 2;
      }
    }`
);

fs.writeFileSync(cityPath, city, 'utf8');
console.log('✓ Bullet visuals upgraded to hot tracer rounds');
console.log('✓ Gunsmoke particle system added');
console.log('✓ Firing system upgraded to continuous minigun');

// Verify
const v = fs.readFileSync(cityPath, 'utf8');
console.log('  smoke check:', v.includes('SmokeParticle'));
console.log('  smoke update check:', v.includes('updateSmoke'));
console.log('  gun smoke check:', v.includes('spawnGunSmoke'));
console.log('  continuous fire check:', v.includes('continuous minigun'));
console.log('  stopFiring check:', v.includes('stopFiring'));
const va = fs.readFileSync(audioPath, 'utf8');
console.log('  minigun audio check:', va.includes('minigunSource'));
console.log('  spin whine check:', va.includes('minigunSpinOsc'));
console.log('  stopFiring method check:', va.includes('stopFiring()'));
