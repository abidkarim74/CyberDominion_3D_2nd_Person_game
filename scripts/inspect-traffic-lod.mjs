import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts/traffic-lod', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => document.querySelector('canvas')?.__drive?.traffic, null, { timeout: 90000 });
  await page.addStyleTag({ content: 'body>*{visibility:hidden} canvas{visibility:visible!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important}' });
  const data = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const g = document.querySelector('canvas').__drive;
    cancelAnimationFrame(g.animationFrame); g.active = false;
    const car = g.traffic.cars[1];
    const meshes = [];
    car.rig.car.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const m = o.material;
      meshes.push({name:o.name,material:m.name,transparent:m.transparent,alphaTest:m.alphaTest,alphaMap:!!m.alphaMap,map:!!m.map,
        bounds:[o.geometry.boundingBox.min.toArray(),o.geometry.boundingBox.max.toArray()],triangles:(o.geometry.index?.count??o.geometry.getAttribute('position').count)/3});
    });
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8a9bab); scene.environment = g.scene.environment;
    scene.add(new THREE.HemisphereLight(0xffffff,0x6b7480,2));
    const sun = new THREE.DirectionalLight(0xffffff,3); sun.position.set(4,8,-5); scene.add(sun);
    scene.add(car.rig.car); car.rig.car.position.set(0,0,0); car.rig.car.rotation.set(0,0,0);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x999999,roughness:.8}));
    ground.rotation.x=-Math.PI/2; ground.position.y=-.04; scene.add(ground);
    const camera = new THREE.PerspectiveCamera(40,1280/800,.1,250);
    camera.position.set(-5,3.5,-6); camera.lookAt(0,.6,0);
    g.renderer.setPixelRatio(1); g.renderer.setSize(1280,800,false); g.renderer.shadowMap.enabled=false;
    window.__lodDebug={g,car,scene,camera};
    return meshes;
  });
  for (const mode of ['near','far','far-top','far-rear','far-distance','near-distance','near-top']) {
    await page.evaluate(mode => {
      const {g,car,scene,camera}=window.__lodDebug;
      car.rig.lod.update(mode.startsWith('near')?0:10000,false,0,0,false,false);
      if(mode==='far-top')camera.position.set(0,8,.1);
      if(mode==='far-rear')camera.position.set(-5,3.5,6);
      if(mode==='far-distance')camera.position.set(-28,15,35);
      if(mode==='near-top')camera.position.set(0,8,.1);
      camera.lookAt(0,.6,0); g.renderer.render(scene,camera);
    },mode);
    await page.locator('canvas').screenshot({path:`artifacts/traffic-lod/${process.argv[2]||'before'}-${mode}.png`});
  }
  const checks = await page.evaluate(() => {
    const {car}=window.__lodDebug;
    const root=car.rig.lod.root;
    const glass=root.getObjectByName('Traffic / distant glass');
    const triangles=root.children.reduce((sum,o)=>sum+o.geometry.index.count/3,0);
    const contact=car.rig.car.getObjectByName('Car / soft contact shadow');
    const shader={fragmentShader:'#include <alphamap_fragment>'};
    contact.material.onBeforeCompile(shader);
    return {draws:root.children.length,triangles,transparentGlass:glass.material.transparent,glassDepthWrite:glass.material.depthWrite,
      analyticContact:shader.fragmentShader.includes('smoothstep(.08, .5, contactRadius)'),
      contactSamplesAlpha:shader.fragmentShader.includes('texture2D'),
      finiteNormals:root.children.every(o=>Array.from(o.geometry.getAttribute('normal').array).every(Number.isFinite))};
  });
  assert.equal(checks.transparentGlass,true);
  assert.equal(checks.glassDepthWrite,false);
  assert.equal(checks.analyticContact,true);
  assert.equal(checks.contactSamplesAlpha,false);
  assert.equal(checks.finiteNormals,true);
  assert.ok(checks.draws<=6);
  assert.deepEqual(errors,[]);
  await writeFile(`artifacts/traffic-lod/${process.argv[2]||'before'}-meshes.json`,JSON.stringify({meshes:data,errors},null,2));
  console.log(JSON.stringify({meshes:data.length,checks,errors}));
} finally { await browser.close(); }
