import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

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
    for (let i = 0; i < 3; i++) {
      positions.push(x + 12.1, .5, z - 5); phases.push((i / 3 + (x + z + 308) / 700) % 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new THREE.Float32BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { time: { value: 0 }, resolution: { value: 900 } },
    vertexShader: `attribute float phase; uniform float time; uniform float resolution; varying float life; varying float distanceFade;
      void main(){life=fract(phase+time*.13); vec3 p=position;
      p.y+=life*4.;p.x+=sin(life*4.+phase*6.)*life*.7;p.z+=life*.6;
      vec4 v=modelViewMatrix*vec4(p,1.); distanceFade=1.-smoothstep(45.,120.,-v.z);
      gl_Position=projectionMatrix*v;gl_PointSize=min(180.,resolution*(.65+life*2.8)/max(1.,-v.z));}`,
    fragmentShader: `varying float life; varying float distanceFade;
      void main(){vec2 p=gl_PointCoord-.5;float a=exp(-dot(p,p)*15.)*(1.-smoothstep(.3,.5,length(p)));
      a*=sin(life*3.14159)*.09*distanceFade;gl_FragColor=vec4(.28,.39,.46,a);}`,
  });
  const steam = new THREE.Points(geometry, material); steam.frustumCulled = false; scene.add(steam);
  return { update(time: number, height: number) { material.uniforms.time.value = time; material.uniforms.resolution.value = height; } };
}
