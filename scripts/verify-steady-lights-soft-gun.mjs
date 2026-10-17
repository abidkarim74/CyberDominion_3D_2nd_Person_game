import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto(process.env.GAME_URL||'http://localhost:3000/');await page.waitForFunction(()=>document.querySelector('canvas')?.__drive,null,{timeout:60000});await page.getByRole('button',{name:'PLAY'}).click();
 await page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive;g.reset();g.qualityTimer=-1000;g.camera.position.set(-22,3.115,-13.6);g.camera.fov=66;g.camera.updateProjectionMatrix();
  // Isolate static lighting from moving weather and aircraft for the pixel comparison.
  g.__lightVisibility=[];
  const hide=o=>{g.__lightVisibility.push([o,o.visible]);o.visible=false};
  g.scene.traverse(o=>{if(o.isPoints||o===g.rain)hide(o)});g.flying.forEach(f=>hide(f.vehicle));
 });
 await page.waitForTimeout(1400);
 const staticState=()=>page.evaluate(()=>{
  const g=document.querySelector('canvas').__drive,materials=new Map();g.scene.traverse(o=>{if(o.isMesh&&o.userData.cityBounds&&!Array.isArray(o.material)&&o.material.color)materials.set(o.material.uuid,o.material.color.toArray())});
  const lights=[];g.scene.traverse(o=>{if(o.isPointLight)lights.push([o.uuid,...o.position.toArray(),o.intensity,...o.color.toArray()])});
  return {camera:g.camera.position.toArray(),materials:Array.from(materials.entries()).sort((a,b)=>a[0].localeCompare(b[0])),lights};
 });
 const before=await staticState();const a=await page.screenshot({path:'artifacts/steady-distant-lights-a.png',clip:{x:0,y:0,width:1200,height:340}});
 await page.waitForTimeout(1000);
 const after=await staticState();const b=await page.screenshot({path:'artifacts/steady-distant-lights-b.png',clip:{x:0,y:0,width:1200,height:340}});
 const lighting={maximumCameraMotion:Math.max(...before.camera.map((v,i)=>Math.abs(v-after.camera[i]))),materialsSteady:JSON.stringify(before.materials)===JSON.stringify(after.materials),lightsSteady:JSON.stringify(before.lights)===JSON.stringify(after.lights),backdropPixelsSteady:a.equals(b)};
 assert.ok(lighting.maximumCameraMotion<1e-8,'Parked camera stays stationary');assert.ok(lighting.materialsSteady&&lighting.lightsSteady,'Static signs and light sources do not pulse');assert.ok(lighting.backdropPixelsSteady,'Distant static lights remain pixel-stable while parked');
 await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;for(const [o,visible]of g.__lightVisibility)o.visible=visible;delete g.__lightVisibility});
 await page.keyboard.down('f');await page.waitForTimeout(850);
 const audio=await page.evaluate(async()=>{
  const game=document.querySelector('canvas').__drive,a=game.audio,ctx=a.context,bus=a.gunTone||a.gunMaster,analyser=ctx.createAnalyser();analyser.fftSize=4096;bus.connect(analyser);
  const samples=new Float32Array(4096),freq=new Float32Array(2048);let energy=0,peak=0,treble=0,total=0;
  for(let i=0;i<25;i++){analyser.getFloatTimeDomainData(samples);analyser.getFloatFrequencyData(freq);for(const v of samples){energy+=v*v;peak=Math.max(peak,Math.abs(v))}for(let j=0;j<freq.length;j++){const power=Math.pow(10,freq[j]/10);total+=power;if(j*ctx.sampleRate/analyser.fftSize>2500)treble+=power}await new Promise(r=>setTimeout(r,20))}
  bus.disconnect(analyser);return {rms:Math.sqrt(energy/(25*4096)),peak,highFrequencyShare:treble/total,...game.audioDiagnostics().gun,firing:game.lastTelemetry.firing,bullets:game.bullets.length};
 });
 await page.keyboard.up('f');await page.waitForTimeout(700);
 const stopped=await page.evaluate(()=>{const g=document.querySelector('canvas').__drive;return {active:g.audioDiagnostics().gun.active,rattleGain:g.audio.minigunGain.gain.value,spinGain:g.audio.minigunSpinGain.gain.value}});
 const baseline=JSON.parse(await readFile('artifacts/minigun-before.json','utf8'));
 const sound={...audio,rmsReductionDb:20*Math.log10(baseline.rms/audio.rms),trebleReduction:1-audio.highFrequencyShare/baseline.highFrequencyShare,stopped};
 assert.ok(audio.firing&&audio.bullets>0,'Minigun sound accompanies firing');assert.ok(audio.rms>.0003,'Gun remains audible');assert.ok(audio.rms<baseline.rms*.6,'Gun volume is substantially softer');assert.ok(audio.highFrequencyShare<baseline.highFrequencyShare*.4,'Piercing high frequencies are reduced');assert.ok(!stopped.active&&stopped.rattleGain<.02,'Gun audio fades out after trigger release');assert.equal(errors.length,0,'No runtime or audio errors');
 const report={lighting,sound,errors};await writeFile('artifacts/steady-lights-soft-gun-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await page.screenshot({path:'artifacts/solid-city-gameplay.png'});
}finally{await browser.close()}
