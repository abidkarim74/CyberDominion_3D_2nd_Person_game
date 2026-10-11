const fs = require('fs');
const path = require('path');

const cityPath = path.join(__dirname, '..', 'lib', 'neon-city.ts');
let city = fs.readFileSync(cityPath, 'utf8');

// 1. Replace the firing system block
// Find the unique markers
const firingMarker = '// \u2500\u2500 Firing system \u2500\u2500';
const firingIdx = city.indexOf(firingMarker);
console.log('Firing system marker at:', firingIdx);

if (firingIdx !== -1) {
  // Find the end of the muzzle flash block (ends with the closing brace of the for loop)
  // Look for the telemetry line that comes after
  const telemetryMarker = 'const speed = this.velocity.length() * 3.6;';
  const telemetryIdx = city.indexOf(telemetryMarker, firingIdx);
  console.log('Telemetry marker at:', telemetryIdx);
  
  if (telemetryIdx !== -1) {
    const oldFiringBlock = city.substring(firingIdx, telemetryIdx);
    console.log('Old firing block length:', oldFiringBlock.length);
    console.log('Old block preview:', oldFiringBlock.substring(0, 100));
    
    const newFiringBlock = `// \u2500\u2500 Firing system \u2014 continuous minigun \u2500\u2500\r
    const firing = key('f');\r
    this.fireCooldown -= delta;\r
    this.muzzleFlashTimer -= delta;\r
    this.gunSmokeTimer -= delta;\r
    if (firing) {\r
      this.audio.fireGun(); // Called every frame for continuous minigun sound\r
      if (this.fireCooldown <= 0) {\r
        this.spawnBullet();\r
        this.fireCooldown = 0.045; // fire rate: ~22 rounds/sec (minigun)\r
        this.muzzleFlashTimer = 0.03;\r
      }\r
      // Continuous barrel smoke while firing\r
      if (this.gunSmokeTimer <= 0) {\r
        for (const gunX of [-0.45, 0.45]) {\r
          const localTip = new THREE.Vector3(gunX, 0.38, -3.0);\r
          localTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);\r
          const smokePos = this.carPosition.clone().add(localTip);\r
          const vel = new THREE.Vector3(\r
            (Math.random() - 0.5) * 0.8,\r
            0.5 + Math.random() * 1.0,\r
            (Math.random() - 0.5) * 0.8,\r
          );\r
          vel.addScaledVector(this.velocity, 0.06);\r
          const maxLife = 0.8 + Math.random() * 0.6;\r
          this.smokeParticles.push({\r
            position: smokePos,\r
            velocity: vel,\r
            life: maxLife,\r
            maxLife,\r
            size: 0.15 + Math.random() * 0.2,\r
            opacity: 0.3 + Math.random() * 0.2,\r
          });\r
          if (this.smokeParticles.length > 300) this.smokeParticles.shift();\r
        }\r
        this.gunSmokeTimer = 0.03;\r
      }\r
    } else {\r
      this.audio.stopFiring();\r
    }\r
    // Muzzle flash visibility \u2014 rapid flicker for minigun\r
    for (const flash of this.muzzleFlashes) {\r
      flash.visible = this.muzzleFlashTimer > 0;\r
      if (flash.visible) {\r
        flash.scale.set(0.5 + Math.random() * 0.8, 0.5 + Math.random() * 0.7, 0.8 + Math.random() * 0.4);\r
        flash.rotation.z = Math.random() * Math.PI * 2;\r
      }\r
    }\r
    `;
    city = city.substring(0, firingIdx) + newFiringBlock + city.substring(telemetryIdx);
    console.log('Firing system replaced!');
  }
}

// 2. Replace spawnBullet method
const spawnBulletMarker = 'private spawnBullet() {';
const spawnBulletIdx = city.indexOf(spawnBulletMarker);
console.log('spawnBullet at:', spawnBulletIdx);

