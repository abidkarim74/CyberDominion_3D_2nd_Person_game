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
  // The neutral albedo stays black when tinted by the cabin material, while
  // this deterministic fine grain also serves as the shared bump map.
  const hide = c.createImageData(256, 256);
  let seed = 2137;
  for (let i = 0; i < hide.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const pore = (seed >>> 24) / 255;
    const value = Math.round((quilted ? 143 : 157) + (pore - .5) * 13 - (pore < .055 ? 12 : 0));
    hide.data[i] = value; hide.data[i + 1] = value + 1; hide.data[i + 2] = value + 3; hide.data[i + 3] = 255;
  }
  c.putImageData(hide, 0, 0);
  if (quilted) {
    for (let row = -4; row < 9; row++) {
      const start = row * 64;
      for (const direction of [-1, 1]) {
        c.beginPath(); c.moveTo(start, 0); c.lineTo(start + direction * 256, 256);
        c.strokeStyle = '#656971'; c.lineWidth = 4; c.stroke();
        c.strokeStyle = '#c6b4a2'; c.lineWidth = 1.15; c.setLineDash([2.6, 3]); c.stroke(); c.setLineDash([]);
      }
    }
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
  c.fillStyle = '#171d23'; c.beginPath(); c.arc(128, 128, 111, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#626d78'; c.lineWidth = 1.5; c.beginPath(); c.arc(128, 128, 105, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = '#e6e8ea'; c.lineWidth = 9; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(120, 91); c.lineTo(83, 91); c.lineTo(83, 165); c.lineTo(120, 165);
  c.moveTo(83, 127); c.lineTo(113, 127); c.moveTo(137, 91); c.lineTo(137, 165);
  c.moveTo(137, 91); c.bezierCurveTo(192, 88, 184, 129, 141, 128);
  c.moveTo(141, 128); c.bezierCurveTo(192, 125, 190, 169, 137, 165); c.stroke();
  c.fillStyle = '#a3acb6'; c.font = '11px sans-serif'; c.textAlign = 'center'; c.fillText('AIRBAG', 128, 203);
  // Mechanical clock, with raised geometry providing its outer bezel.
  c.fillStyle = '#10171e'; c.beginPath(); c.arc(384, 128, 121, 0, Math.PI * 2); c.fill();
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
  c.fillStyle = '#e1e5e8'; c.font = 'italic 38px Georgia'; c.fillText('Bugatti', 766, 74);
  c.fillStyle = '#afb9c1'; c.font = '15px sans-serif'; c.fillText('C H I R O N', 766, 108);
  c.fillStyle = '#c6ccd3'; c.font = '18px sans-serif';
  for (const [label, x, y] of [['TEMP', 640, 174], ['FAN', 895, 174], ['AUTO', 640, 288], ['AC', 895, 288], ['P  R  N  D', 766, 388], ['START / STOP', 766, 460]] as const) c.fillText(label, x, y);
  // Small controls share the existing atlas and material instead of new textures.
  c.font = '24px sans-serif'; c.fillStyle = '#dae0e6';
  c.fillText('+', 64, 291); c.fillText('−', 192, 291);
  c.fillText('MODE', 320, 291); c.fillText('SET', 448, 291);
  c.font = '15px sans-serif'; c.fillStyle = '#aab7c4';
  c.fillText('VOLUME', 128, 336); c.fillText('CRUISE', 384, 336);
  c.font = 'bold 19px sans-serif'; c.fillStyle = '#d3e4e9';
  for (const [index, label] of ['21°', 'AUTO', '21°', 'A/C'].entries()) c.fillText(label, 64 + index * 128, 374);
  c.font = '26px sans-serif'; c.fillStyle = '#bfcad4';
  c.fillText('ENGINE', 128, 423); c.fillText('START / STOP', 128, 456);
  // Square LCD inserts occupy previously unused atlas space. Every original
  // region stays intact so existing controls keep their authored UVs.
  for (const [index, [value, label]] of [['21.0°', 'TEMP'], ['AUTO', 'FAN'], ['21.0°', 'ZONE'], ['ON', 'A/C']].entries()) {
    const x = 288 + index * 64, y = 416;
    const glass = c.createRadialGradient(x - 6, y - 8, 0, x, y, 31);
    glass.addColorStop(0, '#1c303b'); glass.addColorStop(.72, '#0b151d'); glass.addColorStop(1, '#070d12');
    c.fillStyle = glass; c.beginPath(); c.arc(x, y, 30, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#879ca8'; c.lineWidth = .65;
    for (let tick = 0; tick < 24; tick++) {
      const angle = tick / 24 * Math.PI * 2;
      c.beginPath(); c.moveTo(x + Math.sin(angle) * 27, y - Math.cos(angle) * 27);
      c.lineTo(x + Math.sin(angle) * 28.5, y - Math.cos(angle) * 28.5); c.stroke();
    }
    c.fillStyle = '#d8f1f4'; c.textBaseline = 'middle'; c.font = `bold ${value.length > 4 ? 12 : 13}px sans-serif`; c.fillText(value, x, y - 3);
    c.fillStyle = '#8db2bd'; c.font = '7px sans-serif'; c.fillText(label, x, y + 11);
    c.fillStyle = '#eb9c52'; c.fillRect(x - 1, y - 25, 2, 4);
  }
  return canvasTexture(canvas);
}

/** Analog speedometer and digital side instruments update at most ten times a second. */
export function makeBugattiInstruments() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const c = canvas.getContext('2d')!;
  const map = canvasTexture(canvas);
  map.generateMipmaps = false; map.minFilter = THREE.LinearFilter;
  let previous = '';
  const readout = { speed: 0, boost: 100, firing: false };
  function dial(cx: number, cy: number, radius: number, maximum: number, divisions: number, label: string, unit: string) {
    const metal = c.createRadialGradient(cx - radius * .25, cy - radius * .3, radius * .5, cx, cy, radius);
    metal.addColorStop(0, '#18212a'); metal.addColorStop(.91, '#080c11'); metal.addColorStop(.93, '#9ba6b1'); metal.addColorStop(.97, '#3b434b'); metal.addColorStop(1, '#abb4bd');
    c.fillStyle = metal; c.beginPath(); c.arc(cx, cy, radius, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#2d3c48'; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, radius * .53, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i <= divisions * 5; i++) {
      const angle = Math.PI * (.75 + 1.5 * i / (divisions * 5));
      const major = i % 5 === 0;
      const inner = radius * (major ? .79 : .86), outer = radius * .91;
      c.strokeStyle = i > divisions * 4.35 ? '#d58658' : '#d9e1e6'; c.lineWidth = major ? 3 : 1.3;
      c.beginPath(); c.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      c.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer); c.stroke();
      if (major) {
        c.font = `${radius > 140 ? 19 : 15}px sans-serif`; c.fillStyle = '#c8d0d6';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(Math.round(i / (divisions * 5) * maximum)), cx + Math.cos(angle) * radius * .65, cy + Math.sin(angle) * radius * .65);
      }
    }
    c.font = `${radius > 140 ? 15 : 11}px sans-serif`; c.fillStyle = '#a7b4c0';
    c.fillText(label, cx, cy - radius * .31); c.fillText(unit, cx, cy + radius * .56);
  }
  // Tick marks, gradients and lettering never change. Rasterize them once;
  // live updates only copy that face and paint needles/digital readouts.
  dial(512, 265, 180, 420, 14, 'BUGATTI', 'km/h');
  for (const [x, title, unit] of [[68, 'ENGINE', 'x1000 RPM'], [742, 'POWER', 'RESERVE %']] as const) {
    const screen = c.createLinearGradient(x, 179, x, 371);
    screen.addColorStop(0, '#15232e'); screen.addColorStop(.4, '#08121b'); screen.addColorStop(1, '#0b1720');
    c.fillStyle = screen; c.beginPath(); c.roundRect(x, 179, 216, 192, 8); c.fill();
    c.strokeStyle = '#526674'; c.lineWidth = 2; c.stroke();
    c.strokeStyle = '#344652'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x + 17, 223); c.lineTo(x + 199, 223); c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#cfdee6'; c.font = '16px sans-serif'; c.fillText(title, x + 108, 203);
    c.fillStyle = '#8ba5b4'; c.font = '12px sans-serif'; c.fillText(unit, x + 108, 343);
    for (let i = 0; i < 8; i++) { c.fillStyle = '#263b47'; c.fillRect(x + 21 + i * 22, 304, 16, 9); }
  }
  c.fillStyle = '#9bb1bd'; c.font = '13px sans-serif';
  c.fillText('OIL  92°C', 176, 398); c.fillText('12.8 V', 850, 398);
  c.fillStyle = '#8699a5'; c.font = '14px sans-serif'; c.fillText('C H I R O N   /   W 1 6', 512, 474);
  const face = document.createElement('canvas'); face.width = canvas.width; face.height = canvas.height;
  face.getContext('2d')!.drawImage(canvas, 0, 0);
  function needle(cx: number, cy: number, radius: number, value: number, maximum: number) {
    const angle = Math.PI * (.75 + 1.5 * THREE.MathUtils.clamp(value / maximum, 0, 1));
    c.save(); c.translate(cx, cy); c.rotate(angle);
    c.fillStyle = '#ec9258'; c.beginPath(); c.moveTo(-radius * .15, -3); c.lineTo(radius * .82, -1.5);
    c.lineTo(radius * .82, 1.5); c.lineTo(-radius * .15, 3); c.closePath(); c.fill(); c.restore();
    c.fillStyle = '#9faab5'; c.beginPath(); c.arc(cx, cy, radius * .055, 0, Math.PI * 2); c.fill();
  }
  function paint(frame: CabinInstruments) {
    const speed = Math.round(frame.speed), boost = Math.round(frame.boost * 100);
    const signature = `${speed}/${boost}/${frame.boosting}/${frame.firing}`;
    if (signature === previous) return;
    previous = signature; readout.speed = speed; readout.boost = boost; readout.firing = frame.firing;
    c.clearRect(0, 0, 1024, 512);
    c.drawImage(face, 0, 0);
    needle(512, 265, 180, speed, 420);
    const rpm = Math.min(8, 1.1 + speed * .018 + (frame.boosting ? .7 : 0));
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#bde3ed'; c.font = '42px monospace';
    c.fillText(rpm.toFixed(1), 176, 262); c.fillText(String(boost), 850, 262);
    for (const [x, fraction] of [[68, rpm / 8], [742, boost / 100]]) {
      c.fillStyle = '#82bac8';
      for (let i = 0; i < Math.round(fraction * 8); i++) c.fillRect(x + 21 + i * 22, 304, 16, 9);
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#e5edf0'; c.font = '29px sans-serif'; c.fillText(String(speed), 512, 338);
    c.font = '17px sans-serif'; c.fillStyle = '#d6a173'; c.fillText(speed === 0 ? 'P' : `D${Math.min(7, 1 + Math.floor(speed / 45))}`, 512, 402);
    c.font = '16px sans-serif';
    if (frame.boosting) { c.fillStyle = '#c9a56d'; c.fillText('SPORT', 854, 441); }
    if (frame.firing) { c.fillStyle = '#c96b67'; c.beginPath(); c.arc(953, 456, 4, 0, Math.PI * 2); c.fill(); }
    map.needsUpdate = true;
  }
  paint({ speed: 0, boost: 1, boosting: false, firing: false });
  return { map, paint, get readout() { return readout; } };
}
