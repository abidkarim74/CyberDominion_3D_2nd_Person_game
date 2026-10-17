import * as THREE from 'three';
import type { GraphicsQuality } from './graphics-quality';
import { prepareRearviewOpening } from './rear-cabin';

type MirrorSurface = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type RearviewMirror = {
  surface: MirrorSurface;
  anchor: THREE.Object3D;
  occupant?: THREE.Object3D;
  beforeCapture?: () => void;
  afterCapture?: () => void;
};

/** Separate the authored mirror insert from its shared door trim, keeping its exact outline. */
export function splitSideMirrorSurface(geometry: THREE.BufferGeometry, side: number) {
  const positions = geometry.getAttribute('position'), index = geometry.index!;
  const selected: number[] = [], retained: number[] = [];
  function inside(vertex: number) {
    return positions.getX(vertex) * side > .88 && positions.getY(vertex) > .90 &&
      positions.getZ(vertex) > -.70 && positions.getZ(vertex) < -.58;
  }
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const vertices = [index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2)];
    (vertices.every(inside) ? selected : retained).push(...vertices);
  }
  if (!selected.length) return;
  geometry.setIndex(retained);

  const normal = new THREE.Vector3(-side * .523964, .016652, .851578).normalize();
  const right = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, normal).normalize();
  const up = new THREE.Vector3().crossVectors(normal, right).normalize();
  const point = new THREE.Vector3(), vertices: number[] = [], uv: number[] = [];
  const unique = [...new Set(selected)], remap = new Map(unique.map((vertex, i) => [vertex, i]));
  const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
  for (const vertex of unique) {
    point.fromBufferAttribute(positions, vertex);
    // A tiny offset avoids the source face's edge sharing the housing's depth.
    point.addScaledVector(normal, .0003); vertices.push(...point.toArray());
    const u = point.dot(right), v = point.dot(up);
    min.x = Math.min(min.x, u); min.y = Math.min(min.y, v);
    max.x = Math.max(max.x, u); max.y = Math.max(max.y, v);
    uv.push(u, v);
  }
  for (let i = 0; i < uv.length; i += 2) {
    // Rear-facing camera images must be flipped horizontally to behave as mirrors.
    uv[i] = 1 - (uv[i] - min.x) / (max.x - min.x);
    uv[i + 1] = (uv[i + 1] - min.y) / (max.y - min.y);
  }
  const insert = new THREE.BufferGeometry();
  insert.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  insert.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  insert.setIndex(selected.map(vertex => remap.get(vertex)!));
  insert.computeVertexNormals(); insert.computeBoundingSphere(); insert.computeBoundingBox();
  const material = new THREE.MeshBasicMaterial({ color: 0xc4d0dc, side: THREE.DoubleSide });
  material.name = 'Bugatti / live side mirror glass';
  material.userData.noCastShadow = true;
  const surface = new THREE.Mesh(insert, material);
  surface.name = `Bugatti / ${side < 0 ? 'driver' : 'passenger'} live side mirror`;
  surface.userData.carPart = side < 0 ? 'driverDoor' : 'passengerDoor';
  surface.userData.dynamic = true; surface.userData.cockpitDetail = true;
  surface.userData.noCastShadow = true; surface.userData.side = side; surface.userData.sideMirror = true;
  return surface;
}

