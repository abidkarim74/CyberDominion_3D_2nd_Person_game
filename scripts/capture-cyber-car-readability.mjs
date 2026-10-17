import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(12000);
  await page.getByRole('button', { name: 'Inspect car from all sides', exact: true }).click();
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.reset(); g.active = false;
    cancelAnimationFrame(g.animationFrame);
    g.qualityLevel = 0; g.qualityTimer = 0; g.renderer.shadowMap.enabled = true; g.resize();
    g.carRig.body.position.y = 0; g.carRig.body.rotation.set(0, 0, 0);
  });
  await page.addStyleTag({ content: '.drive-hud,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident{display:none !important}' });
  const capture = async (phase, label, x, y, z) => {
    await page.evaluate(({ x, y, z }) => {
      const g = document.querySelector('canvas').__drive;
      g.camera.position.copy(g.carPosition).add({ x, y, z });
      g.camera.fov = 45; g.camera.near = .1; g.camera.updateProjectionMatrix();
      g.camera.lookAt(g.carPosition.clone().add({ x: 0, y: .65, z: 0 }));
      g.renderer.shadowMap.needsUpdate = true;
      for (let frame = 0; frame < 6; frame++) g.composer.render();
    }, { x, y, z });
    await page.screenshot({ path: `artifacts/cyber-car-readability-${phase}${label}.png` });
  };
  for (const [label, x, y, z] of [['rear-three-quarter', -4.6, 2, 6.9], ['left-side', -7.2, 1.8, .4]]) await capture('original-', label, x, y, z);
  const changed = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive, changed = [], seen = new Set();
    g.car.traverse(o => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        if (seen.has(m)) continue; seen.add(m);
        if (m.name === 'Car / graphite metallic clearcoat') { m.color.setHex(0x242a31); m.metalness = .60; m.roughness = .25; changed.push(m.name); }
        if (m.name === 'Car / machined gunmetal alloy') { m.color.setHex(0x7b8790); m.roughness = .28; changed.push(m.name); }
        if (m.name === 'Car / resin-coated woven carbon') { m.bumpScale = .0007; changed.push(m.name); }
      }
    });
    return changed;
  });
  for (const [label, x, y, z] of [['front-three-quarter', 4.5, 2.3, -6.8], ['rear-three-quarter', -4.6, 2, 6.9], ['left-side', -7.2, 1.8, .4]]) await capture('', label, x, y, z);
  await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    g.active = true; g.camera.fov = 50; g.camera.updateProjectionMatrix(); g.updateCamera(0, true);
    g.qualityTimer = 0; g.averageFrame = 16; g.previousTime = performance.now();
    g.animationFrame = requestAnimationFrame(g.frameHandler);
  });
  await page.waitForTimeout(12000);
  const performanceReport = await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive, frames = [], calls = [], triangles = []; let last = performance.now();
    await new Promise(resolve => { function tick(now) { frames.push(now - last); last = now; calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles); if (frames.length < 100) requestAnimationFrame(tick); else resolve(); } requestAnimationFrame(tick); });
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const p95 = values => values.sort((a, b) => a - b)[Math.floor(values.length * .95)];
    return { medianMs: median(frames), p95Ms: p95(frames), calls: median(calls), triangles: median(triangles), qualityLevel: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), contextLost: g.renderer.getContext().isContextLost() };
  });
  const report = { changed, performance: performanceReport, errors };
  await writeFile('artifacts/cyber-car-readability.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
