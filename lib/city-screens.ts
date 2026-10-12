import * as THREE from 'three';

export type ScreenClock = { value: number };
type ScreenKind = 'tower' | 'district' | 'marquee';

/** The city's existing render loop advances this shared uniform in seconds. */
export function screenClock(scene: THREE.Scene): ScreenClock {
  const existing = scene.userData.cityScreenClock as ScreenClock | undefined;
  if (existing && typeof existing.value === 'number') return existing;
  const clock: ScreenClock = { value: 0 };
  scene.userData.cityScreenClock = clock;
  return clock;
}

const SCREEN_VERTEX = /* glsl */ `
  // The plane offset also remains constant when city geometry is baked into world space.
  vec4 cityScreenOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
  vec4 cityScreenWorld = vec4( transformed, 1.0 );
  vec3 cityScreenNormal = normal;
  #ifdef USE_BATCHING
    cityScreenOrigin = batchingMatrix * cityScreenOrigin;
    cityScreenWorld = batchingMatrix * cityScreenWorld;
    cityScreenNormal = mat3( batchingMatrix ) * cityScreenNormal;
  #endif
  #ifdef USE_INSTANCING
    cityScreenOrigin = instanceMatrix * cityScreenOrigin;
    cityScreenWorld = instanceMatrix * cityScreenWorld;
    cityScreenNormal = mat3( instanceMatrix ) * cityScreenNormal;
  #endif
  vCityScreenOrigin = ( modelMatrix * cityScreenOrigin ).xyz;
  cityScreenWorld = modelMatrix * cityScreenWorld;
  cityScreenNormal = normalize( mat3( modelMatrix ) * cityScreenNormal );
  vCityScreenPlane = dot( cityScreenNormal, cityScreenWorld.xyz );
`;

const SCREEN_COMMON = /* glsl */ `
  uniform float cityScreenTime;
  varying vec3 vCityScreenOrigin;
  varying float vCityScreenPlane;

  float cityScreenPhase( float tile ) {
    float cityPlane = floor( vCityScreenPlane * 4.0 + 0.5 ) * 0.25;
    return fract( sin( dot( vCityScreenOrigin, vec3( 0.1031, 0.1737, 0.1379 ) ) + cityPlane * 0.117 + tile * 1.937 ) * 43758.5453 );
  }

  float cityScreenBand( float value, float start, float end, float feather ) {
    return smoothstep( start - feather, start, value ) * ( 1.0 - smoothstep( end, end + feather, value ) );
  }
`;

const TOWER_FRAGMENT = /* glsl */ `
  #ifdef USE_MAP
    float cityBaseTile = min( floor( vMapUv.x * 4.0 ), 3.0 );
    float cityPhase = cityScreenPhase( cityBaseTile );
    float cityTime = cityScreenTime + cityPhase * 35.0;
    vec2 cityLocal = vec2( vMapUv.x * 4.0 - cityBaseTile, vMapUv.y );
    float cityCycle = floor( cityTime / 9.0 );
    float cityStage = mod( cityTime, 9.0 );
    float cityTile = mod( cityBaseTile + cityCycle, 4.0 );
    float cityNextTile = mod( cityTile + 1.0, 4.0 );

    // A slow optical drift stays inside the tile's padded border.
    float cityZoom = 1.0 - 0.018 * ( 0.5 + 0.5 * sin( cityTime * 0.38 ) );
    vec2 cityOptical = ( cityLocal - 0.5 ) * cityZoom + 0.5;
    cityOptical += vec2( sin( cityTime * 0.31 ), cos( cityTime * 0.27 ) ) * vec2( 0.0028, 0.0015 );
    cityOptical = clamp( cityOptical, vec2( 0.010, 0.004 ), vec2( 0.990, 0.996 ) );
    vec4 cityCurrent = texture2D( map, vec2( ( cityTile + cityOptical.x ) / 4.0, cityOptical.y ) );
    vec4 cityNext = texture2D( map, vec2( ( cityNextTile + cityOptical.x ) / 4.0, cityOptical.y ) );

    // Hold each campaign, then replace it with one horizontal broadcast wipe.
    float cityWipe = smoothstep( 7.65, 8.90, cityStage );
    float cityWipePosition = mix( -0.025, 1.025, cityWipe );
    float cityChange = smoothstep( 1.0 - cityLocal.y - 0.014, 1.0 - cityLocal.y + 0.014, cityWipePosition );
    cityChange *= step( 0.001, cityWipe );
    vec3 cityColor = mix( cityCurrent.rgb, cityNext.rgb, cityChange );
    float cityWipeEdge = 1.0 - smoothstep( 0.0, 0.018, abs( 1.0 - cityLocal.y - cityWipePosition ) );
    cityWipeEdge *= step( 0.001, cityWipe ) * ( 1.0 - step( 0.999, cityWipe ) );
    float cityScanY = fract( cityTime * 0.085 + cityPhase );
    float cityScan = 1.0 - smoothstep( 0.0, 0.025, abs( cityLocal.y - cityScanY ) );
    float cityFooter = cityScreenBand( cityLocal.y, 0.018, 0.029, 0.003 );
    float cityTicker = step( 0.34, fract( cityLocal.x * 22.0 - cityTime * 0.72 ) ) * cityFooter;
    cityColor *= 0.995 + 0.014 * sin( cityTime * 0.74 + cityPhase * 6.28318 );
    cityColor += vec3( 0.18, 0.42, 0.46 ) * ( cityScan * 0.22 + cityWipeEdge * 0.36 + cityTicker * 0.24 );
    diffuseColor *= vec4( cityColor, 1.0 );
  #endif
`;

