import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3001/');
  await page.waitForFunction(() => !!document.querySelector('canvas')?.__drive);
  console.log(await page.evaluate(async () => {
    const g = document.querySelector('canvas').__drive;
    const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const output = { gpu: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
    async function measure(){
      const a=[];let last=performance.now(); await new Promise(done => {function tick(t){a.push(t-last);last=t;if(a.length<65)requestAnimationFrame(tick);else done();}requestAnimationFrame(tick);});
      a.sort((a,b)=>a-b);return {ms:a[32],calls:g.renderer.info.render.calls,triangles:g.renderer.info.render.triangles};
    }
    output.full = await measure();
    g.composer.passes[1].enabled=false;output.noBloom=await measure();g.composer.passes[1].enabled=true;
    g.renderer.setPixelRatio(.75);g.resize();output.lowerResolution=await measure();
    return output;
  }));
} finally { await browser.close(); }
