import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('artifacts',{recursive:true});
const baseline=process.env.CAR_BASELINE==='1', phase=process.env.CAR_PHASE || (baseline?'before':'after');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},hasTouch:true}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto(process.env.GAME_URL||'http://localhost:3000/');await page.waitForFunction(()=>document.querySelector('canvas')?.__drive,null,{timeout:60000});
 await page.getByRole('button',{name:'PLAY',exact:true}).click();await page.waitForTimeout(baseline?3500:12000);
 const model=await page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive;g.active=false;g.qualityTimer=-1000;g.carRig.body.position.y=0;g.carRig.body.rotation.set(0,0,0);g.car.updateWorldMatrix(true,true);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let triangles=0,meshes=0;
  const p=g.camera.position.clone();
  g.car.traverse(o=>{if(!o.isMesh||!o.visible)return;for(let parent=o.parent;parent;parent=parent.parent)if(!parent.visible)return;meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;
   if(Array.isArray(o.material)||o.material.transparent)return;
   const position=o.geometry.attributes.position;
   for(let i=0;i<position.count;i++){p.fromBufferAttribute(position,i);o.localToWorld(p);p.sub(g.carPosition);for(let j=0;j<3;j++){min[j]=Math.min(min[j],p.getComponent(j));max[j]=Math.max(max[j],p.getComponent(j))}}
  });return{min,max,width:max[0]-min[0],length:max[2]-min[2],height:max[1],triangles,meshes,passes:g.composer.passes.length};
 });
 const performance=[];
 for(const view of ['chase','driver']){
  await page.evaluate(view=>{const g=document.querySelector('canvas').__drive;if(g.cameraView!==view)g.toggleCameraView();},view);await page.waitForTimeout(400);
  performance.push(await page.evaluate(async()=>{const g=document.querySelector('canvas').__drive,frames=[],draws=[],triangles=[];let last=performance.now();await new Promise(resolve=>{function sample(now){frames.push(now-last);draws.push(g.renderer.info.render.calls);triangles.push(g.renderer.info.render.triangles);last=now;if(frames.length<100)requestAnimationFrame(sample);else resolve()}requestAnimationFrame(sample)});frames.sort((a,b)=>a-b);draws.sort((a,b)=>a-b);triangles.sort((a,b)=>a-b);return{view:g.cameraView,medianMs:frames[50],p95Ms:frames[95],draws:draws[50],triangles:triangles[50],pixelRatio:g.renderer.getPixelRatio(),qualityLevel:g.qualityLevel,contextLost:g.renderer.getContext().isContextLost()}}));
 }
 await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=true;g.qualityTimer=0;if(g.cameraView==='driver')g.toggleCameraView();});
 const inspectButton=page.getByRole('button',{name:'Inspect car from all sides',exact:true});
 let inspection=null;
 if(!baseline && await inspectButton.count()){
   await inspectButton.click();await page.waitForTimeout(900);
   const before=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return{view:g.cameraView,camera:g.camera.position.toArray(),position:g.carPosition.toArray(),distance:g.camera.position.distanceTo(g.carPosition)}});
   await page.mouse.move(720,440);await page.mouse.down();await page.mouse.move(1030,475,{steps:18});await page.mouse.up();await page.waitForTimeout(500);
   const dragged=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return{view:g.cameraView,camera:g.camera.position.toArray(),position:g.carPosition.toArray(),distance:g.camera.position.distanceTo(g.carPosition)}});
   await page.mouse.wheel(0,350);await page.waitForTimeout(500);
   const zoomed=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return{view:g.cameraView,camera:g.camera.position.toArray(),position:g.carPosition.toArray(),distance:g.camera.position.distanceTo(g.carPosition)}});
   const touchSession=await page.context().newCDPSession(page);
   await touchSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:610,y:440},{x:790,y:440}]});
   await touchSession.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:550,y:440},{x:850,y:440}]});
   await touchSession.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touchSession.detach();await page.waitForTimeout(300);
   const pinched=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return{view:g.cameraView,camera:g.camera.position.toArray(),distance:g.camera.position.distanceTo(g.carPosition)}});
   const orbitPerformance=await page.evaluate(async()=>{const g=document.querySelector('canvas').__drive,frames=[],calls=[],triangles=[];let last=performance.now();await new Promise(resolve=>{function tick(now){frames.push(now-last);last=now;calls.push(g.renderer.info.render.calls);triangles.push(g.renderer.info.render.triangles);if(frames.length<90)requestAnimationFrame(tick);else resolve()}requestAnimationFrame(tick)});frames.sort((a,b)=>a-b);calls.sort((a,b)=>a-b);triangles.sort((a,b)=>a-b);return{medianMs:frames[45],p95Ms:frames[85],calls:calls[45],triangles:triangles[45],qualityLevel:g.qualityLevel,pixelRatio:g.renderer.getPixelRatio(),contextLost:g.renderer.getContext().isContextLost()}});
   await page.screenshot({path:`artifacts/cyber-car-${phase}-inspection.png`});
   await page.keyboard.down('ArrowLeft');await page.keyboard.down('+');await page.waitForTimeout(350);await page.keyboard.up('+');await page.keyboard.up('ArrowLeft');await page.waitForTimeout(100);
   const keyboard=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return{view:g.cameraView,camera:g.camera.position.toArray(),distance:g.camera.position.distanceTo(g.carPosition)}});
   await page.getByRole('button',{name:'Return to driving camera',exact:true}).click();
   const returned=await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView);
   await page.keyboard.press('o');await page.waitForTimeout(200);
   const shortcut=await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView);
   await page.keyboard.press('c');
   const exitedWithC=await page.evaluate(()=>document.querySelector('canvas').__drive.cameraView);
   const cameraClearance=[];
   for(const [label,x,z,elevation,distance]of [['central-roof',-22,-22,1.38,8],['tunnel-roof',-22,88,1.3,12]]){
     await page.evaluate(({x,z,elevation,distance})=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=false;g.carPosition.set(x,.015,z);g.car.position.copy(g.carPosition);if(g.cameraView!=='orbit')g.toggleOrbitView();g.orbitElevation=elevation;g.orbitDistance=distance;g.orbitAzimuth=.4;g.updateCamera(0,true)},{x,z,elevation,distance});
     await page.waitForTimeout(350);
     cameraClearance.push(await page.evaluate(label=>{const g=document.querySelector('canvas').__drive,p=g.camera.position;const inside=g.cameraCollisionWorld?.query(p).filter(s=>Math.abs(p.x-s.x)<s.hx-.001&&Math.abs(p.z-s.z)<s.hz-.001&&p.y>(s.minY??0)+.001&&p.y<(s.maxY??Infinity)-.001).map(s=>({label:s.label,x:s.x,z:s.z,minY:s.minY,maxY:s.maxY}))??[];return{label,camera:p.toArray(),target:g.cameraTarget.toArray(),inside}},label));
     await page.screenshot({path:`artifacts/cyber-car-${phase}-${label}.png`});
   }
   inspection={before,dragged,zoomed,pinched,keyboard,returned,shortcut,exitedWithC,orbitPerformance,cameraClearance};
 }
 await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;g.reset();g.active=false;});
 await page.addStyleTag({content:'.drive-hud,.city-minimap,.camera-toggle,.car-inspect-help,.city-ident{display:none !important}'});
 for(const [label,x,y,z]of [['front-three-quarter',4.5,2.3,-6.8],['rear-three-quarter',-4.6,2.0,6.9],['left-side',-7.2,1.8,.4],['right-side',7.2,1.8,.4],['front',0,1.3,-8],['rear',0,1.6,8],['overhead',.3,8,.7]]){
  await page.evaluate(({x,y,z})=>{const g=document.querySelector('canvas').__drive;cancelAnimationFrame(g.animationFrame);g.camera.position.copy(g.carPosition).add({x,y,z});g.camera.fov=45;g.camera.near=.1;g.camera.updateProjectionMatrix();g.camera.lookAt(g.carPosition.clone().add({x:0,y:.65,z:0}));g.renderer.shadowMap.needsUpdate=true;for(let frame=0;frame<6;frame++)g.composer.render();},{x,y,z});
  await page.screenshot({path:`artifacts/cyber-car-${phase}-${label}.png`});
 }
 const report={model,performance,inspection,errors};
 await writeFile(`artifacts/cyber-car-${phase}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.equal(errors.length,0);assert.ok(performance.every(p=>!p.contextLost));
 if(!baseline){
  assert.ok(model.width<=2.14&&model.length<=5.4&&model.height<=1.5,'Full coupe body and wing fit the driving footprint and remain below the 1.6 m car collision clearance');
  assert.ok(model.triangles<=30000,'Detailed car keeps a bounded triangle budget');
  assert.ok(model.meshes<=110,'Car assembly keeps a bounded draw budget');
  assert.equal(model.passes,4,'Redesign adds no render passes');
  assert.ok(inspection,'Car inspection control is present');
  assert.equal(inspection.before.view,'orbit','Inspect control enters orbit mode');
  assert.ok(Math.hypot(...inspection.dragged.camera.map((v,i)=>v-inspection.before.camera[i]))>.5,'Dragging turns the camera around the car');
  assert.ok(Math.abs(inspection.zoomed.distance-inspection.dragged.distance)>.1,'Wheel changes inspection distance');
  assert.ok(Math.abs(inspection.pinched.distance-inspection.zoomed.distance)>.1,'Two-finger pinch changes inspection distance');
  assert.ok(Math.hypot(inspection.dragged.position[0]-inspection.before.position[0],inspection.dragged.position[2]-inspection.before.position[2])<.001&&Math.abs(inspection.dragged.position[1]-inspection.before.position[1])<.02,'Inspection keeps the car parked while permitting small suspension movement');
  assert.ok(Math.hypot(...inspection.keyboard.camera.map((v,i)=>v-inspection.pinched.camera[i]))>.05,'Keyboard orbit and zoom controls change the camera');
  assert.equal(inspection.returned,'chase','Inspect exit restores driving camera');
  assert.equal(inspection.shortcut,'orbit','O enters orbit inspection');
  assert.equal(inspection.exitedWithC,'chase','C exits orbit to the chase camera');
  assert.equal(inspection.orbitPerformance.contextLost,false,'Orbit retains a healthy WebGL context');
  assert.ok(inspection.cameraClearance.every(r=>r.inside.length===0),'High orbit angles stay outside roof and wall colliders');
 }
}finally{await browser.close()}