const DISTRICT_FRAGMENT = /* glsl */ `
  #ifdef USE_MAP
    float cityBaseTile = min( floor( vMapUv.x * 8.0 ), 7.0 );
    float cityPhase = cityScreenPhase( cityBaseTile );
    float cityTime = cityScreenTime + cityPhase * 59.0;
    vec2 cityLocal = vec2( vMapUv.x * 8.0 - cityBaseTile, vMapUv.y * 3.0 - 1.0 );
    float cityCycle = floor( cityTime / 8.0 );
    float cityStage = mod( cityTime, 8.0 );
    float cityTile = mod( cityBaseTile + cityCycle, 8.0 );
    float cityNextTile = mod( cityTile + 1.0, 8.0 );

    // Only the central campaign graphic drifts; captions remain easy to read.
    float cityGraphic = cityScreenBand( cityLocal.y, 0.32, 0.88, 0.075 );
    vec2 cityOptical = cityLocal + cityGraphic * vec2( sin( cityTime * 0.47 ) * 0.011, cos( cityTime * 0.33 ) * 0.005 );
    cityOptical = clamp( cityOptical, vec2( 0.008, 0.004 ), vec2( 0.992, 0.996 ) );
    vec4 cityCurrent = texture2D( map, vec2( ( cityTile + cityOptical.x ) / 8.0, ( 1.0 + cityOptical.y ) / 3.0 ) );
    vec4 cityNext = texture2D( map, vec2( ( cityNextTile + cityOptical.x ) / 8.0, ( 1.0 + cityOptical.y ) / 3.0 ) );
    float cityWipe = smoothstep( 6.75, 7.92, cityStage );
    float cityWipePosition = mix( -0.025, 1.025, cityWipe );
    float cityChange = smoothstep( 1.0 - cityLocal.y - 0.020, 1.0 - cityLocal.y + 0.020, cityWipePosition );
    cityChange *= step( 0.001, cityWipe );
    vec3 cityColor = mix( cityCurrent.rgb, cityNext.rgb, cityChange );
    float cityScanY = fract( cityTime * 0.13 + cityPhase );
    float cityScan = 1.0 - smoothstep( 0.0, 0.035, abs( cityLocal.y - cityScanY ) );
    float cityFooter = cityScreenBand( cityLocal.y, 0.016, 0.033, 0.004 );
    float cityTicker = step( 0.36, fract( cityLocal.x * 16.0 - cityTime * 0.85 ) ) * cityFooter;
    cityColor *= 0.995 + 0.015 * sin( cityTime * 0.66 + cityPhase * 6.28318 );
    cityColor += vec3( 0.16, 0.40, 0.43 ) * ( cityScan * 0.26 + cityTicker * 0.36 );
    diffuseColor *= vec4( cityColor, 1.0 );
  #endif
`;

const MARQUEE_FRAGMENT = /* glsl */ `
  #ifdef USE_MAP
    vec4 citySample = texture2D( map, vMapUv );
    float cityCanvasY = ( 1.0 - vMapUv.y ) * 1536.0;
    float cityBaseTile = floor( vMapUv.x * 4.0 ) + floor( cityCanvasY / 256.0 ) * 4.0;
    float cityPhase = cityScreenPhase( cityBaseTile );
    float cityTime = cityScreenTime + cityPhase * 23.0;
    vec2 cityHeader = vec2( fract( vMapUv.x * 4.0 ), mod( cityCanvasY, 256.0 ) / 83.0 );
    float cityHeaderMask = ( 1.0 - step( 512.0, cityCanvasY ) ) * ( 1.0 - step( 1.0, cityHeader.y ) );
    float cityDots = 0.0;
    for ( int cityDot = 0; cityDot < 3; cityDot++ ) {
      float cityIndex = float( cityDot );
      vec2 cityDelta = vec2( ( cityHeader.x - ( 0.880 + cityIndex * 0.038 ) ) * 6.16867, cityHeader.y - 0.230 );
      float cityCircle = 1.0 - smoothstep( 0.026, 0.043, length( cityDelta ) );
      float cityPulse = 0.25 + 0.75 * ( 0.5 + 0.5 * sin( cityTime * 2.0 - cityIndex * 1.5 ) );
      cityDots += cityCircle * cityPulse;
    }
    float cityUnderline = cityScreenBand( cityHeader.y, 0.890, 0.920, 0.018 );
    cityUnderline *= cityScreenBand( cityHeader.x, 0.055, 0.950, 0.005 );
    float citySweep = pow( max( 0.0, 1.0 - abs( fract( cityHeader.x - cityTime * 0.11 ) - 0.5 ) * 2.0 ), 8.0 );
    citySample.rgb += vec3( 0.12, 0.42, 0.43 ) * cityHeaderMask * ( cityDots * 0.75 + cityUnderline * ( 0.045 + citySweep * 0.40 ) );
    diffuseColor *= citySample;
  #endif
`;

/** Animate atlas UVs in the GPU while retaining ordinary opaque city batches. */
export function animatedScreenMaterial(map: THREE.Texture, clock: ScreenClock, kind: ScreenKind): THREE.MeshBasicMaterial {
  const intensity = kind === 'tower' ? 1.35 : 1.3;
  const material = new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(intensity, intensity, intensity),
    transparent: false,
    fog: true,
    toneMapped: false,
  });
  material.name = `City screen / ${kind}`;
  material.userData.noCastShadow = true;
  material.userData.cityScreenKind = kind;
  material.customProgramCacheKey = () => `city-screen-v1/${kind}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.cityScreenTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCityScreenOrigin;\nvarying float vCityScreenPlane;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${SCREEN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SCREEN_COMMON}`)
      .replace('#include <map_fragment>', kind === 'tower' ? TOWER_FRAGMENT : kind === 'district' ? DISTRICT_FRAGMENT : MARQUEE_FRAGMENT);
  };
  return material;
}
