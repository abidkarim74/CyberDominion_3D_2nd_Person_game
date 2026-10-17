import * as THREE from 'three';

export type TunnelDetailOptions = {
  length: number;
  halfWidth: number;
  ceiling: number;
  wallHeight?: number;
  crossings?: readonly number[];
  crossingHalfWidth?: number;
  originZ?: number;
  label?: string;
  profile?: 'arched' | 'flat';
  sideClearance?: number;
};

/** Solid longitudinal wall intervals, with perpendicular road lanes left open. */
export function tunnelWallSections(half: number, crossings: readonly number[] = [], crossingHalfWidth = 9.8): [number, number][] {
  const openings = crossings.map(at => [Math.max(-half, at - crossingHalfWidth), Math.min(half, at + crossingHalfWidth)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const sections: [number, number][] = [];
  let start = -half;
  for (const [from, to] of openings) {
    if (from > start + .001) sections.push([start, from]);
    start = Math.max(start, to);
  }
  if (start < half - .001) sections.push([start, half]);
  return sections;
}

/** Static, batchable sci-fi tunnel fittings; no extra dynamic lights or updates. */
export function addTunnelDetails(group: THREE.Group, options: TunnelDetailOptions) {
  const { length, halfWidth, ceiling, label = 'TRANSIT LINK', profile = 'flat', originZ = 0,
    wallHeight = profile === 'arched' ? 3 : ceiling, crossings = [], crossingHalfWidth = 9.8 } = options;
  const half = length / 2, sections = tunnelWallSections(half, crossings, crossingHalfWidth);
  group.userData.tunnelLength = length;
  group.userData.tunnelCrossings = [...crossings];
  group.userData.tunnelWallSections = sections;
  group.userData.tunnelLabel = label;
  const metal = new THREE.MeshStandardMaterial({ color: 0x263647, metalness: .78, roughness: .36 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b1420, metalness: .52, roughness: .59 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x879ca8, metalness: .68, roughness: .32 });
  const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x39dcff).multiplyScalar(2), toneMapped: false });
  const blue = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x517fff).multiplyScalar(1.65), toneMapped: false });
  const amber = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb84f).multiplyScalar(1.65), toneMapped: false });
  const magenta = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf66dc6).multiplyScalar(1.55), toneMapped: false });
  const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd8f3ff).multiplyScalar(1.7), toneMapped: false });
  const green = new THREE.MeshBasicMaterial({ color: 0x61e4b0, toneMapped: false });
  for (const material of [cyan, blue, amber, magenta, white, green]) material.userData.noCastShadow = true;
  const cube = new THREE.BoxGeometry(1, 1, 1);
  function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = metal) {
    const mesh = new THREE.Mesh(cube, material); mesh.name = `Tunnel / ${name}`;
    mesh.position.set(x, y, originZ + z); mesh.scale.set(w, h, d); group.add(mesh); return mesh;
  }
  function rail(name: string, points: THREE.Vector3[], radius: number, material: THREE.Material, segments = 24) {
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, radius, 5, false), material);
    mesh.name = `Tunnel / ${name}`; mesh.position.z = originZ; group.add(mesh); return mesh;
  }
  const roofAt = (x: number) => profile === 'arched'
    ? wallHeight + (ceiling - wallHeight) * Math.sqrt(Math.max(0, 1 - (x / halfWidth) ** 2)) : ceiling;
  const isSolid = (z: number, padding = 0) => sections.some(([start, end]) => z - padding >= start && z + padding <= end);

  // Recessed directional strips stop at every side opening. Their pale backing
  // panels catch the city lighting without occupying any part of a road lane.
  for (const side of [-1, 1]) for (const [start, end] of sections) {
    const span = end - start, mid = (start + end) / 2;
    box('recessed wall light channel', side * (halfWidth - .035), 1.22, mid, .065, .23, span, dark);
    box('continuous side wayfinding light', side * (halfWidth - .077), 1.24, mid, .025, .055, span,
      side < 0 ? cyan : blue);
    box('wall service cable tray', side * (halfWidth - .035), Math.min(2.72, wallHeight - .18), mid, .08, .10, span, metal);
    box('secondary service conduit', side * (halfWidth - .075), Math.min(2.48, wallHeight - .40), mid, .045, .035, span, dark);
    for (let at = start + 1.4; at < end - .6; at += 3.8) {
      box('brushed reflective wall panel', side * (halfWidth - .022), 1.93, at, .034, .72, 2.9, panel);
      box('panel expansion joint', side * (halfWidth - .055), 1.93, at + 1.48, .035, .88, .045, dark);
      const marker = box('angled amber lane reflector', side * (halfWidth - .095), .79, at, .028, .10, .36, amber);
      marker.rotation.x = side * -.22;
    }
  }

  // Ceiling guides and lamp banks continue across junctions above the full
  // traffic envelope. Paired colors make each direction readable at speed.
  for (const side of [-1, 1]) {
    const x = side * halfWidth * .60, y = roofAt(x) - .14;
    box('overhead recessed guide channel', x, y + .025, 0, .19, .10, length, dark);
    box('continuous overhead cyan guide', x, y - .03, 0, .065, .035, length, side < 0 ? cyan : blue);
    const conduitX = side * halfWidth * .78;
    for (const offset of [0, .12]) box('ceiling service conduit', conduitX, roofAt(conduitX) - .18 - offset, 0, .07, .07, length, metal);
  }
  let station = 0;
  for (let at = -half + 2.4; at < half - 1.2; at += 5.4, station++) {
    const junction = crossings.some(cross => Math.abs(cross - at) < crossingHalfWidth);
    for (const side of [-1, 1]) {
      const x = side * halfWidth * .36, y = roofAt(x) - .20;
      box('segmented ceiling lightbank housing', x, y, at, .64, .15, 2.25, dark);
      for (let slot = 0; slot < 3; slot++) box('ceiling lamp diffuser', x + (slot - 1) * .16, y - .085, at, .085, .035, 1.94,
        junction ? amber : white);
      box('lightbank circuit marker', x, y - .085, at - 1.01, .46, .035, .055, station % 5 === 0 ? magenta : cyan);
    }
    if (station % 3 === 0) {
      box('suspended technical ceiling cassette', 0, ceiling - .30, at, 1.24, .24, 1.55, dark);
      for (let slat = 0; slat < 5; slat++) box('vent cassette grille', (slat - 2) * .18, ceiling - .445, at, .055, .035, 1.25, panel);
    }
  }

  // Emergency service bays are sunk into existing wall intervals, with compact
  // status indicators and a protective frame kept outside the driving width.
  for (const [index, [start, end]] of sections.entries()) {
    if (end - start < 8) continue;
    const side = index % 2 ? 1 : -1, at = (start + end) / 2;
    box('inset emergency service bay', side * (halfWidth - .01), 1.69, at, .06, 2.66, 1.46, dark);
    for (const edge of [-1, 1]) box('emergency door vertical frame', side * (halfWidth - .075), 1.69, at + edge * .72, .04, 2.76, .055, panel);
    box('emergency door top frame', side * (halfWidth - .075), 3.06, at, .04, .055, 1.49, panel);
    box('emergency exit status panel', side * (halfWidth - .09), 2.82, at, .035, .23, .72, green);
    box('emergency door center seam', side * (halfWidth - .08), 1.62, at, .04, 2.05, .035, metal);
    box('emergency call cabinet', side * (halfWidth - .13), 1.45, at + 1.12, .16, .66, .43, amber);
    box('emergency call cabinet inset', side * (halfWidth - .22), 1.52, at + 1.12, .025, .27, .28, dark);
    box('emergency locator beacon', side * (halfWidth - .09), 3.30, at, .04, .055, 1.54, magenta);
  }

  // Side portals span only the cross street's clear opening; their posts stand
  // beyond its edges. Cars can leave and enter without striking a curb or pier.
  const sideClearance = options.sideClearance ?? (profile === 'arched' ? wallHeight - .12 : Math.min(5.2, ceiling - .8));
  for (const crossing of crossings) {
    if (crossing - crossingHalfWidth <= -half || crossing + crossingHalfWidth >= half) continue;
    for (const side of [-1, 1]) {
      const x = side * (halfWidth + .15);
      box('cross street portal lintel', x, sideClearance + .25, crossing, .64, .50, crossingHalfWidth * 2 + .65, metal);
      box('cross street amber clearance strip', side * (halfWidth - .19), sideClearance + .015, crossing, .045, .055, crossingHalfWidth * 2 - .12, amber);
      for (const edge of [-1, 1]) {
        const at = crossing + edge * (crossingHalfWidth + .30);
        box('cross street portal upright', x, sideClearance / 2, at, .64, sideClearance, .60, metal);
        box('cross street portal vertical locator', side * (halfWidth - .19), sideClearance / 2, at, .04, sideClearance - .30, .06, cyan);
      }
    }
    for (const side of [-1, 1]) {
      box('junction overhead warning cassette', side * 2.7, ceiling - .24, crossing, 2.1, .16, .54, dark);
      for (let i = 0; i < 3; i++) box('junction overhead warning bars', side * 2.7 + (i - 1) * .45, ceiling - .335, crossing, .22, .035, .38, amber);
    }
  }

  // Nested portal frames and a short approach light sequence emphasize the new
  // full-length endpoints rather than leaving the old entrance fittings inside.
  for (const end of [-1, 1]) {
    const at = end * (half - .32);
    if (profile === 'arched') {
      const points = Array.from({ length: 25 }, (_, i) => {
        const angle = Math.PI * i / 24;
        return new THREE.Vector3(Math.cos(angle) * (halfWidth - .13), wallHeight + Math.sin(angle) * (ceiling - wallHeight - .13), at);
      });
      rail('machined portal arch frame', points, .14, metal, 40);
      rail('cyan inner portal arch', points.map(p => new THREE.Vector3(p.x * .986, p.y - .09, p.z - end * .10)), .035, cyan, 40);
    } else {
      box('machined portal header', 0, ceiling - .05, at, halfWidth * 2 + .20, .40, .56, metal);
      box('cyan inner portal header', 0, ceiling - .28, at - end * .12, halfWidth * 2 - .22, .055, .055, cyan);
    }
    for (const side of [-1, 1]) {
      box('portal buttress', side * (halfWidth + .25), wallHeight / 2, at, .50, wallHeight, .82, metal);
      box('portal vertical approach guide', side * (halfWidth - .07), Math.min(2.5, wallHeight / 2), at - end * .13,
        .055, Math.min(4.6, wallHeight - .30), .055, side < 0 ? cyan : magenta);
      for (let marker = 0; marker < 4; marker++) {
        const z = end * (half - 1.2 - marker * 1.3);
        if (isSolid(z, .2)) box('portal sequential amber marker', side * (halfWidth - .12), .88, z, .035, .10, .35, amber);
      }
    }
  }
  return { sections, crossings: [...crossings], length, halfWidth, ceiling };
}
