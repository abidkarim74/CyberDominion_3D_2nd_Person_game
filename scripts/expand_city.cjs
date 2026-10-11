const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'lib', 'neon-city.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Update constants
content = content.replace(
  'const CITY_SPAN = 396;',
  'const CITY_SPAN = 792;'
);
content = content.replace(
  'Array.from({ length: 9 }, (_, i) => (i - 4) * ROAD_STEP)',
  'Array.from({ length: 18 }, (_, i) => (i - 8.5) * ROAD_STEP)'
);
content = content.replace(
  'const CITY_EDGE = 193;',
  'const CITY_EDGE = 390;'
);

// 2. Update fog density
content = content.replace(
  "new THREE.FogExp2(0x142333, 0.0062)",
  "new THREE.FogExp2(0x142333, 0.0032)"
);

// 3. Update camera far plane
content = content.replace(
  "new THREE.PerspectiveCamera(66, 1, 0.1, 560)",
  "new THREE.PerspectiveCamera(66, 1, 0.1, 1100)"
);

// 4. Update ground plane size
content = content.replace(
  "new THREE.PlaneGeometry(440, 440)",
  "new THREE.PlaneGeometry(880, 880)"
);

// 5. Update platform instanced mesh count from 64 to dynamic
content = content.replace(
  "new THREE.InstancedMesh(platformGeometry, platformMaterial, 64)",
  "new THREE.InstancedMesh(platformGeometry, platformMaterial, (ROAD_COORDS.length - 1) * (ROAD_COORDS.length - 1))"
);

// 6. Update trim mesh instance count from 80 to 800
content = content.replace(
  /new THREE\.InstancedMesh\(\s*\n?\s*new THREE\.BoxGeometry\(1, 1, 1\),\s*\n?\s*new THREE\.MeshBasicMaterial\(\{ color: style\.trim, toneMapped: false \}\),\s*\n?\s*80,/,
  `new THREE.InstancedMesh(\r
        new THREE.BoxGeometry(1, 1, 1),\r
        new THREE.MeshBasicMaterial({ color: style.trim, toneMapped: false }),\r
        800,`
);

// 7. Update stars count and spread
content = content.replace(
  "new Float32Array(260 * 3)",
  "new Float32Array(600 * 3)"
);
content = content.replace(
  "for (let i = 0; i < 260; i += 1)",
  "for (let i = 0; i < 600; i += 1)"
);
content = content.replace(
  "(starRandom() - 0.5) * 420;\r\n",
  "(starRandom() - 0.5) * 900;\r\n"
);
// Try LF only too
content = content.replace(
  "(starRandom() - 0.5) * 420;\n",
  "(starRandom() - 0.5) * 900;\n"
);
content = content.replace(
  "48 + starRandom() * 120",
  "48 + starRandom() * 180"
);

// 8. Add more sky bridges and creative features after existing ones
const oldSkyBridges = `addSkyBridge(this.scene, -44, 0x26dcf1);\r
    addSkyBridge(this.scene, 132, 0xff47a8);`;
const newSkyBridges = `addSkyBridge(this.scene, -44, 0x26dcf1);\r
    addSkyBridge(this.scene, 132, 0xff47a8);\r
    addSkyBridge(this.scene, -220, 0x26dcf1);\r
    addSkyBridge(this.scene, 264, 0xff47a8);\r
    addSkyBridge(this.scene, -132, 0xff47a8);\r
    addSkyBridge(this.scene, 308, 0x26dcf1);`;
content = content.replace(oldSkyBridges, newSkyBridges);
// Try LF version too
const oldSkyBridgesLF = `addSkyBridge(this.scene, -44, 0x26dcf1);\n    addSkyBridge(this.scene, 132, 0xff47a8);`;
const newSkyBridgesLF = `addSkyBridge(this.scene, -44, 0x26dcf1);\n    addSkyBridge(this.scene, 132, 0xff47a8);\n    addSkyBridge(this.scene, -220, 0x26dcf1);\n    addSkyBridge(this.scene, 264, 0xff47a8);\n    addSkyBridge(this.scene, -132, 0xff47a8);\n    addSkyBridge(this.scene, 308, 0x26dcf1);`;
content = content.replace(oldSkyBridgesLF, newSkyBridgesLF);

// 9. Update flying vehicles count and radius
content = content.replace(
  "Array.from({ length: 7 }, (_, index) => {",
  "Array.from({ length: 18 }, (_, index) => {"
);
content = content.replace(
  "const radius = 96 + random() * 82;",
  "const radius = 140 + random() * 220;"
);
content = content.replace(
  "const height = 36 + random() * 52;",
  "const height = 36 + random() * 80;"
);

// 10. Expand rain spread area
content = content.replace(
  "x: (random() - 0.5) * 90,",
  "x: (random() - 0.5) * 130,"
);
content = content.replace(
  "z: (random() - 0.5) * 110,",
  "z: (random() - 0.5) * 150,"
);

// 11. Add neonSigns array field after coveredRoads
content = content.replace(
  "private readonly coveredRoads: CoveredRoad[] = [{ x: 0, z: 66, hx: 9.5, hz: 13, ceiling: 11, label: 'CENTRAL TUNNEL' }];",
  "private readonly coveredRoads: CoveredRoad[] = [{ x: 0, z: 66, hx: 9.5, hz: 13, ceiling: 11, label: 'CENTRAL TUNNEL' }];\r\n  private readonly neonSigns: THREE.Mesh[] = [];"
);

// 12. Update streetlights to cover expanded grid
const oldStreetlightsStart = 'function addStreetlights(scene: THREE.Scene) {';
const oldStreetlightsBody = content.indexOf(oldStreetlightsStart);
if (oldStreetlightsBody !== -1) {
  // Find the closing brace of the function
  let braceCount = 0;
  let funcEnd = -1;
  for (let i = content.indexOf('{', oldStreetlightsBody); i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        funcEnd = i + 1;
        break;
      }
    }
  }
  if (funcEnd !== -1) {
    const oldFunc = content.substring(oldStreetlightsBody, funcEnd);
    const newFunc = `function addStreetlights(scene: THREE.Scene) {\r
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x18263a, metalness: 0.88, roughness: 0.31 });\r
  const positions: [number, number, number][] = [];\r
  for (let xi = -8; xi <= 8; xi++) {\r
    for (let zi = -8; zi <= 8; zi++) {\r
      const x = xi * 44;\r
      const z = zi * 44;\r
      if ((xi + zi) % 2 === 0) continue;\r
      const color = (xi + zi) % 4 === 1 ? 0x46e9ff : 0xff45ac;\r
      positions.push([x, z, color]);\r
    }\r
  }\r
  for (const [x, z, color] of positions) {\r
    const lightGroup = new THREE.Group();\r
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 7.5, 8), poleMaterial);\r
    pole.position.y = 3.75;\r
    lightGroup.add(pole);\r
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMaterial);\r
    arm.position.set(-1, 7.25, 0);\r
    lightGroup.add(arm);\r
    const lamp = new THREE.Mesh(\r
      new THREE.BoxGeometry(0.86, 0.13, 0.52),\r
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),\r
    );\r
    lamp.position.set(-2.05, 7.12, 0);\r
    lightGroup.add(lamp);\r
    const glow = new THREE.PointLight(color === 0x46e9ff ? 0xa4cfdb : 0xc59aac, 48, 24, 2);\r
    glow.position.set(-2, 6.9, 0);\r
    lightGroup.add(glow);\r
    lightGroup.position.set(x, 0, z);\r
    scene.add(lightGroup);\r
  }\r
}`;
    content = content.replace(oldFunc, newFunc);
  }
}

