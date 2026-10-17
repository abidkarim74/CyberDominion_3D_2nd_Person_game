import * as THREE from 'three';
import type { GraphicsQuality } from './graphics-quality';

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
  surfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[],
  excluded: THREE.Object3D[],
) {
  const mirrors = surfaces.map(surface => {
    const target = new THREE.WebGLRenderTarget(192, 144, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
      stencilBuffer: false, type: THREE.HalfFloatType,
    });
    target.texture.name = `${surface.name} / rear camera`;
    surface.material.map = target.texture; surface.material.needsUpdate = true;
    surface.geometry.computeBoundingBox();
    return { surface, target, camera: new THREE.PerspectiveCamera(55, 4 / 3, .08, 230),
      center: surface.geometry.boundingBox!.getCenter(new THREE.Vector3()),
      captures: 0, capturedAt: -Infinity };
  });
  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  const direction = new THREE.Vector3(), lookAt = new THREE.Vector3();
  const viewport = new THREE.Vector4(), scissor = new THREE.Vector4();
  const visibility: boolean[] = [];
  let interval = 1 / 12, lastCapture = -Infinity, nextMirror = 0, presetKey = '';
  let wasEnabled = false;
  return {
    mirrors,
    invalidate() { for (const mirror of mirrors) mirror.capturedAt = -Infinity; lastCapture = -Infinity; },
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = THREE.MathUtils.clamp(Math.floor(pressure), 0, 4), key = `${preset}:${load}`;
      if (presetKey === key) return;
      presetKey = key;
      const width = Math.max(96, Math.round(({ low: 128, medium: 192, high: 256, ultra: 384 }[preset]) * (1 - load * .1) / 32) * 32);
      interval = (1 + load * .15) / ({ low: 6, medium: 9, high: 12, ultra: 20 }[preset]);
      for (const mirror of mirrors) {
        mirror.target.setSize(width, Math.round(width * .75)); mirror.capturedAt = -Infinity;
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
        if (!fresh && (time - lastCapture < interval / mirrors.length || time - mirror.capturedAt < interval)) continue;
        surface.localToWorld(camera.position.copy(mirror.center));
        // Mirror pose follows its door and the suspension, including when turning or reversing.
        direction.set(surface.userData.side * .22, -.035, 1).transformDirection(surface.matrixWorld);
        camera.up.set(0, 1, 0).transformDirection(surface.matrixWorld);
        lookAt.copy(camera.position).add(direction); camera.lookAt(lookAt); camera.updateMatrixWorld();
        const previousTarget = renderer.getRenderTarget(), cubeFace = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        renderer.getViewport(viewport); renderer.getScissor(scissor);
        const scissorTest = renderer.getScissorTest(), xr = renderer.xr.enabled;
        const shadowAuto = renderer.shadowMap.autoUpdate, shadowUpdate = renderer.shadowMap.needsUpdate;
        const autoClear = renderer.autoClear;
        for (let j = 0; j < excluded.length; j++) { visibility[j] = excluded[j].visible; excluded[j].visible = false; }
        renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
        renderer.autoClear = true;
        try {
          renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.render(scene, camera);
          mirror.capturedAt = time; mirror.captures++; lastCapture = time;
        } finally {
          for (let j = 0; j < excluded.length; j++) excluded[j].visible = visibility[j];
          renderer.xr.enabled = xr; renderer.shadowMap.autoUpdate = shadowAuto; renderer.shadowMap.needsUpdate = shadowUpdate;
          renderer.autoClear = autoClear;
          renderer.setRenderTarget(previousTarget, cubeFace, mip); renderer.setViewport(viewport);
          renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
        }
        nextMirror = (i + 1) % mirrors.length;
        break;
      }
    },
    dispose() { for (const mirror of mirrors) mirror.target.dispose(); },
  };
}
