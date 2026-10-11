import * as THREE from 'three';

export type CabinInstruments = { speed: number; boost: number; boosting: boolean; firing: boolean };

function canvasTexture(canvas: HTMLCanvasElement, repeat = false) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Fine hide grain and recessed diamond stitching replace extra tiny geometry. */
export function makeCabinLeather(quilted = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const c = canvas.getContext('2d')!;
  c.fillStyle = quilted ? '#555961' : '#73767b';
  c.fillRect(0, 0, 256, 256);
  let seed = 2137;
  for (let i = 0; i < 12000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x = seed % 256;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const y = seed % 256;
    c.fillStyle = i % 2 ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.04)';
    c.fillRect(x, y, 1, 1);
  }
  if (quilted) {
    for (let row = -4; row < 12; row++) {
      const start = row * 64;
      for (const direction of [-1, 1]) {
        c.beginPath(); c.moveTo(start, 0); c.lineTo(start + direction * 256, 256);
        c.strokeStyle = '#31353b'; c.lineWidth = 5; c.stroke();
        c.strokeStyle = '#7e7375'; c.lineWidth = 1.1; c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]);
      }
    }
    c.strokeStyle = '#9b7273'; c.lineWidth = 2; c.setLineDash([3, 3]);
    c.strokeRect(10, 10, 236, 236); c.setLineDash([]);
  }
  const texture = canvasTexture(canvas, !quilted);
  if (!quilted) texture.repeat.set(3, 3);
  return texture;
}

