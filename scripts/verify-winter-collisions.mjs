import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ ...(process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}), headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
 const page = await browser.newPage();
 await page.goto(process.env.GAME_URL || 'http://localhost:3000/');
 await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive?.snowTracks);
 const result = await page.evaluate(() => {
  const g = document.querySelector('canvas').__drive; cancelAnimationFrame(g.animationFrame);
  g.pressed.clear(); g.yaw = 0; g.vehicleMotion.yaw = 0; g.vehicleMotion.yawRate = 0; g.vehicleMotion.steeringAngle = 0;
  g.carPosition.set(-22, .015, -22); g.velocity.set(15, 0, -5);
  g.collisionWorld = new g.collisionWorld.constructor([{ x: -19, z: -23, hx: .1, hz: 4 }]);
  const initialEnergy = g.velocity.lengthSq(); g.updateDriving(.2);
  const wall = { position: g.carPosition.toArray(), velocity: g.velocity.toArray(), energy: g.velocity.lengthSq(), initialEnergy };
  g.collisionWorld = new g.collisionWorld.constructor([]);
  g.yaw = 0; g.vehicleMotion.yaw = 0; g.vehicleMotion.yawRate = 0; g.vehicleMotion.steeringAngle = 0;
  g.carPosition.set(389.98, .146, 0); g.velocity.set(10, 0, -4); g.updateDriving(.04);
  const boundary = { position: g.carPosition.toArray(), velocity: g.velocity.toArray() };
  return { wall, boundary };
 });
 assert.ok(Math.abs(result.wall.velocity[0]) < 1 && result.wall.velocity[2] < -4, 'A wall absorbs normal impact while preserving tangential momentum');
 assert.ok(result.wall.energy < result.wall.initialEnergy, 'Collision loses energy');
 assert.ok(result.wall.position[0] < -20.14, 'The swept footprint stops before the thin wall');
 assert.equal(result.boundary.position[0], 390);
 assert.ok(Math.abs(result.boundary.velocity[0]) < .5 && result.boundary.velocity[2] < -3.8, 'The city boundary absorbs outward motion without reversing sideways motion');
 await writeFile('artifacts/winter-collision-verification.json', JSON.stringify(result, null, 2));
 console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
