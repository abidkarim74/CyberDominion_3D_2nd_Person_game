import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
 await page.goto(process.env.GAME_URL||'http://localhost:3000/');
 await page.waitForFunction(()=>!!document.querySelector('canvas')?.__drive,null,{timeout:60000});
 await page.evaluate(()=>{document.querySelector('canvas').__drive.qualityWarmup=Infinity;});
 await page.getByRole('button',{name:'PLAY',exact:true}).click();await page.waitForTimeout(2500);
 await page.getByRole('button',{name:'Switch to driver view'}).click();await page.waitForTimeout(500);
 const steeringPixels=await page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive,wheel=g.carRig.cockpit.steeringWheel;
  cancelAnimationFrame(g.animationFrame);
  const mirror=g.reflections.mirror,mirrorWasVisible=mirror.visible;mirror.visible=false;
  const canvas=document.createElement('canvas');canvas.width=g.renderer.domElement.width;canvas.height=g.renderer.domElement.height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  function pixels(){g.composer.render();context.drawImage(g.renderer.domElement,0,0);return context.getImageData(0,0,canvas.width,canvas.height).data}
  const withWheel=pixels();wheel.visible=false;const withoutWheel=pixels();wheel.visible=true;mirror.visible=mirrorWasVisible;
  let count=0;for(let i=Math.floor(canvas.height/2)*canvas.width*4;i<withWheel.length;i+=4)if(Math.max(Math.abs(withWheel[i]-withoutWheel[i]),Math.abs(withWheel[i+1]-withoutWheel[i+1]),Math.abs(withWheel[i+2]-withoutWheel[i+2]))>3)count++;
  g.previousTime=0;g.animationFrame=requestAnimationFrame(g.frameHandler);return count;
 });
 assert.ok(steeringPixels>500,'The detailed steering wheel is visibly rendered inside the cabin');
 await page.screenshot({path:'artifacts/driver-view-parked.png'});
 const parked=await page.evaluate(async()=>{
  const g=document.querySelector('canvas').__drive,c=g.carRig.cockpit;
  const wheelBounds=[];c.steeringWheel.traverse(o=>{if(o.isMesh){o.geometry.computeBoundingBox();wheelBounds.push({min:o.geometry.boundingBox.min.toArray(),max:o.geometry.boundingBox.max.toArray()});}});
  const before=g.camera.position.toArray(),orientation=g.camera.quaternion.toArray(),texture=c.dashboardMap.version;
  await new Promise(resolve=>setTimeout(resolve,1000));
  return {wheelBounds,view:g.cameraView,near:g.camera.near,eyeOffset:g.camera.position.clone().sub(g.carPosition).toArray(),maximumCameraMotion:Math.max(...before.map((v,i)=>Math.abs(v-g.camera.position.getComponent(i)))),orientationSteady:orientation.every((v,i)=>v===g.camera.quaternion.toArray()[i]),idleTextureUpdates:c.dashboardMap.version-texture,readout:c.readout,passes:g.composer.passes.length};
 });
 assert.ok(parked.wheelBounds.every(b=>b.min.every(v=>v>-.25)&&b.max.every(v=>v<.25)),'Batched wheel keeps its vertices local to the steering assembly');
 assert.equal(parked.view,'driver');assert.equal(parked.near,.025);
 assert.ok(parked.maximumCameraMotion<1e-8&&parked.orientationSteady,'Driver camera is steady while parked');
 assert.equal(parked.idleTextureUpdates,0,'Unchanged dashboard avoids texture uploads');
 assert.equal(parked.passes,3,'Driver view reuses the existing scene, bloom and output pipeline');
 await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',repeat:true})));
 assert.equal(await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView),'driver','Holding C does not repeatedly switch views');
 const versionBeforeDriving=await page.evaluate(()=>document.querySelector('canvas').__drive.carRig.cockpit.dashboardMap.version),drivingStarted=Date.now();
 await page.keyboard.down('w');await page.keyboard.down('Shift');await page.keyboard.down('f');
 await page.waitForFunction(()=>{const g=document.querySelector('canvas').__drive;return g.lastTelemetry.speed>35&&g.lastTelemetry.firing&&g.lastTelemetry.boosting},{},{timeout:15000});
 await page.keyboard.down('a');
 await page.waitForFunction(()=>Math.abs(document.querySelector('canvas').__drive.carRig.cockpit.steeringWheel.rotation.z)>.7,{},{timeout:10000});
 await page.waitForFunction(()=>{const r=document.querySelector('canvas').__drive.carRig.cockpit.readout;return r.speed>0&&r.boost<100&&r.firing},{},{timeout:10000});
 const driving=await page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive;return {telemetry:g.lastTelemetry,steering:g.carRig.cockpit.steeringWheel.rotation.z,readout:g.carRig.cockpit.readout,textureVersion:g.carRig.cockpit.dashboardMap.version,seatDistance:g.camera.position.distanceTo(g.carPosition),contextLost:g.renderer.getContext().isContextLost()};
 });
 await page.screenshot({path:'artifacts/driver-view-driving.png'});
 assert.ok(Math.abs(driving.steering)>.7,'Wheel turns with steering input');
 assert.ok(driving.telemetry.speed>35&&driving.telemetry.firing&&driving.telemetry.boosting,'Driving, firing and boost work in driver view');
 assert.ok(driving.readout.speed>0&&driving.readout.boost<100&&driving.readout.firing,'Instrument display shows live driving state');
 driving.textureUpdates=driving.textureVersion-versionBeforeDriving;driving.observedSeconds=(Date.now()-drivingStarted)/1000;
 assert.ok(driving.textureUpdates<=Math.ceil(driving.observedSeconds*10)+2,'Live instruments update at no more than ten uploads per second');
 assert.ok(driving.seatDistance<1.3,'Camera remains at the driver seat while turning');
 for(const key of ['a','w','Shift','f'])await page.keyboard.up(key);
 await page.keyboard.press('r');await page.waitForTimeout(180);
 const reset=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {view:g.cameraView,readout:g.carRig.cockpit.readout,steering:g.carRig.cockpit.steeringWheel.rotation.z}});
 assert.equal(reset.view,'driver','Reset preserves the selected camera');assert.equal(reset.readout.speed,0);assert.equal(reset.steering,0);
 await page.keyboard.press('c');await page.getByRole('button',{name:'Switch to driver view'}).waitFor();
 const chase=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {view:g.cameraView,distance:g.camera.position.distanceTo(g.carPosition),near:g.camera.near}});
 assert.equal(chase.view,'chase');assert.ok(chase.distance>8);assert.equal(chase.near,.1);
 const resources=await page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive;const wheel=g.carRig.cockpit.steeringWheel,map=g.carRig.cockpit.dashboardMap;
  const before={...g.renderer.info.memory};for(let i=0;i<12;i++)g.toggleCameraView();
  return {before,after:{...g.renderer.info.memory},stable:wheel===g.carRig.cockpit.steeringWheel&&map===g.carRig.cockpit.dashboardMap};
 });assert.ok(resources.stable);assert.deepEqual(resources.before,resources.after,'Switching cameras allocates no new GPU resources');
 const regions=[];
 for(const [label,x,z,yaw]of [['central',-22,-22,0],['north',22,-330,Math.PI]]){
  await page.evaluate(({x,z,yaw})=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=false;g.qualityLevel=4;g.resize();g.carPosition.set(x,.015,z);g.car.position.copy(g.carPosition);g.yaw=yaw;g.car.rotation.y=yaw;g.updateCamera(0,true);},{x,z,yaw});
  const views={};
  for(const view of ['chase','driver']){
   await page.evaluate(view=>{const g=document.querySelector('canvas').__drive;if(g.cameraView!==view)g.toggleCameraView();g.updateCamera(0,true);},view);
   await page.waitForTimeout(450);
   views[view]=await page.evaluate(async()=>{
    const g=document.querySelector('canvas').__drive,frames=[],draws=[];let last=performance.now();
    await new Promise(resolve=>{function sample(now){frames.push(now-last);draws.push(g.renderer.info.render.calls);last=now;if(frames.length<100)requestAnimationFrame(sample);else resolve()}requestAnimationFrame(sample)});
    frames.sort((a,b)=>a-b);draws.sort((a,b)=>a-b);
    return {medianMs:frames[50],p95Ms:frames[95],draws:draws[50],pixelRatio:g.renderer.getPixelRatio(),contextLost:g.renderer.getContext().isContextLost()};
   });
  }
  regions.push({label,views});
  console.log('Camera frame budget:',JSON.stringify({label,views}));
  assert.equal(views.driver.pixelRatio,views.chase.pixelRatio,'Views use the same render resolution');
  assert.ok(views.driver.medianMs<=views.chase.medianMs+6,'Cockpit view stays within the existing frame budget');
 }
 await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=true;g.qualityTimer=0;});
 await page.screenshot({path:'artifacts/driver-view-final.png'});
 await page.setViewportSize({width:1000,height:700});await page.waitForTimeout(500);
 await page.screenshot({path:'artifacts/driver-view-compact.png'});
 assert.equal(await page.evaluate(()=>document.querySelector('canvas').__drive.camera.aspect),1000/700,'Driver view resizes correctly');
 const report={steeringPixels,parked,driving,reset,chase,resources,regions,errors};
 await writeFile('artifacts/driver-view-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.equal(errors.length,0,'No runtime or shader errors');assert.equal(driving.contextLost,false);assert.ok(regions.every(r=>!r.views.driver.contextLost));
}finally{await browser.close()}
