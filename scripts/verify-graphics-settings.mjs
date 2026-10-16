import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
await page.addInitScript(() => localStorage.setItem('neon-nocturne.graphics.v1', JSON.stringify({ preset: 'low', automatic: false })));
const checks = {};
try {
  console.log('Opening Low-quality UI verification page');
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.getGraphicsStatus,
    null, { timeout: 90000 });
  await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    cancelAnimationFrame(game.animationFrame);
    game.setGraphicsQuality('low');
  });
  console.log('Game ready; render loop stopped');
  await page.getByRole('button', { name: /GRAPHICS/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.getByRole('radio').count(), 4);
  await dialog.getByRole('radio', { name: 'Low', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('input[value="medium"]').checked);
  checks.nativeRadioArrows = true;
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement.tagName === 'CANVAS');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'CANVAS');
  checks.titleEscapeCanvasFocus = true;
  console.log('Title radio arrows and Escape focus passed');

  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas').__drive.active);
  const view = await page.evaluate(() => document.querySelector('canvas').__drive.cameraView);
  await page.getByRole('button', { name: /GRAPHICS/ }).click();
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('canvas').__drive.active);
  await page.keyboard.press('c');
  await page.keyboard.press('p');
  await page.keyboard.press('e');
  await page.keyboard.press('w');
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.cameraView), view);
  assert.equal(await page.evaluate(() => document.querySelector('canvas').__drive.pressed.size), 0);
  checks.gameShortcutsContained = true;
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), true);
  }
  checks.nativeFocusTrap = true;
  console.log('Play shortcut isolation and Tab trapping passed');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('canvas').__drive.active && document.activeElement.tagName === 'CANVAS');
  checks.playResumesWithCanvasFocus = true;

  for (const viewport of [{ width: 320, height: 650 }, { width: 375, height: 812 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: /GRAPHICS/ }).click();
    await dialog.waitFor({ state: 'visible' });
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + .5 && bounds.y + bounds.height <= viewport.height + .5, JSON.stringify({ viewport, bounds }));
    const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false);
    checks[`responsive${viewport.width}x${viewport.height}`] = true;
    console.log(`Layout ${viewport.width}x${viewport.height} passed`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  const overloadedLevel = await page.evaluate(() => {
    const game = document.querySelector('canvas').__drive;
    game.setAutomaticGraphics(true);
    cancelAnimationFrame(game.animationFrame);
    game.elapsed = 40;
    game.qualityWarmup = 0;
    game.qualityResumeTime = 0;
    for (let sample = 0; sample < 60; sample++) {
      game.elapsed += .1;
      game.updateRenderQuality(250, .1);
    }
    return game.qualityLevel;
  });
  assert(overloadedLevel > 0, `Severe overload did not adapt: ${overloadedLevel}`);
  checks.severeOverloadAdaptation = true;
  console.log('Severe overload adaptation passed');
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser.close();
}
