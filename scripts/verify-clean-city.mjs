import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
 await page.goto('http://localhost:3000/');
 await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, { timeout: 60000 });
 await page.getByRole('button', { name: 'PLAY' }).click();
 await page.waitForTimeout(4000);
 const clearance = await page.evaluate(() => {
   const g = document.querySelector('canvas').__drive;
   g.active = false;
   const roads = Array.from({length:18}, (_,i)=>(i-8.5)*44);
   const distance = v => Math.abs(v - (Math.round((v-22)/44)*44+22));
   const blocked = [];
   // Check the full driving corridor, accounting for the car's footprint.
   for(const road of roads) for(const across of [false,true]) for(const lane of [-4.4,0,4.4]) {
     for(let along=-387;along<=387;along+=1) {
       const x=across?along:road+lane, z=across?road+lane:along;
       const hit=g.collisionWorld.query({x,z}).find(b=>Math.abs(x-b.x)<b.hx+(across?2.65:1.05) && Math.abs(z-b.z)<b.hz+(across?1.05:2.65));
       if(hit) { blocked.push({x,z,across,road,lane,hit}); break; }
     }
   }
   // Examine low static geometry in addition to colliders: inert scenery can still obstruct the view.
   g.scene.updateMatrixWorld(true);
   const stray = []; let examined=0;
   g.scene.traverse(o => {
     if(!o.isMesh || o.isInstancedMesh || o.material.transparent || o.userData.dynamic) return;
     for(let parent=o;parent;parent=parent.parent) if(parent===g.car) return;
     const p=o.geometry.attributes.position; if(!p) return;
     for(let i=0;i<p.count;i++) {
       const x=p.getX(i),y=p.getY(i),z=p.getZ(i), m=o.matrixWorld.elements;
       const wx=m[0]*x+m[4]*y+m[8]*z+m[12], wy=m[1]*x+m[5]*y+m[9]*z+m[13], wz=m[2]*x+m[6]*y+m[10]*z+m[14];
       if(wy<.3 || wy>2.3 || Math.abs(wx)>387 || Math.abs(wz)>387) continue;
       examined++;
       if(Math.min(distance(wx),distance(wz))<8.6) {
         if(stray.length<30) stray.push({name:o.name,x:wx,y:wy,z:wz,type:o.geometry.type});
       }
     }
   });
   const routes=g.coveredRoads.map(r=>({label:r.label,x:r.x,z:r.z,aligned:(r.hx>r.hz?distance(r.z):distance(r.x))===0}));
   const driving=[];
   for(const [x,z,yaw] of [[-22,330,0],[330,-22,Math.PI/2],[-330,330,0],[22,330,0]]) {
     g.reset(); g.carPosition.set(x,.015,z); g.car.position.copy(g.carPosition); g.yaw=yaw; g.pressed.add('w');
     for(let i=0;i<600;i++) g.updateDriving(1/60);
     driving.push({start:[x,z],end:g.carPosition.toArray(),speed:g.velocity.length()});
   }
   g.reset(); g.active=true; g.previousTime=0;
   return {blocked,stray,examined,routes,driving,colliders:g.colliders.length,collisionStats:g.collisionWorld.stats,nearby:g.collisionWorld.query(g.carPosition).length};
 });
 const regions=[];
 for (const [label,x,z,yaw] of [['central',-22,-22,0],['west',-330,0,0],['east',330,220,Math.PI],['north',22,-330,Math.PI]]) {
   await page.evaluate(({x,z,yaw})=>{
     const g=document.querySelector('canvas').__drive; g.reset();g.active=false;g.carPosition.set(x,.015,z);g.car.position.copy(g.carPosition);g.yaw=yaw;g.car.rotation.y=yaw;
     g.camera.position.set(x+Math.sin(yaw)*8.4,3.2,z+Math.cos(yaw)*8.4);
   },{x,z,yaw});
   await page.waitForTimeout(700);
   const result = await page.evaluate(async()=>{
     const g=document.querySelector('canvas').__drive;const frames=[],draws=[],tris=[];let last=performance.now();
     await new Promise(done=>{function tick(t){frames.push(t-last);last=t;draws.push(g.renderer.info.render.calls);tris.push(g.renderer.info.render.triangles);if(frames.length<100)requestAnimationFrame(tick);else done();}requestAnimationFrame(tick);});
     frames.sort((a,b)=>a-b);draws.sort((a,b)=>a-b);tris.sort((a,b)=>a-b);
     return {medianMs:frames[50],p95Ms:frames[95],calls:draws[50],triangles:tris[50],pixelRatio:g.renderer.getPixelRatio(),contextLost:g.renderer.getContext().isContextLost()};
   });
   regions.push({label,...result});
   await page.screenshot({path:`artifacts/clean-city-${label}.png`});
 }
 await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=true;});
 await page.keyboard.down('w');await page.keyboard.down('Shift');await page.keyboard.down('f');await page.waitForTimeout(1500);
 const weapons=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {speed:g.lastTelemetry.speed,boosting:g.lastTelemetry.boosting,firing:g.lastTelemetry.firing,bullets:g.bullets.length,smoke:g.smokeParticles.length};});
 await page.keyboard.up('f');await page.keyboard.up('Shift');await page.keyboard.up('w');
 await page.screenshot({path:'artifacts/clean-city-driving.png'});
 const report={clearance,regions,weapons,errors};
 await writeFile('artifacts/clean-city-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.equal(clearance.blocked.length,0,'Every road and driving lane clears the car footprint');
 assert.equal(clearance.stray.length,0,'No low inert geometry occupies driving lanes');
 assert.ok(clearance.routes.every(r=>r.aligned),'All tunnels and underpasses align with the street grid');
 assert.ok(clearance.driving.every(r=>r.speed>50),'Full-length road driving stays unobstructed');
 assert.ok(weapons.firing && weapons.boosting && weapons.speed>50,'Driving, boost and firing still work');
 assert.equal(errors.length,0,'No browser errors');
 assert.ok(regions.every(r=>!r.contextLost),'WebGL remains healthy across city regions');
} finally { await browser.close(); }
