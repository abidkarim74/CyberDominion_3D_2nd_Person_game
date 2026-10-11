import * as THREE from 'three';

/** A single opaque sky draw: distant light pollution and cloud banks, without volumetric raymarching. */
export function addCyberpunkSky(scene: THREE.Scene) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(5400, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 direction;
        void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec3 direction;
        void main(){
          vec3 d=normalize(direction);
          float horizon=exp(-abs(d.y)*8.);
          vec3 color=mix(vec3(.009,.013,.030),vec3(.027,.042,.078),horizon);
          float district=pow(max(0.,dot(normalize(d.xz),normalize(vec2(-.6,-1.)))),5.);
          color+=vec3(.032,.005,.028)*horizon*district;
          color+=vec3(.015,.012,.004)*horizon*(1.-district);
          float cloud=sin(d.x*16.+sin(d.z*11.)*2.7)*sin(d.z*19.+d.y*28.);
          color*=.87+.13*smoothstep(-.7,.8,cloud)*smoothstep(0.,.3,d.y);
          gl_FragColor=vec4(color,1.);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.name = 'Cyberpunk / industrial night sky';
  sky.userData.dynamic = true;
  sky.renderOrder = 9999;
  sky.frustumCulled = false;
  scene.add(sky);
}

/** Four reusable corporate transmissions. Painted once; no videos, per-frame canvas uploads or extra lights. */
export function makeHologramTexture(index: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384;
  const c = canvas.getContext('2d')!;
  const accent = ['#60e9ff', '#ff629d', '#ffbf66', '#b89aff'][index % 4];
  c.fillStyle = '#060d19';
  c.fillRect(0, 0, 512, 384);
  const glow = c.createRadialGradient(356, 192, 10, 356, 192, 250);
  glow.addColorStop(0, ['#10405b', '#482039', '#493424', '#28234a'][index % 4]);
  glow.addColorStop(1, '#060d19');
  c.fillStyle = glow;
  c.fillRect(0, 0, 512, 384);
  c.fillStyle = accent;
  c.fillRect(20, 20, 5, 344);
  c.fillRect(38, 20, 454, 2);
  c.font = '12px monospace';
  c.fillText('NOCTURNE / CIVIC BROADCAST', 40, 42);
  c.textAlign = 'right';
  c.fillText('CH. 0' + (index + 1), 486, 42);
  c.textAlign = 'left';
  c.strokeStyle = accent;
  c.lineWidth = 2;
  c.save();
  c.translate(347, 161);
  if (index % 4 === 0) {
    // A neural network schematic, with deliberately asymmetric links.
    const nodes = [[-60, 0], [-26, -52], [42, -46], [67, 12], [18, 64], [-40, 55], [0, 0]];
    nodes.forEach(([x, y], i) => {
      const next = nodes[(i + 2) % nodes.length];
      c.beginPath(); c.moveTo(x, y); c.lineTo(next[0], next[1]); c.stroke();
      c.beginPath(); c.arc(x, y, i === 6 ? 12 : 6, 0, Math.PI * 2); c.stroke();
    });
  } else if (index % 4 === 1) {
    // Clinical retinal scanner inside a technical frame.
    c.strokeRect(-82, -65, 164, 130);
    c.beginPath(); c.ellipse(0, 0, 65, 31, 0, 0, Math.PI * 2); c.stroke();
    for (const r of [12, 23, 43]) { c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke(); }
    c.fillRect(-97, -2, 194, 3);
  } else if (index % 4 === 2) {
    // Transit circuitry and a luminous train silhouette.
    for (let i = 0; i < 4; i++) {
      c.beginPath(); c.moveTo(-82, -54 + i * 34); c.lineTo(-15, -54 + i * 34);
      c.lineTo(15, -33 + i * 20); c.lineTo(84, -33 + i * 20); c.stroke();
      c.strokeRect(-88, -60 + i * 34, 12, 12);
    }
    c.strokeRect(-60, -23, 120, 40);
    for (let x = -45; x < 50; x += 25) c.fillRect(x, -14, 17, 12);
  } else {
    // Satellite orbits imply the scale of the corporate city.
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.ellipse(0, 0, 78, 33, i * Math.PI / 3, 0, Math.PI * 2); c.stroke();
    }
    c.beginPath(); c.arc(0, 0, 17, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  const brands = ['SYNAPSE', 'RETINA', 'METRO', 'ORBITAL'];
  const claims = ['STAY CONNECTED', 'SEE BEYOND', 'CITY NEVER STOPS', 'A BETTER TOMORROW'];
  c.fillStyle = '#edfaff'; c.font = '900 48px Arial'; c.fillText(brands[index % 4], 40, 283);
  c.fillStyle = accent; c.font = 'bold 19px monospace'; c.fillText(claims[index % 4], 40, 316);
  c.fillRect(40, 334, 446, 1);
  c.font = '11px monospace'; c.fillStyle = '#8ba7b8';
  c.fillText('AUTHORIZED CITY NETWORK / EST. 2089', 40, 354);
  c.fillStyle = 'rgba(1,5,14,.12)';
  for (let y = 0; y < 384; y += 5) c.fillRect(0, y, 512, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
