import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(3500);
  const profile = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    g.active = false;
    const gl = g.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    const meshCosts = [];
    g.scene.updateMatrixWorld(true);
    const Matrix = g.camera.projectionMatrix.constructor, clipMatrix = new Matrix().multiplyMatrices(g.camera.projectionMatrix, g.camera.matrixWorldInverse);
    const planes = [];
    const m = clipMatrix.elements;
    for (const [a, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
      const plane = [m[3] + sign * m[a], m[7] + sign * m[a + 4], m[11] + sign * m[a + 8], m[15] + sign * m[a + 12]];
      const length = Math.hypot(...plane.slice(0, 3)); planes.push(plane.map(x => x / length));
    }
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      for (let parent = o; parent; parent = parent.parent) if (!parent.visible) return;
      const geometry = o.geometry;
      if (!geometry.attributes.position) return;
      const count = geometry.index?.count || geometry.attributes.position.count;
      const instances = o.isInstancedMesh ? o.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
      const triangles = Math.min(count - geometry.drawRange.start, geometry.drawRange.count) / 3 * instances;
      let inView = true;
      if (o.frustumCulled && !o.isInstancedMesh) {
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        const sphere = geometry.boundingSphere, center = sphere.center.clone().applyMatrix4(o.matrixWorld), matrix = o.matrixWorld.elements;
        const radius = sphere.radius * Math.max(Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10]));
        inView = planes.every(p => p[0] * center.x + p[1] * center.y + p[2] * center.z + p[3] >= -radius);
      }
      if (triangles > 200) meshCosts.push({ name: o.name, triangles, instances, inView, frustumCulled: o.frustumCulled, castShadow: o.castShadow, material: Array.isArray(o.material) ? 'array' : o.material.type, map: !!o.material.map, transparent: !!o.material.transparent, bounds: geometry.boundingBox?.min.toArray().concat(geometry.boundingBox.max.toArray()) });
    });
    meshCosts.sort((a, b) => b.triangles - a.triangles);
    const measure = async () => {
      const frames = [], calls = [], triangles = [];
      let last = performance.now();
      await new Promise(resolve => { function tick(t) { frames.push(t - last); last = t; calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles); if (frames.length < 75) requestAnimationFrame(tick); else resolve(); } requestAnimationFrame(tick); });
      frames.sort((a, b) => a - b); calls.sort((a, b) => a - b); triangles.sort((a, b) => a - b);
      return { medianMs: frames[37], p95Ms: frames[71], calls: { median: calls[37], p95: calls[71] }, triangles: { median: triangles[37], p95: triangles[71] } };
    };
    const full = await measure();
    g.reflections.mirror.visible = false; const noReflection = await measure(); g.reflections.mirror.visible = true;
    const bloom = g.composer.passes[1]; bloom.enabled = false; const noBloom = await measure(); bloom.enabled = true;
    g.island.water.visible = false; const noOcean = await measure();
    return { gpu, pixelRatio: g.renderer.getPixelRatio(), topVisible: meshCosts.filter(m => m.inView).slice(0, 25), topTotal: meshCosts.slice(0, 25), full, noReflection, noBloom, noOcean };
  });
  await writeFile('artifacts/cyberpunk-profile.json', JSON.stringify(profile, null, 2));
  console.log(JSON.stringify(profile, null, 2));
} finally { await browser.close(); }