// 13. After infrastructure line, add creative methods call
const infraLine = "this.coveredRoads.push(...addInfrastructure(this.scene, this.colliders));";
const infraLineIdx = content.indexOf(infraLine);
if (infraLineIdx !== -1) {
  const insertAfter = infraLineIdx + infraLine.length;
  const newCode = `\r
\r
    // ── Creative additions for the expanded city ──\r
    this.addHoloBillboards(styles);\r
    this.addNeonAvenues();\r
    this.addMonorail();`;
  content = content.substring(0, insertAfter) + newCode + content.substring(insertAfter);
}

// 14. Add the creative methods before createRain
const createRainIdx = content.indexOf('  private createRain()');
if (createRainIdx !== -1) {
  const creativeMethods = `  private addHoloBillboards(styles: FacadeStyle[]) {\r
    const holoMaterial = new THREE.MeshBasicMaterial({\r
      color: 0x40e8ff, transparent: true, opacity: 0.6, toneMapped: false, side: THREE.DoubleSide,\r
    });\r
    const holoPinkMaterial = new THREE.MeshBasicMaterial({\r
      color: 0xff45b0, transparent: true, opacity: 0.55, toneMapped: false, side: THREE.DoubleSide,\r
    });\r
    const positions: [number, number][] = [\r
      [-176, -176], [176, 176], [-176, 176], [176, -176],\r
      [-264, 0], [264, 0], [0, -264], [0, 264],\r
      [-352, -88], [352, 88],\r
    ];\r
    positions.forEach(([x, z], i) => {\r
      const group = new THREE.Group();\r
      group.position.set(x, 0, z);\r
      const pylon = new THREE.Mesh(\r
        new THREE.CylinderGeometry(0.3, 0.5, 20, 8),\r
        new THREE.MeshStandardMaterial({ color: 0x1a2840, metalness: 0.85, roughness: 0.3 }),\r
      );\r
      pylon.position.y = 10;\r
      group.add(pylon);\r
      const panel = new THREE.Mesh(\r
        new THREE.PlaneGeometry(12, 8),\r
        i % 2 === 0 ? holoMaterial : holoPinkMaterial,\r
      );\r
      panel.position.y = 22;\r
      panel.rotation.y = i * 0.7;\r
      panel.userData.dynamic = true;\r
      group.add(panel);\r
      this.neonSigns.push(panel);\r
      const ring = new THREE.Mesh(\r
        new THREE.TorusGeometry(2.5, 0.08, 8, 24),\r
        new THREE.MeshBasicMaterial({ color: styles[i % styles.length].trim, toneMapped: false }),\r
      );\r
      ring.position.y = 20;\r
      ring.rotation.x = Math.PI / 2;\r
      group.add(ring);\r
      this.scene.add(group);\r
    });\r
  }\r
\r
  private addNeonAvenues() {\r
    const neonStripMaterial = new THREE.MeshBasicMaterial({\r
      color: 0x22ccee, transparent: true, opacity: 0.18, toneMapped: false, side: THREE.DoubleSide,\r
    });\r
    const pinkStripMaterial = new THREE.MeshBasicMaterial({\r
      color: 0xff3388, transparent: true, opacity: 0.15, toneMapped: false, side: THREE.DoubleSide,\r
    });\r
    for (let seg = -CITY_SPAN / 2; seg < CITY_SPAN / 2; seg += 16) {\r
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.12), neonStripMaterial);\r
      strip.rotation.x = -Math.PI / 2;\r
      strip.position.set(seg + 8, 0.04, 0);\r
      this.scene.add(strip);\r
    }\r
    for (let seg = -CITY_SPAN / 2; seg < CITY_SPAN / 2; seg += 16) {\r
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 14), pinkStripMaterial);\r
      strip.rotation.x = -Math.PI / 2;\r
      strip.position.set(0, 0.04, seg + 8);\r
      this.scene.add(strip);\r
    }\r
  }\r
\r
  private addMonorail() {\r
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x1e2d40, metalness: 0.85, roughness: 0.28 });\r
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x32e8ff, toneMapped: false });\r
    const segments = 64;\r
    const radius = 310;\r
    const height = 28;\r
    for (let i = 0; i < segments; i++) {\r
      const a0 = (i / segments) * Math.PI * 2;\r
      const a1 = ((i + 1) / segments) * Math.PI * 2;\r
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;\r
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;\r
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;\r
      const length = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2);\r
      const angle = Math.atan2(x1 - x0, z1 - z0);\r
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, length + 0.5), railMaterial);\r
      beam.position.set(mx, height, mz);\r
      beam.rotation.y = angle;\r
      this.scene.add(beam);\r
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, length + 0.5), glowMat);\r
      glow.position.set(mx, height - 0.34, mz);\r
      glow.rotation.y = angle;\r
      this.scene.add(glow);\r
      if (i % 4 === 0) {\r
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, height, 8), railMaterial);\r
        pillar.position.set(x0, height / 2, z0);\r
        this.scene.add(pillar);\r
        const baseRing = new THREE.Mesh(\r
          new THREE.TorusGeometry(1.0, 0.06, 6, 16),\r
          i % 8 === 0 ? glowMat : new THREE.MeshBasicMaterial({ color: 0xff3fa0, toneMapped: false }),\r
        );\r
        baseRing.position.set(x0, 0.1, z0);\r
        baseRing.rotation.x = Math.PI / 2;\r
        this.scene.add(baseRing);\r
      }\r
    }\r
  }\r
\r
`;
  content = content.substring(0, createRainIdx) + creativeMethods + content.substring(createRainIdx);
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('City expansion applied successfully!');

// Verify key changes
const verify = fs.readFileSync(filePath, 'utf8');
console.log('CITY_SPAN check:', verify.includes('CITY_SPAN = 792'));
console.log('CITY_EDGE check:', verify.includes('CITY_EDGE = 390'));
console.log('ROAD_COORDS check:', verify.includes('length: 18'));
console.log('Fog check:', verify.includes('0.0032'));
console.log('Camera check:', verify.includes('0.1, 1100'));
console.log('Ground check:', verify.includes('880, 880'));
console.log('Monorail check:', verify.includes('addMonorail'));
console.log('HoloBillboards check:', verify.includes('addHoloBillboards'));
console.log('NeonAvenues check:', verify.includes('addNeonAvenues'));
console.log('Sky bridges check:', verify.includes('addSkyBridge(this.scene, -220'));
console.log('18 flying vehicles check:', verify.includes('length: 18 }, (_, index)'));
