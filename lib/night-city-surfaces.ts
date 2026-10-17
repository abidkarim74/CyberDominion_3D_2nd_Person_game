import * as THREE from 'three';
import type { GraphicsQuality } from './graphics-quality';

const ASPHALT_SURFACE_GLSL = `
  float asphaltNoise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    vec4 n=fract(sin(vec4(dot(i,vec2(127.1,311.7)),dot(i+vec2(1.,0.),vec2(127.1,311.7)),
      dot(i+vec2(0.,1.),vec2(127.1,311.7)),dot(i+1.,vec2(127.1,311.7))))*43758.5453);
    return mix(mix(n.x,n.y,f.x),mix(n.z,n.w,f.x),f.y);
  }
  float roadDampness(vec2 p) {
    float pools=1.-smoothstep(.22,.5,asphaltNoise(p*.31));
    vec2 roadOffset=abs(mod(p,44.)-22.);
    float laneOffset=min(roadOffset.x,roadOffset.y);
    float kerb=smoothstep(5.6,8.5,laneOffset);
    float wheelLanes=1.-smoothstep(.3,.95,abs(laneOffset-4.4));
    return clamp(pools*(.08+kerb*.34)-wheelLanes*.06,0.,.4);
  }`;

/** Rough mineral asphalt: weather adds tonal variation without a polished water film. */
export function finishNightRoad(material: THREE.MeshStandardMaterial) {
  material.roughness = .94;
  material.metalness = 0;
  material.envMapIntensity = .1;
  material.userData.nightRoadSurface = true;
  const detail = { value: .8 };
  material.onBeforeCompile = shader => {
    shader.uniforms.nightRoadDetail = detail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNightRoadWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vNightRoadWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
        // One eight-metre tile stays aligned on both street axes and across junctions.
        vec2 roadUv=vNightRoadWorld.xz*vec2(.125,-.125);
        #ifdef USE_MAP
          vMapUv=roadUv;
        #endif
        #ifdef USE_BUMPMAP
          vBumpMapUv=roadUv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv=roadUv;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vNightRoadWorld;
        uniform float nightRoadDetail;
        ${ASPHALT_SURFACE_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float dampness=roadDampness(vNightRoadWorld.xz);
        // Even the slightly darker kerb patches retain a broad, matte response.
        roughnessFactor=clamp(roughnessFactor-dampness*.08,.84,.98);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Slow world-space wear breaks up texture repetition without extra geometry.
        float weathering=asphaltNoise(vNightRoadWorld.xz*.19);
        diffuseColor.rgb*=mix(.88,1.08,weathering)*mix(1.,.85,roadDampness(vNightRoadWorld.xz));
        #ifdef USE_MAP
          // The texture's mip chain filters the aggregate rather than shimmering at distance.
          float grain=clamp((dot(sampledDiffuseColor.rgb,vec3(.333333))-.095)*2.,-.14,.14);
          diffuseColor.rgb*=1.+grain*nightRoadDetail;
        #endif`);
  };
  material.customProgramCacheKey = () => 'night-city-matte-asphalt-v1';
  material.needsUpdate = true;
  return {
    setPreset(preset: GraphicsQuality, pressure = 0) {
      const load = Number.isFinite(pressure) ? THREE.MathUtils.clamp(pressure, 0, 4) : 0;
      detail.value = { low: .45, medium: .65, high: .85, ultra: 1 }[preset];
      // Quality changes resolve more surface detail without bringing the gloss back.
      material.envMapIntensity = .1;
      material.bumpScale = { low: .009, medium: .011, high: .013, ultra: .014 }[preset] / (1 + load * .04);
    },
  };
}
