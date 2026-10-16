import * as THREE from 'three';

/** Deterministic, submillimetre lacquer detail shared by all painted panels. */
export function createLacquerMaps() {
  const relief = document.createElement('canvas');
  const roughness = document.createElement('canvas');
  relief.width = relief.height = roughness.width = roughness.height = 128;
  const bumpContext = relief.getContext('2d')!;
  const roughContext = roughness.getContext('2d')!;
  const bumpPixels = bumpContext.createImageData(128, 128);
  const roughPixels = roughContext.createImageData(128, 128);
  let seed = 5147;
  for (let i = 0; i < bumpPixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const grain = (seed >>> 24) / 255 - .5;
    for (let channel = 0; channel < 3; channel++) {
      bumpPixels.data[i + channel] = 128 + grain * 24;
      roughPixels.data[i + channel] = 232 + grain * 12;
    }
    bumpPixels.data[i + 3] = roughPixels.data[i + 3] = 255;
  }
  bumpContext.putImageData(bumpPixels, 0, 0);
  roughContext.putImageData(roughPixels, 0, 0);
  const bump = new THREE.CanvasTexture(relief);
  const rough = new THREE.CanvasTexture(roughness);
  for (const map of [bump, rough]) {
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(48, 48);
    map.anisotropy = 4;
  }
  return { bump, roughness: rough };
}

/** Ceramic grain, circumferential wear, and recessed cross-drilling. */
export function createCeramicRotorMaps() {
  const color = document.createElement('canvas');
  const relief = document.createElement('canvas');
  color.width = color.height = relief.width = relief.height = 512;
  const paint = color.getContext('2d')!, bump = relief.getContext('2d')!;
  const pixels = paint.createImageData(512, 512);
  let seed = 8101;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const grain = ((seed >>> 24) / 255 - .5) * 15;
    pixels.data[i] = 106 + grain;
    pixels.data[i + 1] = 110 + grain;
    pixels.data[i + 2] = 115 + grain;
    pixels.data[i + 3] = 255;
  }
  paint.putImageData(pixels, 0, 0);
  bump.fillStyle = '#a0a0a0'; bump.fillRect(0, 0, 512, 512);
  for (let radius = 101; radius < 253; radius += 2.4) {
    for (const [context, shade] of [[paint, 'rgba(193,199,202,.16)'], [bump, '#ababab']] as const) {
      context.beginPath(); context.arc(256, 256, radius, 0, Math.PI * 2);
      context.strokeStyle = shade; context.lineWidth = .7; context.stroke();
    }
  }
  for (let sector = 0; sector < 14; sector++) for (let row = 0; row < 4; row++) {
    const angle = sector / 14 * Math.PI * 2 + row * .105;
    const radius = 133 + row * 29;
    const x = 256 + Math.cos(angle) * radius, y = 256 + Math.sin(angle) * radius;
    paint.beginPath(); paint.arc(x, y, 4.7, 0, Math.PI * 2);
    paint.fillStyle = '#20242a'; paint.fill();
    paint.strokeStyle = '#8a8e92'; paint.lineWidth = .9; paint.stroke();
    bump.beginPath(); bump.arc(x, y, 4.7, 0, Math.PI * 2);
    bump.fillStyle = '#181818'; bump.fill();
  }
  for (const [context, shade] of [[paint, '#252a31'], [bump, '#606060']] as const) {
    context.beginPath(); context.arc(256, 256, 101, 0, Math.PI * 2);
    context.fillStyle = shade; context.fill();
  }
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const bumpMap = new THREE.CanvasTexture(relief);
  map.anisotropy = bumpMap.anisotropy = 4;
  return { map, bumpMap };
}
