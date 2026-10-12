import * as THREE from 'three';

/** Wet asphalt and baked shop spill share the road draw, including the lowest quality tier. */
export function finishNightRoad(material: THREE.MeshStandardMaterial) {
  material.roughness = .48;
  material.metalness = .09;
  material.envMapIntensity = .32;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNightRoadWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvNightRoadWorld = (modelMatrix * vec4(transformed, 1.)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vNightRoadWorld;
        float asphaltNoise(vec2 p) {
          vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          vec4 n=fract(sin(vec4(dot(i,vec2(127.1,311.7)),dot(i+vec2(1.,0.),vec2(127.1,311.7)),
            dot(i+vec2(0.,1.),vec2(127.1,311.7)),dot(i+1.,vec2(127.1,311.7))))*43758.5453);
          return mix(mix(n.x,n.y,f.x),mix(n.z,n.w,f.x),f.y);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float pools=asphaltNoise(vNightRoadWorld.xz*.34);
        float roadWetness=1.-smoothstep(.29,.68,pools);
        float asphaltGrain=0.;
        // Reuse filtered albedo grain: its mipmaps suppress distant shimmer.
        #ifdef USE_MAP
          asphaltGrain=clamp((dot(sampledDiffuseColor.rgb,vec3(.333333))-.14)*5.,-.3,.3);
        #endif
        roughnessFactor=clamp(mix(.74,.27,roadWetness)+asphaltGrain*(.13-roadWetness*.07),.24,.79);`)
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
        totalEmissiveRadiance+=(cyanSpill+pinkSpill)*(.045+roadWetness*.115);
        // Darker, smoother wet patches share one mask; dry aggregate stays legible.
        diffuseColor.rgb*=mix(1.03,.79,roadWetness)*(1.+asphaltGrain*.24);`);
  };
  material.customProgramCacheKey = () => 'night-city-wet-asphalt-v2';
  material.needsUpdate = true;
}
