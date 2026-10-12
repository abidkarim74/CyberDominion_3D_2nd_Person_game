import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = {};
await mkdir('artifacts', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  console.log('Loading city');
  await page.goto('http://localhost:3000/', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive && !document.querySelector('canvas').__drive.destroyed, null, { timeout: 90000 });
  await page.getByRole('button', { name: 'PLAY', exact: true }).click();
  await page.waitForTimeout(8000);
  console.log('City loaded');
  report.ready = await page.evaluate(() => {
    const g = document.querySelector('canvas').__drive;
    return { elapsed: g.elapsed, destroyed: g.destroyed, quality: g.qualityLevel, gpu: g.renderer.getContext().getParameter(g.renderer.getContext().getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  assert.equal(report.ready.destroyed, false);
  const measure = () => page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const startElapsed = g.elapsed;
    const intervals = [], calls = [], triangles = [];
    let last;
    await new Promise(resolve => {
      function sample(t) {
        if (last !== undefined) { intervals.push(t - last); calls.push(g.renderer.info.render.calls); triangles.push(g.renderer.info.render.triangles); }
        last = t;
        if (intervals.length < 120) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    const summary = values => { values.sort((a,b) => a-b); return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length*.95)], mean: values.reduce((a,b) => a+b,0)/values.length }; };
    return { framesMs: summary(intervals), calls: summary(calls), triangles: summary(triangles), quality: g.qualityLevel, pixelRatio: g.renderer.getPixelRatio(), elapsedDelta: g.elapsed-startElapsed, destroyed: g.destroyed, contextLost: g.renderer.getContext().isContextLost() };
  });
  report.regions = [];
  for (const [name,x,z,yaw] of [['central',-22,-22,0],['market',22,66,Math.PI/2],['north',22,-330,Math.PI],['east',330,220,Math.PI]]) {
    await page.evaluate(({x,z,yaw}) => {
      const g=document.querySelector('canvas').__drive; g.reset();g.active=false;
      g.carPosition.set(x,.015,z);g.car.position.copy(g.carPosition);g.yaw=yaw;g.car.rotation.y=yaw;g.updateCamera(0,true);
    },{x,z,yaw});
    await page.waitForTimeout(1300);
    console.log('Measuring '+name);
    report.regions.push({name,...await measure()});
    await page.screenshot({path:`artifacts/night-city-${name}.png`});
  }
  await page.evaluate(() => {
    const g=document.querySelector('canvas').__drive;g.reset();g.active=false;g.qualityWarmup=1e9;
    g.qualityLevel=0;g.reflections.setQuality(0);g.renderer.shadowMap.enabled=true;g.renderer.shadowMap.needsUpdate=true;g.resize();
    g.carPosition.set(-22,.015,-22);g.updateCityVisibility(g.carPosition,0);g.updateCamera(0,true);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({path:'artifacts/night-city-final-central.png'});
  await page.evaluate(() => {
    const g=document.querySelector('canvas').__drive;
    g.qualityWarmup=1e9;g.camera.position.set(-120,155,245);g.camera.lookAt(20,90,-75);g.camera.far=6000;g.camera.updateProjectionMatrix();
    g.updateCamera=()=>{};
  });
  await page.waitForTimeout(1000);
  await page.screenshot({path:'artifacts/night-city-skyline.png'});
  await page.screenshot({path:'artifacts/night-city-final-skyline.png'});
  console.log('Skyline captured');
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive, null, {timeout:90000});
  await page.getByRole('button',{name:'PLAY',exact:true}).click();
  await page.waitForTimeout(5000);
  await page.keyboard.down('w');await page.keyboard.down('Shift');await page.keyboard.down('f');
  await page.waitForTimeout(1800);
  report.driving=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {...g.lastTelemetry,position:g.carPosition.toArray(),bullets:g.bullets.length};});
  report.driving.performance=await measure();
  await page.keyboard.up('f');await page.keyboard.up('Shift');await page.keyboard.up('w');
  await page.screenshot({path:'artifacts/night-city-driving.png'});
  await page.keyboard.press('r');await page.keyboard.press('c');
  await page.waitForTimeout(600);
  report.camera=await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView);
  await page.screenshot({path:'artifacts/night-city-driver.png'});
  report.clearance=await page.evaluate(()=>{
    const g=document.querySelector('canvas').__drive,blocked=[];
    for (let road=-374;road<=374;road+=44)for(const across of [true,false])for(const lane of [-4.4,0,4.4])for(let along=-387;along<=387;along++){
      const x=across?along:road+lane,z=across?road+lane:along;
      const hit=g.collisionWorld.query({x,z}).find(b=>Math.abs(x-b.x)<b.hx+(across?2.65:1.05)&&Math.abs(z-b.z)<b.hz+(across?1.05:2.65));
      if(hit){blocked.push({x,z,hit:hit.label});break;}
    }
    return {blocked,colliders:g.colliders.length};
  });
  await page.setViewportSize({width:390,height:844});
  await page.reload();await page.waitForFunction(()=>!!document.querySelector('canvas')?.__drive,null,{timeout:90000});
  report.mobile=await page.evaluate(()=>({width:innerWidth,contentWidth:document.documentElement.scrollWidth,contextLost:document.querySelector('canvas').__drive.renderer.getContext().isContextLost()}));
  await page.getByRole('button',{name:'PLAY',exact:true}).click();
  await page.getByRole('button',{name:'Switch to driver view',exact:true}).click();
  report.mobile.camera=await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView);
  await page.screenshot({path:'artifacts/night-city-mobile.png'});
  report.errors=errors;
  await writeFile('artifacts/night-city-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  assert.equal(errors.length,0,'No browser or shader errors');
  assert.ok(report.regions.every(r=>!r.destroyed&&!r.contextLost&&r.elapsedDelta>1),'Measurements use the running game');
  assert.equal(report.clearance.blocked.length,0,'Road lanes stay clear');
  assert.ok(report.driving.speed>30&&report.driving.boosting&&report.driving.firing,'Driving, boost and firing work');
  assert.equal(report.camera,'driver');
  assert.ok(report.mobile.contentWidth<=report.mobile.width&&!report.mobile.contextLost&&report.mobile.camera==='driver');
} finally { await browser.close(); }
