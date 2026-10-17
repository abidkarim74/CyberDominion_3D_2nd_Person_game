import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory = 'artifacts/graphics-presets';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = { presets: [], persistence: null, adaptation: null, driving: null, views: [], errors };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.GAME_URL || 'http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  console.log('Game and character ready');
  await page.locator('.graphics-toggle').click();
  // The hardware recommendation can already select Low; checking an already
  // selected native radio is intentionally a no-op, so opt into fixed mode.
  if (await page.locator('#graphics-automatic').isChecked()) {
    // The visible switch is drawn over the native checkbox; use its label.
    await page.locator('label[for="graphics-automatic"]').click();
  }
  await page.waitForFunction(() => !document.querySelector('canvas').__drive.getGraphicsStatus().automatic);
  for (const [index, quality] of ['low', 'medium', 'high', 'ultra'].entries()) {
    console.log(`Applying ${quality}`);
    await page.getByRole('radio', { name: quality, exact: false }).check();
    await page.waitForFunction(quality => document.querySelector('canvas').__drive.getGraphicsStatus().preset === quality, quality);
    await page.waitForTimeout(450);
    const state = await page.evaluate(async () => {
      const g = document.querySelector('canvas').__drive;
      const { GRAPHICS_PRESETS } = await import('/lib/graphics-quality.ts');
      return { ...g.getGraphicsStatus(), profile: GRAPHICS_PRESETS[g.getGraphicsStatus().preset], shadow: g.keyLight.shadow.mapSize.x,
        roadReflection: g.scene.getObjectByName('Road / wet asphalt reflections')?.visible ?? false, snow: g.snowfall.flakes.geometry.drawRange.count,
        localLights: g.scene.children.filter(o => o.isPointLight && o.visible && o.intensity > 0).length,
        scene: [g.composer.readBuffer.width, g.composer.readBuffer.height],
        edgeQuality: g.presentationPass.uniforms.resolveQuality.value,
        bloom: [g.bloomPass.bloomTexture.image.width, g.bloomPass.bloomTexture.image.height],
        contextLost: g.renderer.getContext().isContextLost(), active: g.active,
        colliders: g.collisionWorld.colliders?.length ?? g.colliders.length };
    });
    assert.equal(state.preset, quality);
    assert.equal(state.automatic, false, 'A manual preset stays fixed');
    assert.equal(state.contextLost, false);
    assert.equal(state.active, false, 'Driving pauses while graphics are open');
    assert.equal(state.roadReflection, false, 'Matte roads have no wet-road mirror at every graphics preset');
    assert.equal(state.shadow, state.profile.shadowSize);
    assert.equal(state.snow, Math.floor(3200 * state.profile.snowDensity));
    if (index) {
      const previous = report.presets[index - 1];
      assert.ok(state.resolutionScale > previous.resolutionScale, 'Each preset delivers more scene pixels');
      assert.ok(state.shadow >= previous.shadow, 'Shadow detail never decreases');
      assert.ok(state.localLights >= previous.localLights, 'Lighting work never decreases');
      assert.equal(state.colliders, previous.colliders, 'Preset switching preserves collision geometry');
    }
    report.presets.push(state);
    console.log(`${quality}: ${Math.round(state.resolutionScale * 100)}% scene scale, matte road surface`);
  }
  await page.screenshot({ path: `${directory}/ultra-settings.png` });
  console.log('All presets rendered; capturing Ultra camera views');
  await page.getByRole('button', { name: 'Back to the city' }).click();
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${directory}/ultra-chase.png` });
  for (const view of ['orbit', 'driver', 'chase']) {
    await page.evaluate(view => {
      const g = document.querySelector('canvas').__drive;
      g.setCameraView(view); g.updateCamera(0, true);
    }, view);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${directory}/ultra-${view}.png` });
    report.views.push(await page.evaluate(() => {
      const g = document.querySelector('canvas').__drive;
      return { view: g.cameraView, contextLost: g.renderer.getContext().isContextLost() };
    }));
  }
  await page.keyboard.down('w');
  await page.waitForFunction(() => document.querySelector('canvas').__drive.velocity.length() > 3, null, { timeout: 15000 });
  await page.keyboard.up('w');
  report.driving = await page.evaluate(() => ({ speed: document.querySelector('canvas').__drive.velocity.length() }));

  await page.reload({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.person.ready, null, { timeout: 90000 });
  report.persistence = await page.evaluate(() => document.querySelector('canvas').__drive.getGraphicsStatus());
  assert.equal(report.persistence.preset, 'ultra');
  assert.equal(report.persistence.automatic, false);

  // Feed repeated over-budget frames through the real sampler, then verify a
  // fixed selection resists the same pressure and automatic scaling can recover.
  report.adaptation = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    const sample = (ms, seconds) => {
      for (let i = 0; i < seconds * 1000 / ms; i++) {
        g.elapsed += ms / 1000; g.updateRenderQuality(ms, ms / 1000);
      }
    };
    g.elapsed = 40; g.qualityWarmup = 0; g.qualityResumeTime = 0;
    sample(32, 14);
    const fixed = g.getGraphicsStatus(), fixedPressure = g.qualityLevel;
    g.setAutomaticGraphics(true); g.qualityResumeTime = 0;
    sample(32, 14);
    const adapted = g.getGraphicsStatus(), adaptedPressure = g.qualityLevel;
    sample(16, 60);
    const recovered = g.getGraphicsStatus(), recoveredPressure = g.qualityLevel;
    return { fixed, fixedPressure, adapted, adaptedPressure, recovered, recoveredPressure };
  });
  assert.equal(report.adaptation.fixedPressure, 0, 'Fixed Ultra never downgrades itself');
  assert.ok(report.adaptation.adaptedPressure > 0, 'Sustained load trims automatic rendering work');
  assert.ok(report.adaptation.adapted.resolutionScale < report.adaptation.fixed.resolutionScale);
  assert.equal(report.adaptation.recoveredPressure, 0, 'Rendering recovers under sustained headroom');
  assert.equal(report.adaptation.recovered.preset, 'ultra', 'The chosen target stays visible during adaptation');
  assert.ok(report.views.every(view => !view.contextLost));
  await page.evaluate(() => document.querySelector('canvas').__drive.setGraphicsQuality('low'));
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${directory}/low-chase.png` });
  assert.equal(errors.length, 0, 'All shaders and preset switches are free of browser errors');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
