import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;

const filterShader = /* glsl */ `
  uniform sampler2D sourceTexture;
  uniform vec2 sourceTexel;
  varying vec2 vUv;
  vec3 blurFour(vec2 uv) {
    vec2 offset = sourceTexel * .75;
    return (
      texture2D(sourceTexture, uv + vec2(-offset.x, -offset.y)).rgb +
      texture2D(sourceTexture, uv + vec2(offset.x, -offset.y)).rgb +
      texture2D(sourceTexture, uv + vec2(-offset.x, offset.y)).rgb +
      texture2D(sourceTexture, uv + vec2(offset.x, offset.y)).rgb
    ) * .25;
  }
`;

function renderTarget(name: string) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = name;
  return target;
}

function material(name: string, uniforms: Record<string, THREE.IUniform>, fragmentShader: string) {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader, fragmentShader,
    depthTest: false, depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

/** Five small HDR draws build glow; the presentation pass adds it to the scene. */
export class NeonBloomPass extends Pass {
  readonly resolution: THREE.Vector2;
  private readonly bright = renderTarget('Neon bloom / quarter-resolution bright areas');
  private readonly medium = renderTarget('Neon bloom / eighth-resolution blur');
  private readonly broad = renderTarget('Neon bloom / sixteenth-resolution blur');
  private readonly combined = renderTarget('Neon bloom / combined eighth-resolution glow');
  private readonly glow = renderTarget('Neon bloom / final quarter-resolution glow');
  private readonly oldClearColor = new THREE.Color();
  private readonly quad = new FullScreenQuad();
  private readonly extract = material('Neon bloom / luminance extraction', {
    sourceTexture: { value: null },
    sourceTexel: { value: new THREE.Vector2(1, 1) },
    threshold: { value: 1.12 },
  }, /* glsl */ `
    uniform sampler2D sourceTexture;
    uniform vec2 sourceTexel;
    uniform float threshold;
    varying vec2 vUv;
    vec3 brightSample(vec2 uv) {
      vec3 color = texture2D(sourceTexture, uv).rgb;
      float brightness = dot(color, vec3(.2126, .7152, .0722));
      // A mirror-like glint can be hundreds of times brighter than a sign.
      // Bound its glow contribution, preserving hue and the original HDR
      // surface in the main image instead of spreading a white block over it.
      vec3 glow = color * min(1., 2.5 / max(brightness, .001));
      return glow * smoothstep(threshold, threshold + .35, brightness);
    }
    void main() {
      // Filter after thresholding to retain thin, bright neon during downsampling.
      vec2 offset = sourceTexel;
      vec3 color = (
        brightSample(vUv + vec2(-offset.x, -offset.y)) +
        brightSample(vUv + vec2(offset.x, -offset.y)) +
        brightSample(vUv + vec2(-offset.x, offset.y)) +
        brightSample(vUv + vec2(offset.x, offset.y))
      ) * .25;
      gl_FragColor = vec4(color, 1.);
    }
  `);
  private readonly downsample = material('Neon bloom / four-tap downsample', {
    sourceTexture: { value: null },
    sourceTexel: { value: new THREE.Vector2(1, 1) },
  }, `${filterShader}
    void main() { gl_FragColor = vec4(blurFour(vUv), 1.); }
  `);
  private readonly upsample = material('Neon bloom / four-tap upsample and combine', {
    sourceTexture: { value: null },
    sourceTexel: { value: new THREE.Vector2(1, 1) },
    baseTexture: { value: null },
    baseWeight: { value: 1 },
    sourceWeight: { value: 1 },
    outputScale: { value: 1 },
  }, `${filterShader}
    uniform sampler2D baseTexture;
    uniform float baseWeight;
    uniform float sourceWeight;
    uniform float outputScale;
    void main() {
      vec3 color = texture2D(baseTexture, vUv).rgb * baseWeight;
      color += blurFour(vUv) * sourceWeight;
      gl_FragColor = vec4(color * outputScale, 1.);
    }
  `);

  constructor(
    resolution = new THREE.Vector2(1, 1),
    public strength = .46,
    public radius = .48,
    public threshold = 1.12,
  ) {
    super();
    this.needsSwap = false;
    this.resolution = resolution.clone();
    this.setSize(resolution.x, resolution.y);
  }

  /** Linear HDR glow already includes strength; add its RGB once before tone mapping. */
  get bloomTexture(): THREE.Texture {
    return this.glow.texture;
  }

  override setSize(width: number, height: number) {
    this.resolution.set(width, height);
    const quarterWidth = Math.max(1, Math.round(width / 4));
    const quarterHeight = Math.max(1, Math.round(height / 4));
    const eighthWidth = Math.max(1, Math.round(quarterWidth / 2));
    const eighthHeight = Math.max(1, Math.round(quarterHeight / 2));
    this.bright.setSize(quarterWidth, quarterHeight);
    this.glow.setSize(quarterWidth, quarterHeight);
    this.medium.setSize(eighthWidth, eighthHeight);
    this.combined.setSize(eighthWidth, eighthHeight);
    this.broad.setSize(Math.max(1, Math.round(eighthWidth / 2)), Math.max(1, Math.round(eighthHeight / 2)));
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    _deltaTime?: number,
    maskActive = false,
  ) {
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousAutoClear = renderer.autoClear;
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.oldClearColor);
    renderer.autoClear = false;
    if (maskActive) renderer.state.buffers.stencil.setTest(false);

    try {
      this.extract.uniforms.sourceTexture.value = readBuffer.texture;
      this.extract.uniforms.sourceTexel.value.set(1 / Math.max(1, readBuffer.width), 1 / Math.max(1, readBuffer.height));
      this.extract.uniforms.threshold.value = this.threshold;
      this.draw(renderer, this.bright, this.extract);

      this.filter(renderer, this.bright, this.medium);
      this.filter(renderer, this.medium, this.broad);

      // The three scale weights already sum to 3. Apply strength once;
      // another 3x multiplier overexposes reflective paint and windshields.
      const radius = THREE.MathUtils.clamp(this.radius, 0, 1);
      this.combine(renderer, this.medium, this.broad, this.combined, 1.4 - .4 * radius, .6 + 1.2 * radius, 1);
      this.combine(renderer, this.bright, this.combined, this.glow, 1 - .8 * radius, 1, this.strength);
    } finally {
      if (maskActive) renderer.state.buffers.stencil.setTest(true);
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      renderer.setClearColor(this.oldClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
    }
  }

  private draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, shader: THREE.ShaderMaterial) {
    this.quad.material = shader;
    renderer.setRenderTarget(target);
    // Every pixel is overwritten, so these color-only targets need no clear.
    this.quad.render(renderer);
  }

  private filter(renderer: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget) {
    this.downsample.uniforms.sourceTexture.value = source.texture;
    this.downsample.uniforms.sourceTexel.value.set(1 / source.width, 1 / source.height);
    this.draw(renderer, target, this.downsample);
  }

  private combine(
    renderer: THREE.WebGLRenderer,
    base: THREE.WebGLRenderTarget,
    source: THREE.WebGLRenderTarget,
    target: THREE.WebGLRenderTarget,
    baseWeight: number,
    sourceWeight: number,
    outputScale: number,
  ) {
    this.upsample.uniforms.baseTexture.value = base.texture;
    this.upsample.uniforms.sourceTexture.value = source.texture;
    this.upsample.uniforms.sourceTexel.value.set(1 / source.width, 1 / source.height);
    this.upsample.uniforms.baseWeight.value = baseWeight;
    this.upsample.uniforms.sourceWeight.value = sourceWeight;
    this.upsample.uniforms.outputScale.value = outputScale;
    this.draw(renderer, target, this.upsample);
  }

  override dispose() {
    this.bright.dispose();
    this.medium.dispose();
    this.broad.dispose();
    this.combined.dispose();
    this.glow.dispose();
    this.extract.dispose();
    this.downsample.dispose();
    this.upsample.dispose();
    this.quad.dispose();
  }
}
