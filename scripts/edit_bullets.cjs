const fs = require('fs');
let c = fs.readFileSync('lib/neon-city.ts', 'utf8');

// Helper to do replacements checking both CRLF and LF
function rep(target, replacement) {
  if (c.includes(target)) {
    c = c.replace(target, replacement);
    return true;
  }
  const lfTarget = target.replace(/\r\n/g, '\n');
  if (c.includes(lfTarget)) {
    c = c.replace(lfTarget, replacement);
    return true;
  }
  console.error('NOT FOUND:', target.substring(0, 80));
  return false;
}

// 1. Add 'f' key to preventDefault list and add it to pressed keys
rep(
  `    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();`,
  `    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f'].includes(key)) event.preventDefault();`
);

// 2. Fix reset to include firing: false in lastTelemetry and clear bullets
rep(
  `    this.lastTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false };`,
  `    this.bullets.length = 0;\r\n    this.fireCooldown = 0;\r\n    this.muzzleFlashTimer = 0;\r\n    for (const flash of this.muzzleFlashes) flash.visible = false;\r\n    this.lastTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false, firing: false };`
);

// 3. Add firing logic at end of updateDriving, before telemetry construction
rep(
  `    const speed = this.velocity.length() * 3.6;\r\n    const telemetry: DriveTelemetry = { speed, boost: this.boostCharge / 100, drifting: drifting && speed > 18, boosting };`,
  `    // ── Firing system ──\r\n    const firing = key('f');\r\n    this.fireCooldown -= delta;\r\n    this.muzzleFlashTimer -= delta;\r\n    if (firing && this.fireCooldown <= 0) {\r\n      this.spawnBullet();\r\n      this.fireCooldown = 0.08; // fire rate: ~12.5 rounds/sec\r\n      this.muzzleFlashTimer = 0.04;\r\n      this.audio.fireGun();\r\n    }\r\n    // Muzzle flash visibility\r\n    for (const flash of this.muzzleFlashes) {\r\n      flash.visible = this.muzzleFlashTimer > 0;\r\n      if (flash.visible) {\r\n        flash.scale.set(0.7 + Math.random() * 0.6, 0.7 + Math.random() * 0.5, 1);\r\n        flash.rotation.z = Math.random() * Math.PI * 2;\r\n      }\r\n    }\r\n    const speed = this.velocity.length() * 3.6;\r\n    const telemetry: DriveTelemetry = { speed, boost: this.boostCharge / 100, drifting: drifting && speed > 18, boosting, firing };`
);

