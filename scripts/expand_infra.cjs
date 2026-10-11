const fs = require('fs');
const path = require('path');

const infraPath = path.join(__dirname, '..', 'lib', 'city-infrastructure.ts');
let content = fs.readFileSync(infraPath, 'utf8');

// Find the SOUTH / FREIGHT LINE config and add new ones after it
const marker = "{ x: -110, z: 132, sideways: true, tunnel: false, label: 'SOUTH / FREIGHT LINE' },";
const idx = content.indexOf(marker);
if (idx === -1) {
  console.error('Could not find SOUTH / FREIGHT LINE marker!');
  process.exit(1);
}

// Detect line ending
const lineEnd = content.includes('\r\n') ? '\r\n' : '\n';

const newConfigs = [
  "    { x: -220, z: -154, sideways: false, tunnel: true, label: 'FAR WEST / DEEP TUNNEL' },",
  "    { x: 220, z: 154, sideways: false, tunnel: true, label: 'FAR EAST / EXPRESS TUNNEL' },",
  "    { x: -154, z: 220, sideways: true, tunnel: false, label: 'SOUTH / OUTER BYPASS' },",
  "    { x: 264, z: -198, sideways: true, tunnel: false, label: 'NORTH / ORBITAL ROAD' },",
  "    { x: -308, z: 0, sideways: false, tunnel: true, label: 'OUTER WEST / SUPPLY LINK' },",
  "    { x: 0, z: -308, sideways: true, tunnel: false, label: 'NORTH / CARGO UNDERPASS' },",
].join(lineEnd);

const insertPoint = idx + marker.length;
content = content.substring(0, insertPoint) + lineEnd + newConfigs + content.substring(insertPoint);

fs.writeFileSync(infraPath, content, 'utf8');
console.log('Infrastructure configs added!');
console.log('Verify FAR WEST:', content.includes('FAR WEST'));
console.log('Verify ORBITAL:', content.includes('ORBITAL'));
