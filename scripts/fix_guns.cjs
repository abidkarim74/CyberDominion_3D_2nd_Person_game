const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════
// FIX 1: Audio — double-start crash + louder minigun
// ═══════════════════════════════════════════════════════
const audioPath = path.join(__dirname, '..', 'lib', 'city-audio.ts');
let audio = fs.readFileSync(audioPath, 'utf8');

// The spinOsc and minigunSource are started explicitly before the
// bulk oscillators.forEach(o => o.start()) call. The spinOsc is in
// the oscillators array, so it gets .start() called twice → crash.
// Fix: Don't push spinOsc into oscillators array, track it separately.
audio = audio.replace(
  'this.oscillators.push(spinOsc);',
  '// spinOsc is started manually above, not pushed to oscillators to avoid double-start'
);

// Also the minigunSource is already started and is in the nodes array
// which gets disconnect() on dispose. That's fine. But let's make sure
// the minigun sound is LOUDER and more aggressive.
audio = audio.replace(
  'minigunGain.gain.value = 0;',
  'minigunGain.gain.value = 0.001; // start near-zero, ramps up'
);

// Make the rattle volume much more prominent
audio = audio.replace(
  "this.minigunGain.gain.setTargetAtTime(0.38 * this.minigunSpinUp, t, 0.02);",
  "this.minigunGain.gain.setTargetAtTime(0.55 * this.minigunSpinUp, t, 0.015);"
);

// Make barrel spin louder
audio = audio.replace(
  "this.minigunSpinGain.gain.setTargetAtTime(0.025 * this.minigunSpinUp, t, 0.03);",
  "this.minigunSpinGain.gain.setTargetAtTime(0.06 * this.minigunSpinUp, t, 0.025);"
);

// Make the gun master bus louder
audio = audio.replace(
  "const gunMasterGain = context.createGain(); gunMasterGain.gain.value = 1;",
  "const gunMasterGain = context.createGain(); gunMasterGain.gain.value = 1.6;"
);

// Make the per-shot cracks fire more often and louder
audio = audio.replace(
  "if (Math.random() < 0.35) {",
  "if (Math.random() < 0.6) {"
);
audio = audio.replace(
  "env.gain.setValueAtTime(0.18 * this.minigunSpinUp, t);",
  "env.gain.setValueAtTime(0.32 * this.minigunSpinUp, t);"
);

// Faster spin-up
audio = audio.replace(
  "this.minigunSpinUp = Math.min(1, this.minigunSpinUp + 0.08);",
  "this.minigunSpinUp = Math.min(1, this.minigunSpinUp + 0.15);"
);

// Also fix the dispose to handle spinOsc separately
audio = audio.replace(
  "if (!this.context) return;\n    const context = this.context;\n    this.oscillators.forEach(oscillator => { try { oscillator.stop(); } catch { /* already stopped */ } });",
  "if (!this.context) return;\n    const context = this.context;\n    if (this.minigunSpinOsc) { try { this.minigunSpinOsc.stop(); } catch { /* already stopped */ } }\n    this.oscillators.forEach(oscillator => { try { oscillator.stop(); } catch { /* already stopped */ } });"
);

fs.writeFileSync(audioPath, audio, 'utf8');
console.log('✓ Audio: fixed double-start crash, louder minigun');

// ═══════════════════════════════════════════════════════
// FIX 2: Bullets — short individual projectiles, not rays
// ═══════════════════════════════════════════════════════
const cityPath = path.join(__dirname, '..', 'lib', 'neon-city.ts');
let city = fs.readFileSync(cityPath, 'utf8');

// Find and replace the updateBullets rendering section.
// Current issue: it renders head-to-tail[0] = long continuous ray.
// Fix: render each bullet as a SHORT segment (position to position - small offset along velocity).

// Find the rendering block
const renderMarker = '// Render bullet trails as line segments';
const renderIdx = city.indexOf(renderMarker);
if (renderIdx === -1) {
  console.error('Could not find render marker');
  process.exit(1);
}