/** Small rear cameras run only for visible mirrors in the occupied driver view. */
export function createDrivingMirrors(
  surfaces: MirrorSurface[],
  excluded: THREE.Object3D[],
  rearview?: RearviewMirror,
) {
  const allSurfaces = rearview ? [...surfaces, rearview.surface] : surfaces;
  const mirrors = allSurfaces.map(surface => {
    const isRearview = surface === rearview?.surface;
    surface.geometry.computeBoundingBox();
    const bounds = surface.geometry.boundingBox!;
    const aspect = isRearview ? THREE.MathUtils.clamp((bounds.max.x - bounds.min.x) / (bounds.max.y - bounds.min.y), 2.4, 4.6) : 4 / 3;
    const width = isRearview ? 336 : 192;
    const target = new THREE.WebGLRenderTarget(width, Math.round(width / aspect), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
      stencilBuffer: false, type: THREE.HalfFloatType,
    });
    target.texture.name = `${surface.name} / rear camera`;
    surface.material.map = target.texture; surface.material.needsUpdate = true;
    // Start the optical view beyond its nearby roof mount, keeping that fixture
    // out of the reflected rear window while retaining both seat headrests.
    return { surface, target, camera: new THREE.PerspectiveCamera(isRearview ? 14 : 55, aspect, isRearview ? .18 : .08, 230),
      center: bounds.getCenter(new THREE.Vector3()), aspect, isRearview,
      captures: 0, capturedAt: -Infinity };
  });
  let rearviewVehicle: THREE.Object3D | undefined;
  let rearviewOpening: ReturnType<typeof prepareRearviewOpening> | undefined;
  if (rearview) {
    for (let object: THREE.Object3D | null = rearview.anchor; object; object = object.parent) {
      if (excluded.includes(object)) { rearviewVehicle = object; break; }
    }
    const central = mirrors.find(mirror => mirror.isRearview)!;
    rearview.surface.updateWorldMatrix(true, false); rearview.anchor.updateWorldMatrix(true, false);
    const origin = rearview.anchor.worldToLocal(rearview.surface.localToWorld(central.center.clone()));
    rearviewOpening = prepareRearviewOpening(rearview.anchor, origin);
  }
  const interiorExcluded = [...new Set([...excluded.filter(object => object !== rearviewVehicle && object !== rearview?.occupant), ...allSurfaces])];
  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  const direction = new THREE.Vector3(), lookAt = new THREE.Vector3();
  const viewport = new THREE.Vector4(), scissor = new THREE.Vector4();
  const visibility: boolean[] = [];
  let interval = 1 / 12, lastCapture = -Infinity, nextMirror = 0, presetKey = '';
  let wasEnabled = false;
  return {
    mirrors, rearviewOpening,
    invalidate() { for (const mirror of mirrors) mirror.capturedAt = -Infinity; lastCapture = -Infinity; },
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = THREE.MathUtils.clamp(Math.floor(pressure), 0, 4), key = `${preset}:${load}`;
      if (presetKey === key) return;
      presetKey = key;
      const width = Math.max(96, Math.round(({ low: 128, medium: 192, high: 256, ultra: 384 }[preset]) * (1 - load * .1) / 32) * 32);
      interval = (1 + load * .15) / ({ low: 6, medium: 9, high: 12, ultra: 20 }[preset]);
      for (const mirror of mirrors) {
        const mirrorWidth = mirror.isRearview ? Math.round(width * 1.75 / 32) * 32 : width;
        mirror.target.setSize(mirrorWidth, Math.round(mirrorWidth / mirror.aspect)); mirror.capturedAt = -Infinity;
      }
      lastCapture = -Infinity;
    },
    update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, mainCamera: THREE.PerspectiveCamera, time: number, enabled: boolean) {
      if (!enabled) { wasEnabled = false; return; }
      if (!wasEnabled) { for (const mirror of mirrors) mirror.capturedAt = -Infinity; lastCapture = -Infinity; }
      wasEnabled = true;
      mainCamera.updateMatrixWorld();
      viewProjection.multiplyMatrices(mainCamera.projectionMatrix, mainCamera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      // Alternate captures so normal frames pay for at most one additional city render.
      for (let offset = 0; offset < mirrors.length; offset++) {
        const i = (nextMirror + offset) % mirrors.length, mirror = mirrors[i];
        const { surface, camera, target } = mirror;
        surface.updateWorldMatrix(true, false);
        if (!frustum.intersectsObject(surface)) continue;
        const fresh = mirror.capturedAt === -Infinity;
        // Keep the same total capture budget when a panoramic mirror is added.
        if (!fresh && (time - lastCapture < interval / 2 || time - mirror.capturedAt < interval)) continue;
        if (mirror.isRearview && rearview) {
          rearview.anchor.updateWorldMatrix(true, false);
          // An optical mirror looks back from the glass through the actual
          // cabin. Headrests and the trimmed rear window belong in its view.
          surface.localToWorld(camera.position.copy(mirror.center));
          rearview.anchor.localToWorld(lookAt.set(0, 1.105, .738));
          direction.copy(lookAt).sub(camera.position).normalize();
          camera.up.set(0, 1, 0).transformDirection(rearview.anchor.matrixWorld);
        } else {
          surface.localToWorld(camera.position.copy(mirror.center));
          // Side cameras follow their door, including when turning or reversing.
          direction.set(surface.userData.side * .22, -.035, 1).transformDirection(surface.matrixWorld);
          camera.up.set(0, 1, 0).transformDirection(surface.matrixWorld);
        }
        lookAt.copy(camera.position).add(direction); camera.lookAt(lookAt); camera.updateMatrixWorld();
        const previousTarget = renderer.getRenderTarget(), cubeFace = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        renderer.getViewport(viewport); renderer.getScissor(scissor);
        const scissorTest = renderer.getScissorTest(), xr = renderer.xr.enabled;
        const shadowAuto = renderer.shadowMap.autoUpdate, shadowUpdate = renderer.shadowMap.needsUpdate;
        const autoClear = renderer.autoClear;
        const hidden = mirror.isRearview ? interiorExcluded : excluded;
        for (let j = 0; j < hidden.length; j++) { visibility[j] = hidden[j].visible; hidden[j].visible = false; }
        renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
        renderer.autoClear = true;
        try {
          if (mirror.isRearview) {
            rearviewOpening?.begin();
            // The first-person head mask is only for the driver's eyes. The
            // optical rearview sees the same driver's complete authored model.
            rearview?.beforeCapture?.();
          }
          renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.render(scene, camera);
          mirror.capturedAt = time; mirror.captures++; lastCapture = time;
        } finally {
          try {
            if (mirror.isRearview) rearview?.afterCapture?.();
          } finally {
            if (mirror.isRearview) rearviewOpening?.restore();
            for (let j = 0; j < hidden.length; j++) hidden[j].visible = visibility[j];
            renderer.xr.enabled = xr; renderer.shadowMap.autoUpdate = shadowAuto; renderer.shadowMap.needsUpdate = shadowUpdate;
            renderer.autoClear = autoClear;
            renderer.setRenderTarget(previousTarget, cubeFace, mip); renderer.setViewport(viewport);
            renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
          }
        }
        nextMirror = (i + 1) % mirrors.length;
        break;
      }
    },
    dispose() { rearviewOpening?.dispose(); for (const mirror of mirrors) mirror.target.dispose(); },
  };
}