export function makeCabinDetailAtlas() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const c = canvas.getContext('2d')!;
  // Steering hub: interlocked EB monogram in a brushed-metal circular surround.
  const metal = c.createRadialGradient(110, 90, 4, 128, 128, 122);
  metal.addColorStop(0, '#dfe1e4'); metal.addColorStop(.72, '#838b94'); metal.addColorStop(1, '#c5cbd1');
  c.fillStyle = metal; c.beginPath(); c.arc(128, 128, 122, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#252a30'; c.beginPath(); c.arc(128, 128, 111, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#e6e8ea'; c.lineWidth = 10; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(120, 91); c.lineTo(83, 91); c.lineTo(83, 165); c.lineTo(120, 165);
  c.moveTo(83, 127); c.lineTo(113, 127); c.moveTo(137, 91); c.lineTo(137, 165);
  c.moveTo(137, 91); c.bezierCurveTo(192, 88, 184, 129, 141, 128);
  c.moveTo(141, 128); c.bezierCurveTo(192, 125, 190, 169, 137, 165); c.stroke();
  c.fillStyle = '#9ea7b1'; c.font = '12px sans-serif'; c.textAlign = 'center'; c.fillText('AIRBAG', 128, 203);
  // Mechanical clock, with raised geometry providing its outer bezel.
  c.fillStyle = '#141a21'; c.beginPath(); c.arc(384, 128, 121, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#d8dde1';
  for (let i = 0; i < 60; i++) {
    const a = i / 60 * Math.PI * 2;
    c.lineWidth = i % 5 ? 1 : 3;
    c.beginPath(); c.moveTo(384 + Math.sin(a) * (i % 5 ? 106 : 97), 128 - Math.cos(a) * (i % 5 ? 106 : 97));
    c.lineTo(384 + Math.sin(a) * 114, 128 - Math.cos(a) * 114); c.stroke();
  }
  c.lineWidth = 7; c.lineCap = 'round';
  c.beginPath(); c.moveTo(384, 128); c.lineTo(346, 104); c.moveTo(384, 128); c.lineTo(429, 95); c.stroke();
  c.fillStyle = '#b8bec5'; c.font = '12px serif'; c.fillText('BUGATTI', 384, 175);
  // Passenger-dash signature and small engraved console legends share one draw.
  c.fillStyle = '#cbd0d5'; c.font = 'italic 38px Georgia'; c.fillText('Bugatti', 766, 74);
  c.fillStyle = '#9aa4af'; c.font = '18px sans-serif'; c.fillText('CHIRON', 766, 108);
  c.fillStyle = '#c6ccd3'; c.font = '18px sans-serif';
  for (const [label, x, y] of [['TEMP', 640, 174], ['FAN', 895, 174], ['AUTO', 640, 288], ['AC', 895, 288], ['P  R  N  D', 766, 388], ['START / STOP', 766, 460]] as const) c.fillText(label, x, y);
  return canvasTexture(canvas);
}

/** Three analog-style instruments update at most ten times a second. */
export function makeBugattiInstruments() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const c = canvas.getContext('2d')!;
  const map = canvasTexture(canvas);
  map.generateMipmaps = false; map.minFilter = THREE.LinearFilter;
  let previous = '';
  let readout = { speed: 0, boost: 100, firing: false };
  function dial(cx: number, cy: number, radius: number, value: number, maximum: number, divisions: number, label: string, unit: string) {
    const metal = c.createRadialGradient(cx - radius * .25, cy - radius * .3, radius * .5, cx, cy, radius);
    metal.addColorStop(0, '#161d25'); metal.addColorStop(.91, '#080c11'); metal.addColorStop(.93, '#9ba6b1'); metal.addColorStop(.97, '#3b434b'); metal.addColorStop(1, '#abb4bd');
    c.fillStyle = metal; c.beginPath(); c.arc(cx, cy, radius, 0, Math.PI * 2); c.fill();
    for (let i = 0; i <= divisions * 5; i++) {
      const angle = Math.PI * (.75 + 1.5 * i / (divisions * 5));
      const major = i % 5 === 0;
      const inner = radius * (major ? .79 : .86), outer = radius * .91;
      c.strokeStyle = i > divisions * 4.35 ? '#b85b5b' : '#c7d0d8'; c.lineWidth = major ? 3 : 1.3;
      c.beginPath(); c.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      c.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer); c.stroke();
      if (major) {
        c.font = `${radius > 140 ? 19 : 15}px sans-serif`; c.fillStyle = '#c8d0d6';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(Math.round(i / (divisions * 5) * maximum)), cx + Math.cos(angle) * radius * .65, cy + Math.sin(angle) * radius * .65);
      }
    }
    c.font = `${radius > 140 ? 15 : 11}px sans-serif`; c.fillStyle = '#a7b4c0';
    c.fillText(label, cx, cy - radius * .31); c.fillText(unit, cx, cy + radius * .46);
    const angle = Math.PI * (.75 + 1.5 * THREE.MathUtils.clamp(value / maximum, 0, 1));
    c.save(); c.translate(cx, cy); c.rotate(angle);
    c.fillStyle = '#c85555'; c.beginPath(); c.moveTo(-radius * .15, -3); c.lineTo(radius * .82, -1.5);
    c.lineTo(radius * .82, 1.5); c.lineTo(-radius * .15, 3); c.closePath(); c.fill(); c.restore();
    c.fillStyle = '#9faab5'; c.beginPath(); c.arc(cx, cy, radius * .055, 0, Math.PI * 2); c.fill();
  }
  function paint(frame: CabinInstruments) {
    const speed = Math.round(frame.speed), boost = Math.round(frame.boost * 100);
    const signature = `${speed}/${boost}/${frame.boosting}/${frame.firing}`;
    if (signature === previous) return;
    previous = signature; readout = { speed, boost, firing: frame.firing };
    c.clearRect(0, 0, 1024, 512);
    dial(170, 277, 126, Math.min(8, 1.1 + speed * .018 + (frame.boosting ? .7 : 0)), 8, 8, 'W16', 'x1000 RPM');
    dial(512, 265, 180, speed, 420, 14, 'BUGATTI', 'km/h');
    dial(854, 277, 126, boost, 100, 5, 'POWER', 'RESERVE %');
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#dce5eb'; c.font = '25px sans-serif'; c.fillText(String(speed), 512, 348);
    c.font = '15px sans-serif'; c.fillStyle = '#aebdc9'; c.fillText(speed === 0 ? 'P' : `D${Math.min(7, 1 + Math.floor(speed / 45))}`, 512, 388);
    c.fillStyle = '#7690a3'; c.font = '16px sans-serif'; c.fillText('CHIRON  /  W16', 512, 474);
    if (frame.boosting) { c.fillStyle = '#c9a56d'; c.fillText('SPORT', 854, 441); }
    if (frame.firing) { c.fillStyle = '#c96b67'; c.beginPath(); c.arc(953, 456, 4, 0, Math.PI * 2); c.fill(); }
    map.needsUpdate = true;
  }
  paint({ speed: 0, boost: 1, boosting: false, firing: false });
  return { map, paint, get readout() { return readout; } };
}
