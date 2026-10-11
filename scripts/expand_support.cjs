const fs = require('fs');
const path = require('path');

// ── Update cinematic-city.ts ──
const cinematicPath = path.join(__dirname, '..', 'lib', 'cinematic-city.ts');
let cinematic = fs.readFileSync(cinematicPath, 'utf8');

// 1. Expand city detail grid from 8x8 to 16x16
cinematic = cinematic.replace(
  'for (let ix = 0; ix < 8; ix++) for (let iz = 0; iz < 8; iz++) {',
  'for (let ix = 0; ix < 16; ix++) for (let iz = 0; iz < 16; iz++) {'
);
cinematic = cinematic.replace(
  'const x = -154 + ix * 44; const z = -154 + iz * 44; const seed = ix * 8 + iz;',
  'const x = -330 + ix * 44; const z = -330 + iz * 44; const seed = ix * 16 + iz;'
);

// 2. Update crosswalk markings range
cinematic = cinematic.replace(
  'for (let x = -176; x <= 176; x += 44) for (let z = -176; z <= 176; z += 44) {',
  'for (let x = -374; x <= 374; x += 44) for (let z = -374; z <= 374; z += 44) {'
);
// Update instanced mesh count for markings
cinematic = cinematic.replace(
  "new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x82919d }), 9 * 9 * 16)",
  "new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x82919d }), 18 * 18 * 16)"
);

// 3. Update far skyline towers — increase count, push radius further
cinematic = cinematic.replace(
  'for (let i = 0; i < 56; i++) {',
  'for (let i = 0; i < 120; i++) {'
);
cinematic = cinematic.replace(
  'const angle = i / 56 * Math.PI * 2;',
  'const angle = i / 120 * Math.PI * 2;'
);
cinematic = cinematic.replace(
  'const radius = 284 + (i % 5) * 17;',
  'const radius = 480 + (i % 7) * 22;'
);

// 4. Update elevated arterial range
cinematic = cinematic.replace(
  "for (let i = -4; i < 4; i++) {",
  "for (let i = -8; i < 9; i++) {"
);

// 5. Update boundary markers range
cinematic = cinematic.replace(
  "for (let road = -176; road <= 176; road += 44) for (const side of [-1, 1]) {",
  "for (let road = -374; road <= 374; road += 44) for (const side of [-1, 1]) {"
);
// Update the boundary marker Z positions  
cinematic = cinematic.replace(
  "box(scene, road, .65, side * 196, 17, .9, .45, concrete);",
  "box(scene, road, .65, side * 396, 17, .9, .45, concrete);"
);
cinematic = cinematic.replace(
  "box(scene, road, 1.12, side * 196, 17, .06, .5, pink);",
  "box(scene, road, 1.12, side * 396, 17, .06, .5, pink);"
);
cinematic = cinematic.replace(
  "box(scene, side * 196, .65, road, .45, .9, 17, concrete);",
  "box(scene, side * 396, .65, road, .45, .9, 17, concrete);"
);
cinematic = cinematic.replace(
  "box(scene, side * 196, 1.12, road, .5, .06, 17, pink);",
  "box(scene, side * 396, 1.12, road, .5, .06, 17, pink);"
);

// 6. Update blade advertisements check range
cinematic = cinematic.replace(
  "if (Math.abs(x) === 22 && (iz % 2 === 0 || iz === 3)) {",
  "if ((Math.abs(x) === 22 || Math.abs(x) === 198 || Math.abs(x) === 286) && (iz % 2 === 0 || iz === 3)) {"
);