// 4. Add spawnBullet and updateBullets methods before the spawnParticle method
rep(
  `  private spawnParticle(origin: THREE.Vector3, color: number, exhaust: boolean) {`,
  `  private spawnBullet() {\r\n    // Alternate between left and right gun\r\n    const gunOffsets = [-0.45, 0.45];\r\n    const gunX = gunOffsets[this.bulletGunIndex % 2];\r\n    this.bulletGunIndex++;\r\n    // Compute world-space gun tip position\r\n    const localGunTip = new THREE.Vector3(gunX, 0.38, -3.2);\r\n    localGunTip.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);\r\n    const position = this.carPosition.clone().add(localGunTip);\r\n    // Bullet velocity = car forward * bullet speed + car velocity\r\n    const bulletSpeed = 120;\r\n    const velocity = this.forward.clone().multiplyScalar(bulletSpeed).add(this.velocity);\r\n    this.bullets.push({ position, velocity, life: 1.5, trail: [position.clone()] });\r\n    if (this.bullets.length > 200) this.bullets.shift();\r\n    // Spawn muzzle spark particles\r\n    for (let i = 0; i < 3; i++) {\r\n      const sparkPos = position.clone();\r\n      sparkPos.y += (Math.random() - 0.5) * 0.15;\r\n      const sparkVel = velocity.clone().multiplyScalar(0.08);\r\n      sparkVel.x += (Math.random() - 0.5) * 8;\r\n      sparkVel.y += Math.random() * 3;\r\n      sparkVel.z += (Math.random() - 0.5) * 8;\r\n      this.particles.push({ position: sparkPos, velocity: sparkVel, life: 0.15, color: new THREE.Color(0xff6633) });\r\n      if (this.particles.length > 180) this.particles.shift();\r\n    }\r\n  }\r\n\r\n  private updateBullets(delta: number) {\r\n    // Update bullet positions and remove expired ones\r\n    for (let i = this.bullets.length - 1; i >= 0; i--) {\r\n      const bullet = this.bullets[i];\r\n      bullet.life -= delta;\r\n      if (bullet.life <= 0) {\r\n        this.bullets.splice(i, 1);\r\n        continue;\r\n      }\r\n      bullet.position.addScaledVector(bullet.velocity, delta);\r\n      bullet.trail.push(bullet.position.clone());\r\n      if (bullet.trail.length > 6) bullet.trail.shift();\r\n      // Check building collisions\r\n      for (const building of this.colliders) {\r\n        if (Math.abs(bullet.position.x - building.x) < building.hx &&\r\n            Math.abs(bullet.position.z - building.z) < building.hz) {\r\n          // Spawn impact sparks\r\n          for (let j = 0; j < 6; j++) {\r\n            this.spawnParticle(bullet.position, 0xff8833, false);\r\n          }\r\n          this.bullets.splice(i, 1);\r\n          break;\r\n        }\r\n      }\r\n    }\r\n    // Render bullet trails as line segments\r\n    for (let i = 0; i < 200; i++) {\r\n      const idx = i * 6;\r\n      const bullet = this.bullets[i];\r\n      if (bullet && bullet.trail.length >= 2) {\r\n        const head = bullet.trail[bullet.trail.length - 1];\r\n        const tail = bullet.trail[0];\r\n        const fade = Math.min(bullet.life * 3, 1);\r\n        this.bulletPositions[idx] = head.x;\r\n        this.bulletPositions[idx + 1] = head.y;\r\n        this.bulletPositions[idx + 2] = head.z;\r\n        this.bulletPositions[idx + 3] = tail.x;\r\n        this.bulletPositions[idx + 4] = tail.y;\r\n        this.bulletPositions[idx + 5] = tail.z;\r\n        // Neon orange-to-cyan gradient\r\n        this.bulletColors[idx] = 1.0 * fade;\r\n        this.bulletColors[idx + 1] = 0.5 * fade;\r\n        this.bulletColors[idx + 2] = 0.2 * fade;\r\n        this.bulletColors[idx + 3] = 0.3 * fade;\r\n        this.bulletColors[idx + 4] = 0.9 * fade;\r\n        this.bulletColors[idx + 5] = 1.0 * fade;\r\n      } else {\r\n        this.bulletPositions[idx] = 0;\r\n        this.bulletPositions[idx + 1] = -1000;\r\n        this.bulletPositions[idx + 2] = 0;\r\n        this.bulletPositions[idx + 3] = 0;\r\n        this.bulletPositions[idx + 4] = -1000;\r\n        this.bulletPositions[idx + 5] = 0;\r\n      }\r\n    }\r\n    this.bulletGeometry.setDrawRange(0, this.bullets.length * 2);\r\n    this.bulletGeometry.attributes.position.needsUpdate = true;\r\n    this.bulletGeometry.attributes.color.needsUpdate = true;\r\n    this.bulletGeometry.computeBoundingSphere();\r\n  }\r\n\r\n  private spawnParticle(origin: THREE.Vector3, color: number, exhaust: boolean) {`
);

// 5. Add updateBullets call in the frame loop, after updateParticles
rep(
  `    this.updateParticles(delta);`,
  `    this.updateParticles(delta);\r\n    this.updateBullets(delta);`
);

fs.writeFileSync('lib/neon-city.ts', c);
console.log('All edits applied successfully!');
