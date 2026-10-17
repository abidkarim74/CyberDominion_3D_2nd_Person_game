import * as THREE from 'three';
import { isCitySquare } from './city-layout';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { GraphicsQuality } from './graphics-quality';

export function makeSpeedPass() {
  return new ShaderPass({
    uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
      void main(){vec2 p=vUv-vec2(.5,.48); float edge=smoothstep(.23,.7,length(p));
      vec2 offset=p*strength*edge;
      vec3 c=texture2D(tDiffuse,vUv).rgb*.5;
      c+=texture2D(tDiffuse,vUv-offset).rgb*.3;
      c+=texture2D(tDiffuse,vUv-offset*2.).rgb*.2;
      gl_FragColor=vec4(c,1.);}`,
  });
}

/** A fixed-size GPU-updated steam field; no transparent billboard sorting or lights. */
export function addSteam(scene: THREE.Scene) {
  const positions: number[] = []; const phases: number[] = [];
  for (let x = -154; x <= 154; x += 44) for (let z = -154; z <= 154; z += 44) {
    if (isCitySquare(x + 12.1, z - 5)) continue;
    for (let i = 0; i < 3; i++) {
      positions.push(x + 12.1, .5, z - 5); phases.push((i / 3 + (x + z + 308) / 700) % 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new THREE.Float32BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { time: { value: 0 }, resolution: { value: 900 }, detail: { value: .8 },
      reach: { value: 140 }, pointLimit: { value: 180 }, opacity: { value: .095 } },
    vertexShader: `attribute float phase; uniform float time; uniform float resolution;
      uniform float detail; uniform float reach; uniform float pointLimit;
      varying float life; varying float distanceFade; varying float warmth;
      void main(){life=fract(phase+time*.13); vec3 p=position;
      p.y+=life*(3.6+detail*1.8);p.x+=sin(life*4.+phase*6.)*life*(.6+detail*.2);p.z+=life*.6;
      warmth=.5+.5*sin(phase*19.+position.x*.03);
      vec4 v=modelViewMatrix*vec4(p,1.); distanceFade=1.-smoothstep(reach*.38,reach,-v.z);
      gl_Position=projectionMatrix*v;gl_PointSize=min(pointLimit,resolution*(.65+life*2.8)/max(1.,-v.z));}`,
    fragmentShader: `uniform float detail; uniform float opacity;
      varying float life; varying float distanceFade; varying float warmth;
      void main(){vec2 p=gl_PointCoord-.5;
      // Curved, thinning wisps use the original fixed particle pool and one exponential.
      p.x+=(p.y*p.y-.08)*(.65+life)*detail;
      p.x*=1.13-life*.2;p.y*=.84;
      float a=exp(-dot(p,p)*15.)*(1.-smoothstep(.3,.5,length(p)));
      a*=sin(life*3.14159)*opacity*distanceFade;
      vec3 tint=mix(vec3(.25,.38,.47),vec3(.42,.38,.32),warmth*detail*.45);
      gl_FragColor=vec4(tint,a);}`,
  });
  const steam = new THREE.Points(geometry, material);
  steam.name = 'City / softly lit street steam';
  steam.frustumCulled = false; scene.add(steam);
  return {
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = Number.isFinite(pressure) ? THREE.MathUtils.clamp(pressure, 0, 4) : 0;
      material.uniforms.detail.value = { low: .2, medium: .5, high: .82, ultra: 1 }[preset];
      material.uniforms.reach.value = { low: 95, medium: 120, high: 140, ultra: 155 }[preset] / (1 + load * .07);
      material.uniforms.pointLimit.value = { low: 140, medium: 165, high: 180, ultra: 180 }[preset] / (1 + load * .06);
      material.uniforms.opacity.value = { low: .085, medium: .09, high: .095, ultra: .1 }[preset];
    },
    update(time: number, height: number) { material.uniforms.time.value = time; material.uniforms.resolution.value = height; },
  };
}