if (spawnBulletIdx !== -1) {
  // Find the end of spawnBullet - look for the next private method
  let braceCount = 0;
  let funcStart = city.indexOf('{', spawnBulletIdx);
  let funcEnd = -1;
  for (let i = funcStart; i < city.length; i++) {
    if (city[i] === '{') braceCount++;
    if (city[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        funcEnd = i + 1;
        break;
      }
    }
  }
  
  if (funcEnd !== -1) {
    const lineEnd = city.includes('\r\n') ? '\r\n' : '\n';
    const oldSpawnBullet = city.substring(spawnBulletIdx - 2, funcEnd); // include leading spaces
    console.log('Old spawnBullet length:', oldSpawnBullet.length);
    
    const newSpawnBullet = `  private spawnBullet() {\r
    // Alternate between left and right gun\r
    const gunOffsets = [-0.45, 0.45];\r
    const gunX = gunOffsets[this.bulletGunIndex % 2];\r
    this.bulletGunIndex++;\r
    // Compute world-space gun tip position\r
    const localGunTip = new THREE.Vector3(gunX, 0.38, -3.2);\r
    localGunTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);\r
    const position = this.carPosition.clone().add(localGunTip);\r
    // Bullet velocity = car forward * bullet speed + car velocity\r
    const bulletSpeed = 160;\r
    const velocity = this.forward.clone().multiplyScalar(bulletSpeed).add(this.velocity);\r
    this.bullets.push({ position, velocity, life: 1.2, trail: [position.clone()] });\r
    if (this.bullets.length > 200) this.bullets.shift();\r
    // Spawn bright muzzle sparks \u2014 hot metal fragments\r
    for (let i = 0; i < 5; i++) {\r
      const sparkPos = position.clone();\r
      sparkPos.x += (Math.random() - 0.5) * 0.12;\r
      sparkPos.y += (Math.random() - 0.5) * 0.12;\r
      const sparkVel = velocity.clone().multiplyScalar(0.05 + Math.random() * 0.04);\r
      sparkVel.x += (Math.random() - 0.5) * 12;\r
      sparkVel.y += 1 + Math.random() * 5;\r
      sparkVel.z += (Math.random() - 0.5) * 12;\r
      const sparkColor = Math.random() > 0.5 ? 0xff8833 : 0xffcc44;\r
      this.particles.push({ position: sparkPos, velocity: sparkVel, life: 0.1 + Math.random() * 0.12, color: new THREE.Color(sparkColor) });\r
      if (this.particles.length > 180) this.particles.shift();\r
    }\r
    // Spawn gunsmoke from the muzzle\r
    this.spawnGunSmoke(position);\r
  }\r
\r
  private spawnGunSmoke(muzzlePos: THREE.Vector3) {\r
    for (let i = 0; i < 3; i++) {\r
      const pos = muzzlePos.clone();\r
      pos.x += (Math.random() - 0.5) * 0.15;\r
      pos.y += 0.05 + Math.random() * 0.1;\r
      pos.z += (Math.random() - 0.5) * 0.15;\r
      const vel = new THREE.Vector3(\r
        (Math.random() - 0.5) * 1.5,\r
        0.8 + Math.random() * 1.5,\r
        (Math.random() - 0.5) * 1.5,\r
      );\r
      vel.addScaledVector(this.velocity, 0.08);\r
      const maxLife = 0.6 + Math.random() * 0.8;\r
      this.smokeParticles.push({\r
        position: pos,\r
        velocity: vel,\r
        life: maxLife,\r
        maxLife,\r
        size: 0.3 + Math.random() * 0.4,\r
        opacity: 0.5 + Math.random() * 0.3,\r
      });\r
      if (this.smokeParticles.length > 300) this.smokeParticles.shift();\r
    }\r
  }`;
    
    // Replace from "  private spawnBullet" to the closing brace
    city = city.substring(0, spawnBulletIdx - 2) + newSpawnBullet + city.substring(funcEnd);
    console.log('spawnBullet replaced with gunsmoke!');
  }
}

// 3. Update bullet tracer colors (find the neon orange-to-cyan comment)
const tracerComment = 'Neon orange-to-cyan gradient';
if (city.includes(tracerComment)) {
  city = city.replace(tracerComment, 'Hot tracer round: bright orange-yellow head, fading red tail');
  // Replace the bullet color values
  city = city.replace(
    'this.bulletColors[idx] = 1.0 * fade;\r\n        this.bulletColors[idx + 1] = 0.5 * fade;\r\n        this.bulletColors[idx + 2] = 0.2 * fade;\r\n        this.bulletColors[idx + 3] = 0.3 * fade;\r\n        this.bulletColors[idx + 4] = 0.9 * fade;\r\n        this.bulletColors[idx + 5] = 1.0 * fade;',
    'this.bulletColors[idx] = 1.0 * fade;\r\n        this.bulletColors[idx + 1] = 0.85 * fade;\r\n        this.bulletColors[idx + 2] = 0.3 * fade;\r\n        this.bulletColors[idx + 3] = 1.0 * fade * 0.5;\r\n        this.bulletColors[idx + 4] = 0.25 * fade * 0.5;\r\n        this.bulletColors[idx + 5] = 0.08 * fade * 0.5;'
  );
  console.log('Bullet colors upgraded to hot tracers!');
} else {
  console.log('WARNING: Could not find tracer color comment');
}

fs.writeFileSync(cityPath, city, 'utf8');
console.log('\nFinal verification:');
const v = fs.readFileSync(cityPath, 'utf8');
console.log('  spawnGunSmoke:', v.includes('spawnGunSmoke'));
console.log('  continuous minigun:', v.includes('continuous minigun'));
console.log('  stopFiring:', v.includes('stopFiring'));
console.log('  bulletSpeed 160:', v.includes('bulletSpeed = 160'));
console.log('  hot tracer:', v.includes('Hot tracer'));
console.log('  smokeParticles push:', v.includes('smokeParticles.push'));
console.log('  gunSmokeTimer field:', v.includes('gunSmokeTimer'));