// Find the end of the render loop (the setDrawRange line)
const drawRangeMarker = 'this.bulletGeometry.setDrawRange';
const drawRangeIdx = city.indexOf(drawRangeMarker, renderIdx);
if (drawRangeIdx === -1) {
  console.error('Could not find drawRange marker');
  process.exit(1);
}

// Replace the entire rendering block
const oldRenderBlock = city.substring(renderIdx, drawRangeIdx);
const newRenderBlock = `// Render each bullet as a moderately lengthy tracer segment
    for (let i = 0; i < 200; i++) {
      const idx = i * 6;
      const bullet = this.bullets[i];
      if (bullet) {
        const fade = Math.min(bullet.life * 3, 1);
        // Compute the tail as a moderately lengthy tracer streak (~3.8m), leaving clean gaps between rounds
        const speed = Math.sqrt(bullet.velocity.x ** 2 + bullet.velocity.y ** 2 + bullet.velocity.z ** 2);
        const maxTracerLen = Math.min(4.0, speed * 0.024); // ~3.84m at 160 m/s
        const distTraveled = Math.max(0.6, (1.2 - bullet.life) * speed);
        const tracerLen = Math.min(maxTracerLen, distTraveled);
        const dirX = bullet.velocity.x / speed;
        const dirY = bullet.velocity.y / speed;
        const dirZ = bullet.velocity.z / speed;
        // Head = current position
        this.bulletPositions[idx] = bullet.position.x;
        this.bulletPositions[idx + 1] = bullet.position.y;
        this.bulletPositions[idx + 2] = bullet.position.z;
        // Tail = slightly behind the head
        this.bulletPositions[idx + 3] = bullet.position.x - dirX * tracerLen;
        this.bulletPositions[idx + 4] = bullet.position.y - dirY * tracerLen;
        this.bulletPositions[idx + 5] = bullet.position.z - dirZ * tracerLen;
        // Bright yellow-white head, dimmer orange tail
        this.bulletColors[idx] = 1.0 * fade;
        this.bulletColors[idx + 1] = 0.95 * fade;
        this.bulletColors[idx + 2] = 0.5 * fade;
        this.bulletColors[idx + 3] = 1.0 * fade * 0.35;
        this.bulletColors[idx + 4] = 0.28 * fade * 0.35;
        this.bulletColors[idx + 5] = 0.04 * fade * 0.35;
      } else {
        this.bulletPositions[idx] = 0;
        this.bulletPositions[idx + 1] = -1000;
        this.bulletPositions[idx + 2] = 0;
        this.bulletPositions[idx + 3] = 0;
        this.bulletPositions[idx + 4] = -1000;
        this.bulletPositions[idx + 5] = 0;
      }
    }
    `;

city = city.substring(0, renderIdx) + newRenderBlock + city.substring(drawRangeIdx);

// Also remove the trail accumulation in the update loop — bullets don't need trails anymore
city = city.replace(
  "bullet.position.addScaledVector(bullet.velocity, delta);\r\n      bullet.trail.push(bullet.position.clone());\r\n      if (bullet.trail.length > 6) bullet.trail.shift();",
  "bullet.position.addScaledVector(bullet.velocity, delta);"
);

// The fire rate — make it slightly slower so you can see individual bullets
city = city.replace(
  "this.fireCooldown = 0.045; // fire rate: ~22 rounds/sec (minigun)",
  "this.fireCooldown = 0.065; // fire rate: ~15 rounds/sec (visible individual bullets)"
);

fs.writeFileSync(cityPath, city, 'utf8');
console.log('✓ Bullets: individual short tracers with gaps');
console.log('✓ Fire rate: slowed slightly so bullets are visually distinct');

// Verify
const v = fs.readFileSync(cityPath, 'utf8');
console.log('  short tracer:', v.includes('tracerLen'));
console.log('  no trail push:', !v.includes('trail.push'));
console.log('  fire rate 0.065:', v.includes('0.065'));

const va = fs.readFileSync(audioPath, 'utf8');
console.log('  no double start:', !va.includes('this.oscillators.push(spinOsc)'));
console.log('  louder gain 0.55:', va.includes('0.55'));
console.log('  gun master 1.6:', va.includes('1.6'));