// 7. Update elevated arterial z position
cinematic = cinematic.replace(
  "box(scene, x, 23.4, -132, 44, .7, 6.4, concrete);",
  "box(scene, x, 23.4, -286, 44, .7, 6.4, concrete);"
);
cinematic = cinematic.replace(
  /box\(scene, x, 24\.1, -132 \+ side \* 3\.1/g,
  "box(scene, x, 24.1, -286 + side * 3.1"
);
cinematic = cinematic.replace(
  /box\(scene, x, 22\.7, -132 \+ side \* 2\.8/g,
  "box(scene, x, 22.7, -286 + side * 2.8"
);
cinematic = cinematic.replace(
  /box\(scene, x, 11\.5, -132 \+ side \* 11/g,
  "box(scene, x, 11.5, -286 + side * 11"
);
cinematic = cinematic.replace(
  /box\(scene, x - 19 \+ j \* 5\.4, 22\.8, -132 \+ side \* 3/g,
  "box(scene, x - 19 + j * 5.4, 22.8, -286 + side * 3"
);

// 8. Update wet street reflection size
cinematic = cinematic.replace(
  "new THREE.PlaneGeometry(398, 398)",
  "new THREE.PlaneGeometry(800, 800)"
);

// 9. Update cable span range  
cinematic = cinematic.replace(
  "cable(scene, [new THREE.Vector3(x - 12, 11, z - 13), new THREE.Vector3(x, 9, z - 22), new THREE.Vector3(x + 12, 12, z - 31)], .04);",
  "cable(scene, [new THREE.Vector3(x - 12, 11, z - 13), new THREE.Vector3(x, 9, z - 22), new THREE.Vector3(x + 12, 12, z - 31)], .04);"
);

fs.writeFileSync(cinematicPath, cinematic, 'utf8');
console.log('cinematic-city.ts updated successfully!');

// Verify
console.log('16x16 grid:', cinematic.includes('ix < 16'));
console.log('Skyline 120:', cinematic.includes('i < 120'));
console.log('Boundary 396:', cinematic.includes('side * 396'));
console.log('Reflection 800:', cinematic.includes('800, 800'));

// ── Update city-infrastructure.ts ──
const infraPath = path.join(__dirname, '..', 'lib', 'city-infrastructure.ts');
let infra = fs.readFileSync(infraPath, 'utf8');

// Expand infrastructure configurations to cover the bigger city
const oldConfigs = `const configurations = [
    { x: -88, z: -66, sideways: false, tunnel: true, label: 'WEST / SERVICE TUNNEL' },
    { x: 88, z: 22, sideways: false, tunnel: true, label: 'EAST / TRANSIT TUNNEL' },
    { x: 132, z: -110, sideways: false, tunnel: true, label: 'NORTH / UTILITY LINK' },
    { x: -22, z: 44, sideways: true, tunnel: false, label: 'LOWER / CANAL ROAD' },
    { x: 66, z: -88, sideways: true, tunnel: false, label: 'EAST / UNDERPASS' },
    { x: -110, z: 132, sideways: true, tunnel: false, label: 'SOUTH / FREIGHT LINE' },
  ];`;
const newConfigs = `const configurations = [
    { x: -88, z: -66, sideways: false, tunnel: true, label: 'WEST / SERVICE TUNNEL' },
    { x: 88, z: 22, sideways: false, tunnel: true, label: 'EAST / TRANSIT TUNNEL' },
    { x: 132, z: -110, sideways: false, tunnel: true, label: 'NORTH / UTILITY LINK' },
    { x: -22, z: 44, sideways: true, tunnel: false, label: 'LOWER / CANAL ROAD' },
    { x: 66, z: -88, sideways: true, tunnel: false, label: 'EAST / UNDERPASS' },
    { x: -110, z: 132, sideways: true, tunnel: false, label: 'SOUTH / FREIGHT LINE' },
    { x: -220, z: -154, sideways: false, tunnel: true, label: 'FAR WEST / DEEP TUNNEL' },
    { x: 220, z: 154, sideways: false, tunnel: true, label: 'FAR EAST / EXPRESS TUNNEL' },
    { x: -154, z: 220, sideways: true, tunnel: false, label: 'SOUTH / OUTER BYPASS' },
    { x: 264, z: -198, sideways: true, tunnel: false, label: 'NORTH / ORBITAL ROAD' },
    { x: -308, z: 0, sideways: false, tunnel: true, label: 'OUTER WEST / SUPPLY LINK' },
    { x: 0, z: -308, sideways: true, tunnel: false, label: 'NORTH / CARGO UNDERPASS' },
  ];`;
infra = infra.replace(oldConfigs, newConfigs);

// Expand street furniture positions
const oldFurniture = `for (const [x, z] of [[-10.8, -22], [54.8, 22], [-98.8, 66], [142.8, -66], [10.8, 110], [-54.8, -110]])`;
const newFurniture = `for (const [x, z] of [[-10.8, -22], [54.8, 22], [-98.8, 66], [142.8, -66], [10.8, 110], [-54.8, -110], [-186.8, 154], [230.8, -154], [-142.8, -198], [274.8, 110], [-318.8, 22], [10.8, -286]])`;
infra = infra.replace(oldFurniture, newFurniture);

// Expand lamp posts range
const oldLamps = `for (const x of [-88, 0, 88]) for (const z of [-110, -22, 66, 154]) for (const side of [-1, 1]) {`;
const newLamps = `for (const x of [-308, -220, -132, -88, 0, 88, 132, 220, 308]) for (const z of [-286, -198, -110, -22, 66, 154, 242, 330]) for (const side of [-1, 1]) {`;
infra = infra.replace(oldLamps, newLamps);

fs.writeFileSync(infraPath, infra, 'utf8');
console.log('city-infrastructure.ts updated successfully!');

// Verify
console.log('New configs:', infra.includes('FAR WEST / DEEP TUNNEL'));
console.log('New furniture:', infra.includes('-186.8'));
console.log('New lamps:', infra.includes('-308'));
