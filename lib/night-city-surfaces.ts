import * as THREE from 'three';
import type { GraphicsQuality } from './graphics-quality';

/** A shared water mask keeps captured reflections inside the asphalt's smooth patches. */
export const NIGHT_ROAD_SURFACE_GLSL = `
  float asphaltNoise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    vec4 n=fract(sin(vec4(dot(i,vec2(127.1,311.7)),dot(i+vec2(1.,0.),vec2(127.1,311.7)),
      dot(i+vec2(0.,1.),vec2(127.1,311.7)),dot(i+1.,vec2(127.1,311.7))))*43758.5453);
    return mix(mix(n.x,n.y,f.x),mix(n.z,n.w,f.x),f.y);
  }
  float nightRoadWetness(vec2 p) {
    float pools=1.-smoothstep(.28,.73,asphaltNoise(p*.34));
    vec2 roadOffset=abs(mod(p,44.)-22.);
    float laneOffset=min(roadOffset.x,roadOffset.y);
    float kerb=smoothstep(5.8,8.75,laneOffset);
    float wheelLanes=1.-smoothstep(.3,.95,abs(laneOffset-4.4));
    return clamp(pools*.83+kerb*.18-wheelLanes*.08,.06,1.);
  }`;

/** Wet asphalt and baked shop spill share the road draw, including the lowest quality tier. */
export function finishNightRoad(material: THREE.MeshStandardMaterial) {
  material.roughness = .48;
  material.metalness = .055;
  material.envMapIntensity = .5;
  material.userData.nightRoadSurface = true;
  const detail = { value: .8 };
  material.onBeforeCompile = shader => {
    shader.uniforms.nightRoadDetail = detail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNightRoadWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvNightRoadWorld = (modelMatrix * vec4(transformed, 1.)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vNightRoadWorld;
        uniform float nightRoadDetail;
        ${NIGHT_ROAD_SURFACE_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float roadWetness=nightRoadWetness(vNightRoadWorld.xz);
        float asphaltGrain=0.;
        // Reuse filtered albedo grain: its mipmaps suppress distant shimmer.
        #ifdef USE_MAP
          asphaltGrain=clamp((dot(sampledDiffuseColor.rgb,vec3(.333333))-.14)*5.,-.3,.3);
        #endif
        roughnessFactor=clamp(mix(.78,mix(.3,.225,nightRoadDetail),roadWetness)
          +asphaltGrain*(.14-roadWetness*.08),.225,.82);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // A thin water film levels the aggregate instead of looking like wet gravel.
        normal=normalize(mix(normal,nonPerturbedNormal,roadWetness*(.35+nightRoadDetail*.35)));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec2 roadCell=mod(vNightRoadWorld.xz+22.,44.)-22.;
        vec2 roadDistance=22.-abs(roadCell);
        vec2 district=floor(vNightRoadWorld.xz/44.);
        vec2 pool=max(vec2(0.),vec2(1.)-abs(roadDistance-8.4)*.14);
        pool*=pool;
        vec2 shop=.5+.5*sin(vNightRoadWorld.zx*.65+district*2.3);
        shop*=shop*shop;
        vec3 cyanSpill=vec3(.025,.29,.37)*pool.x*shop.x;
        vec3 pinkSpill=vec3(.38,.025,.13)*pool.y*shop.y;
        totalEmissiveRadiance+=(cyanSpill+pinkSpill)*(.05+roadWetness*.135)*(.9+nightRoadDetail*.22);
        // Darker, smoother wet patches share one mask; dry aggregate stays legible.
        diffuseColor.rgb*=mix(1.03,.77,roadWetness)*(1.+asphaltGrain*(.22+nightRoadDetail*.08));`);
  };
  material.customProgramCacheKey = () => 'night-city-wet-asphalt-v3';
  material.needsUpdate = true;
  return {
    // Uniform changes survive static batching and never compile a new tier shader.
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = Number.isFinite(pressure) ? THREE.MathUtils.clamp(pressure, 0, 4) : 0;
      detail.value = { low: .2, medium: .5, high: .82, ultra: 1 }[preset];
      material.envMapIntensity = { low: .34, medium: .42, high: .54, ultra: .65 }[preset];
      material.bumpScale = { low: .019, medium: .023, high: .027, ultra: .03 }[preset] / (1 + load * .04);
    },
  };
}
