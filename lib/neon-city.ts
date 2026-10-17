import * as THREE from 'three';
import { CITY_SPAN, CITY_EDGE, ROAD_WIDTH, ROAD_STEP, ROAD_COORDS, occupiesRoad } from './city-layout';
import { CityAudio } from './city-audio';
import { addIslandEnvironment } from './island-environment';
import { collectWorldColliders, CAR_HALF_WIDTH, CAR_HALF_LENGTH, ColliderGrid, type WorldCollider } from './city-collision';
import { addRoadSnow } from './road-snow';
import { addSnowTracks } from './snow-tracks';
import { addRoadSkidMarks } from './road-skid-marks';
import { createTireFeedback } from './tire-feedback';
import { makeSnowContact } from './snow-surface';
import { stepVehicle, WHEEL_CONTACTS, NITRO_SPEED_MULTIPLIER, MAX_NITRO_SPEED_KMH, PLAYER_STEERING_ASSIST, type VehicleMotion } from './vehicle-dynamics';
import { addFallingSnow } from './falling-snow';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { addSteam } from './driving-atmosphere';
import { makePresentationPass } from './presentation-pass';
import { addInfrastructure, type CoveredRoad } from './city-infrastructure';
import { makeCar } from './cinematic-car';
import { AiTraffic, type TrafficMarker } from './ai-traffic';
import { AiPedestrians } from './ai-pedestrians';
import { BULLET_SPEED, SHOT_IMPULSE, MINIGUN_SPIN, type GunShot } from './front-miniguns';
import { projectileHitFraction } from './weapon-ballistics';
import { addCityDetail, batchArchitecture, cityVisibility, cityEnvironment, poolStreetLights, wetStreetReflection } from './cinematic-city';
import { NeonBloomPass } from './neon-bloom-pass';
import { makeHologramTexture } from './cyberpunk-atmosphere';
import { addSkylineBuilding, makeSkylineStyles, planSkylineBuilding, type FacadeStyle } from './cyberpunk-buildings';
import { finishNightRoad } from './night-city-surfaces';
import { screenClock } from './city-screens';
import { PersonController, type PersonTelemetry, type VehicleBlocker } from './person-controller';
import { GRAPHICS_PRESETS, isGraphicsQuality, loadGraphicsPreference, recommendGraphicsQuality, saveGraphicsPreference, type GraphicsQuality, type GraphicsStatus } from './graphics-quality';

export type CameraView = 'chase' | 'driver' | 'orbit' | 'person';

export type DriveTelemetry = {
  speed: number;
  boost: number;
  drifting: boolean;
  boosting: boolean;
  firing: boolean;
  person?: PersonTelemetry;
};

type BuildingCollider = WorldCollider;
type Particle = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; color: THREE.Color };

type Bullet = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; age: number; tracer: boolean };
type SmokeParticle = { position: THREE.Vector3; velocity: THREE.Vector3; life: number; maxLife: number; size: number; opacity: number; seed: number };

function cameraWallEntry(from: THREE.Vector3, to: THREE.Vector3, solid: WorldCollider) {
  let enter = 0, exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = axis === 0 ? from.x : axis === 1 ? from.y : from.z;
    const motion = (axis === 0 ? to.x : axis === 1 ? to.y : to.z) - start;
    const minimum = axis === 0 ? solid.x - solid.hx - .2 : axis === 1 ? (solid.minY ?? 0) - .2 : solid.z - solid.hz - .2;
    const maximum = axis === 0 ? solid.x + solid.hx + .2 : axis === 1 ? (solid.maxY ?? Infinity) + .2 : solid.z + solid.hz + .2;
    if (Math.abs(motion) < 1e-8) { if (start < minimum || start > maximum) return 1; }
    else {
      const a = (minimum - start) / motion, b = (maximum - start) / motion;
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return 1;
    }
  }
  return exit > 0 && enter > 0 ? Math.min(1, Math.max(0, enter - .03)) : 1;
}

function rng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function addQuad(
  positions: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
) {
  positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
}

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,.82)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,.24)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRoadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas textures are unavailable.');
  const random = rng(78);
  context.fillStyle = '#666a70';
  context.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i += 1) {
    const alpha = random() * 0.3;
    context.fillStyle = random() > 0.46
      ? `rgba(126,163,183,${alpha})`
      : `rgba(1,5,12,${alpha + 0.03})`;
    const size = 1 + random() * 4;
    context.fillRect(random() * 512, random() * 512, size * 2.4, size * 0.35);
  }
  for (let i = 0; i < 45; i += 1) {
    const y = random() * 512;
    context.fillStyle = `rgba(88,161,190,${random() * 0.07})`;
    context.fillRect(0, y, 512, random() * 3 + 0.6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function addTunnel(scene: THREE.Scene, colliders: BuildingCollider[]) {
  const structure = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x101625, metalness: 0.74, roughness: 0.38 });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(19.4, 1.7, 26), concrete);
  roof.position.set(0, 10.2, 66);
  structure.add(roof);
  const innerRoof = new THREE.Mesh(
    new THREE.BoxGeometry(18.2, 0.18, 25),
    new THREE.MeshStandardMaterial({ color: 0x080e1b, metalness: 0.72, roughness: 0.32, emissive: 0x102c3b }),
  );
  innerRoof.position.set(0, 9.28, 66);
  structure.add(innerRoof);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9.6, 26), concrete);
    wall.position.set(side * 9.35, 4.8, 66);
    structure.add(wall);
    const guide = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 25),
      new THREE.MeshBasicMaterial({ color: side < 0 ? 0x20dbea : 0xf5409d, toneMapped: false }),
    );
    guide.position.set(side * 8.83, 8.8, 66);
    structure.add(guide);
  }
  for (let i = 0; i < 9; i += 1) {
    const z = 54 + i * 3;
    const rib = new THREE.Mesh(
      new THREE.TorusGeometry(8.9, 0.16, 6, 24, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x25394c, metalness: 0.9, roughness: 0.24 }),
    );
    rib.rotation.x = 0;
    rib.position.set(0, 0.5, z);
    structure.add(rib);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.08, 0.15),
      new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0xff4b9d : 0x41e6fa, toneMapped: false }),
    );
    lamp.position.set(0, 9.1, z);
    structure.add(lamp);
  }
  for (const z of [53, 79]) {
    const portal = new THREE.Mesh(
      new THREE.BoxGeometry(18.6, 0.28, 0.25),
      new THREE.MeshBasicMaterial({ color: 0x45eaff, toneMapped: false }),
    );
    portal.position.set(0, 9.24, z);
    structure.add(portal);
  }
  const tealLamp = new THREE.PointLight(0x41dfff, 28, 19, 2);
  tealLamp.position.set(0, 6.5, 57);
  structure.add(tealLamp);
  const pinkLamp = new THREE.PointLight(0xf437a7, 26, 19, 2);
  pinkLamp.position.set(0, 6.5, 75);
  structure.add(pinkLamp);
  structure.position.set(-22, 0, 22);
  scene.add(structure);
  colliders.push(
    { x: -31.4, z: 88, hx: 0.7, hz: 13 },
    { x: -12.6, z: 88, hx: 0.7, hz: 13 },
  );
}

function addSkyBridge(scene: THREE.Scene, z: number, color: number) {
  const bridge = new THREE.Group();
  bridge.position.x = -22;
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(42, 1.1, 5.6),
    new THREE.MeshStandardMaterial({ color: 0x151b2b, metalness: 0.84, roughness: 0.3 }),
  );
  deck.position.set(0, 17.4, z);
  bridge.add(deck);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(41, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    rail.position.set(0, 18.12, z + side * 2.45);
    bridge.add(rail);
    for (const x of [-19, 19]) {
      const support = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 17, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x202a3c, metalness: 0.83, roughness: 0.3 }),
      );
      support.position.set(x, 8.5, z + side * 2.45);
      bridge.add(support);
    }
  }
  for (let i = 0; i < 18; i += 1) {
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.08, 0.13),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    light.position.set(-20 + i * 2.35, 16.78, z);
    bridge.add(light);
  }
  const glow = new THREE.PointLight(color, 23, 32, 2);
  glow.position.set(0, 14.8, z);
  bridge.add(glow);
  scene.add(bridge);
}

function addStreetlights(scene: THREE.Scene) {
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x18263a, metalness: 0.88, roughness: 0.31 });
  const positions: [number, number, number][] = [];
  for (let xi = -8; xi <= 8; xi++) {
    for (let zi = -8; zi <= 8; zi++) {
      const x = xi * 44;
      const z = zi * 44;
      if ((xi + zi) % 2 === 0) continue;
      const color = (xi + zi) % 4 === 1 ? 0x46e9ff : 0xff45ac;
      positions.push([x, z, color]);
    }
  }
  for (const [x, z, color] of positions) {
    const lightGroup = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 7.5, 8), poleMaterial);
    pole.position.y = 3.75;
    lightGroup.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMaterial);
    arm.position.set(-1, 7.25, 0);
    lightGroup.add(arm);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.13, 0.52),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    lamp.position.set(-2.05, 7.12, 0);
    lightGroup.add(lamp);
    const glow = new THREE.PointLight(color === 0x46e9ff ? 0xa4cfdb : 0xc59aac, 48, 24, 2);
    glow.position.set(-2, 6.9, 0);
    lightGroup.add(glow);
    lightGroup.position.set(x, 0, z);
    scene.add(lightGroup);
  }
}

function addFlyingVehicles(scene: THREE.Scene) {
  const random = rng(4021);
  return Array.from({ length: 18 }, (_, index) => {
    const hue = index % 2 === 0 ? 0x39e9ff : 0xff4baf;
    const vehicle = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(1.1 + random() * 0.45, 0.24, 2.4 + random() * 1.2),
      new THREE.MeshStandardMaterial({
        color: 0x172338,
        metalness: 0.82,
        roughness: 0.24,
        emissive: hue,
        emissiveIntensity: 0.42,
      }),
    );
    vehicle.add(hull);
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(0.64, 0.25, 0.75),
      new THREE.MeshBasicMaterial({ color: hue, toneMapped: false }),
    );
    canopy.position.y = 0.2;
    vehicle.add(canopy);
    for (const side of [-1, 1]) {
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 8),
        new THREE.MeshBasicMaterial({ color: hue, toneMapped: false }),
      );
      light.position.set(side * 0.56, 0, 0.6);
      vehicle.add(light);
    }
    // The canopy and navigation lamps move as one rigid assembly, sharing a single draw.
    batchArchitecture(vehicle, true);
    scene.add(vehicle);
    const phase = random() * Math.PI * 2;
    const radius = 140 + random() * 220;
    const height = 36 + random() * 80;
    const speed = 0.022 + random() * 0.025;
    return { vehicle, phase, radius, height, speed, index };
  });
}

export class NeonCityGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(66, 1, 0.1, 6500);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloomPass: NeonBloomPass;
  private readonly presentationPass = makePresentationPass();
  private scenePixelRatio = 1;
  private readonly scenePointMaterials: { material: THREE.PointsMaterial; size: number }[] = [];
  private readonly steam: ReturnType<typeof addSteam>;
  private readonly environment: THREE.WebGLRenderTarget;
  private readonly island: ReturnType<typeof addIslandEnvironment>;
  private readonly reflections: ReturnType<typeof wetStreetReflection>;
  private collisionWorld!: ColliderGrid;
  private cameraCollisionWorld!: ColliderGrid;
  private updateStreetLights!: ReturnType<typeof poolStreetLights>;
  private readonly blurHandler = () => { this.pressed.clear(); this.orbitPointers.clear(); this.cancelNitro(); this.audio.stopFiring(); for (const flash of this.muzzleFlashes) flash.visible = false; };
  private readonly visibilityHandler = () => {
    if (document.hidden) this.blurHandler();
    else { this.previousTime = 0; this.qualityResumeTime = this.elapsed + 2; }
  };
  private driftTimer = 0;
  private physicsAccumulator = 0;
  private reverseEngaged = false;
  private readonly carRig: ReturnType<typeof makeCar>;
  private readonly traffic: AiTraffic;
  private readonly pedestrians: AiPedestrians;
  private readonly person: PersonController;
  private readonly personBlockers: VehicleBlocker[] = [];
  private readonly pedestrianCarBlocker: VehicleBlocker = { x: -22, z: -22, yaw: 0, hx: CAR_HALF_WIDTH, hz: CAR_HALF_LENGTH };
  private readonly parkedMarker: TrafficMarker = { x: -22, z: -22, yaw: 0, color: '#ffcc7a' };
  private personCameraYaw = 0;
  private personCameraElevation = .22;
  private personCameraDistance = 4.5;
  private lastPersonMode = 'driving';
  private readonly car: THREE.Group;
  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly carPosition = new THREE.Vector3(-22, 0.015, -22);
  private readonly previousPosition = new THREE.Vector3();
  private readonly colliders: BuildingCollider[] = [];
  private readonly coveredRoads: CoveredRoad[] = [{ x: -22, z: 88, hx: 9.5, hz: 13, ceiling: 11, label: 'CENTRAL TUNNEL' }];
  private readonly neonSigns: THREE.Mesh[] = [];
  private keyLight!: THREE.DirectionalLight;
  private shadowFrame = 0;
  private readonly shadowPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  private shadowYaw = Infinity;
  private updateCityVisibility!: ReturnType<typeof cityVisibility>;
  private readonly pressed = new Set<string>();
  private readonly audio = new CityAudio();
  private readonly snowfall: ReturnType<typeof addFallingSnow>;
  private readonly roadSnow: ReturnType<typeof addRoadSnow>;
  private readonly snowbanks: THREE.Mesh;
  private readonly snowTracks: ReturnType<typeof addSnowTracks>;
  private readonly roadSkidMarks: ReturnType<typeof addRoadSkidMarks>;
  private readonly tireFeedback = createTireFeedback();
  private readonly wheelContacts = WHEEL_CONTACTS.map(() => makeSnowContact());
  private readonly vehicleMotion: VehicleMotion = { position: this.carPosition, velocity: this.velocity, yaw: 0, yawRate: 0, steeringAngle: 0, acceleration: 0, grip: .95, snow: 0 };
  private suspensionVelocity = 0;
  private readonly particleGeometry = new THREE.BufferGeometry();
  private readonly particlePositions = new Float32Array(180 * 3);
  private readonly particleColors = new Float32Array(180 * 3);
  private readonly particles: Particle[] = [];
  private readonly flying: ReturnType<typeof addFlyingVehicles>;
  private readonly wheelMeshes: THREE.Group[];
  private readonly brakeLights: THREE.Mesh[];
  private readonly exhaustMeshes: THREE.Mesh[];
  private readonly headlights: THREE.Mesh[];
  private readonly underglow: THREE.Mesh;
  private readonly muzzleFlashes: THREE.Mesh[];
  private readonly brakeDiscs: THREE.Mesh[];
  private readonly reverseLights: THREE.Mesh[];
  private readonly gunBarrels: THREE.Group[];
  private brakeHeat = 0;
  private readonly onTelemetry: (telemetry: DriveTelemetry) => void;
  private readonly onCameraView: (view: CameraView) => void;
  private readonly onMapPosition: (x: number, z: number, yaw: number, traffic: readonly TrafficMarker[], parked?: TrafficMarker) => void;
  private cameraView: CameraView = 'chase';
  private drivingCamera: 'chase' | 'driver' = 'chase';
  private orbitAzimuth = .65;
  private orbitElevation = .25;
  private orbitDistance = 7.2;
  private readonly orbitPointers = new Map<number, { x: number; y: number }>();
  private readonly pointerDownHandler = (event: PointerEvent) => this.onOrbitPointerDown(event);
  private readonly pointerMoveHandler = (event: PointerEvent) => this.onOrbitPointerMove(event);
  private readonly pointerUpHandler = (event: PointerEvent) => { this.orbitPointers.delete(event.pointerId); };
  private readonly wheelHandler = (event: WheelEvent) => {
    if (this.cameraView !== 'orbit' && this.cameraView !== 'person') return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
    if (this.cameraView === 'person') this.personCameraDistance = THREE.MathUtils.clamp(this.personCameraDistance * Math.exp(pixels * .001), 2, 7);
    else this.orbitDistance = THREE.MathUtils.clamp(this.orbitDistance * Math.exp(pixels * .001), 3.8, 12);
  };
  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly cameraOffset = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3(0, 1, 0);
  private readonly resizeHandler = () => this.resize();
  private readonly keyDownHandler = (event: KeyboardEvent) => this.onKeyDown(event);
  private readonly keyUpHandler = (event: KeyboardEvent) => this.onKeyUp(event);
  private readonly exhaustParticles: THREE.Points;
  private readonly glowMap: THREE.CanvasTexture;
  private readonly bullets: Bullet[] = [];
  private readonly freeBullets: Bullet[] = Array.from({ length: 200 }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, age: 0, tracer: false }));
  private readonly weaponPosition = new THREE.Vector3();
  private readonly weaponDirection = new THREE.Vector3();
  private readonly bulletPrevious = new THREE.Vector3();
  private readonly bulletGeometry = new THREE.BufferGeometry();
  private readonly bulletPositions = new Float32Array(200 * 6); // 200 bullets, 2 verts each (line segments)
  private readonly bulletColors = new Float32Array(200 * 6);
  private readonly bulletTrails: THREE.LineSegments;
  private readonly smokeParticles: SmokeParticle[] = [];
  private readonly freeSmokeParticles: SmokeParticle[] = Array.from({ length: 512 }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, maxLife: 1, size: 0, opacity: 0, seed: 0 }));
  private readonly smokeGeometry = new THREE.BufferGeometry();
  private readonly smokePositions = new Float32Array(512 * 3);
  private readonly smokeSizes = new Float32Array(512);
  private readonly smokeOpacities = new Float32Array(512);
  private readonly smokeMesh: THREE.Points;
  private gunSmokeTimer = 0;
  private active = false;
  private destroyed = false;
  private yaw = 0;
  private steerInput = 0;
  private boostCharge = 100;
  private nitroRemaining = 0;
  private nitroTargetSpeed = 0;
  private previousTime = 0;
  private elapsed = 0;
  private readonly cityScreenClock = screenClock(this.scene);
  private qualityLevel = 0;
  private graphicsQuality: GraphicsQuality = 'high';
  private recommendedGraphics: GraphicsQuality = 'high';
  private automaticGraphics = true;
  private measuredFps = 0;
  private readonly onGraphicsStatus: (status: GraphicsStatus) => void;
  private readonly configuredTextures = new Map<THREE.Texture, number>();
  private averageFrame = 16.7;
  private qualityWarmup = 8;
  private qualitySampleTime = 0;
  private qualitySampleFrames = 0;
  private qualitySampleMs = 0;
  private qualitySampleSlowFrames = 0;
  private qualityRecoveryTime = 0;
  private qualityPressureTime = 0;
  private qualityResumeTime = 0;
  private telemetryTimer = 0;
  private lastTelemetry: DriveTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false, firing: false };
  private readonly frameHandler = (time: number) => this.frame(time);

  constructor(canvas: HTMLCanvasElement, onTelemetry: (telemetry: DriveTelemetry) => void, onCameraView: (view: CameraView) => void = () => {},
    onMapPosition: (x: number, z: number, yaw: number, traffic: readonly TrafficMarker[], parked?: TrafficMarker) => void = () => {},
    options: { onGraphicsStatus?: (status: GraphicsStatus) => void } = {}) {
    this.onTelemetry = onTelemetry;
    this.onCameraView = onCameraView;
    this.onMapPosition = onMapPosition;
    this.onGraphicsStatus = options.onGraphicsStatus ?? (() => {});
    this.scene.background = new THREE.Color(0x070c19);
    this.scene.fog = new THREE.FogExp2(0x111c2d, 0.00215);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    const context = this.renderer.getContext();
    const gpuInfo = context.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gpuInfo ? String(context.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL)) : '';
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    this.recommendedGraphics = recommendGraphicsQuality(gpuName, navigator.hardwareConcurrency || 4, memory,
      /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
    const preference = loadGraphicsPreference(this.recommendedGraphics);
    this.graphicsQuality = preference.preset;
    this.automaticGraphics = preference.automatic;
    this.renderer.setPixelRatio(this.renderPixelRatio());
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.environment = cityEnvironment(this.renderer);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = .7;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new NeonBloomPass(new THREE.Vector2(1, 1), .46, .48, 1.12);
    this.presentationPass.uniforms.tBloom.value = this.bloomPass.bloomTexture;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.presentationPass);
    this.carRig = makeCar();
    this.car = this.carRig.car;
    this.wheelMeshes = this.carRig.wheels;
    this.brakeLights = this.carRig.brakeLights;
    this.exhaustMeshes = this.carRig.exhausts;
    this.headlights = this.carRig.headlights;
    this.underglow = this.carRig.underglow;
    this.muzzleFlashes = this.carRig.muzzleFlashes;
    this.brakeDiscs = this.carRig.brakeDiscs;
    this.reverseLights = this.carRig.reverseLights;
    this.gunBarrels = this.carRig.gunBarrels;
    this.glowMap = makeGlowTexture();

    this.createWorld();
    this.collisionWorld = collectWorldColliders(this.scene, this.colliders);
    // Orbit can rise above the car: include solid ceilings and bridges that driving collisions intentionally omit.
    const cameraSolids = [...this.colliders], cameraBounds = new THREE.Box3();
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || object.userData.dynamic ||
        Array.isArray(object.material) || object.material.transparent ||
        object.geometry.type === 'ExtrudeGeometry' || object.geometry.type === 'TorusGeometry') return;
      object.geometry.computeBoundingBox();
      if (!object.geometry.boundingBox) return;
      cameraBounds.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
      if (cameraBounds.min.y <= 1.6 || cameraBounds.min.y > 32 || cameraBounds.max.y - cameraBounds.min.y < .03) return;
      if (this.collisionWorld.query(cameraBounds.min, cameraBounds.max).some(solid =>
        solid.x - solid.hx <= cameraBounds.min.x && solid.x + solid.hx >= cameraBounds.max.x &&
        solid.z - solid.hz <= cameraBounds.min.z && solid.z + solid.hz >= cameraBounds.max.z &&
        (solid.minY ?? 0) <= cameraBounds.min.y && (solid.maxY ?? Infinity) >= cameraBounds.max.y)) return;
      cameraSolids.push({ x: (cameraBounds.min.x + cameraBounds.max.x) / 2, z: (cameraBounds.min.z + cameraBounds.max.z) / 2,
        hx: (cameraBounds.max.x - cameraBounds.min.x) / 2, hz: (cameraBounds.max.z - cameraBounds.min.z) / 2,
        minY: cameraBounds.min.y, maxY: cameraBounds.max.y });
    });
    for (const covered of this.coveredRoads) cameraSolids.push({ ...covered, minY: covered.ceiling - .5, maxY: covered.ceiling + .6 });
    this.cameraCollisionWorld = new ColliderGrid(cameraSolids);
    this.updateStreetLights = poolStreetLights(this.scene);
    batchArchitecture(this.scene);
    this.updateCityVisibility = cityVisibility(this.scene);
    this.scene.updateMatrixWorld(true);
    this.scene.traverse(object => {
      if (object.userData.cityBounds || object.userData.cityInstanceCells) {
        object.updateMatrix(); object.matrixAutoUpdate = false; object.matrixWorldAutoUpdate = false;
      }
      if (object instanceof THREE.Mesh && !Array.isArray(object.material) && !object.material.transparent) {
        object.receiveShadow = object.material instanceof THREE.MeshStandardMaterial;
        object.castShadow = !object.userData.noCastShadow && !object.material.userData.noCastShadow &&
          (object.material instanceof THREE.MeshStandardMaterial || !!(object.material as THREE.MeshBasicMaterial).map);
      }
    });
    this.island = addIslandEnvironment(this.scene);
    this.reflections = wetStreetReflection(this.scene);
    this.scene.add(this.car);
    this.steam = addSteam(this.scene);
    this.flying = addFlyingVehicles(this.scene);
    this.roadSnow = addRoadSnow(this.scene, this.coveredRoads);
    this.snowbanks = this.roadSnow.banks;
    this.snowTracks = addSnowTracks(this.scene, this.roadSnow.sample);
    this.roadSkidMarks = addRoadSkidMarks(this.scene);
    this.snowfall = addFallingSnow(this.scene, this.coveredRoads);
    this.traffic = new AiTraffic(this.scene, this.carRig, this.collisionWorld, this.roadSnow.sample);
    this.person = new PersonController(this.scene, this.cameraCollisionWorld, (x, z) => this.roadSnow.sample(x, z).height,
      this.carRig.body, this.carRig.cockpit.steeringWheel);
    this.person.resetDriving(this.carPosition, this.yaw);
    this.pedestrians = new AiPedestrians(this.scene, cameraSolids, (x, z) => this.roadSnow.sample(x, z).height);
    this.pedestrians.update(0, this.carPosition, this.graphicsQuality);
    this.updateWheelContacts();
    this.updateSnow();

    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    this.exhaustParticles = new THREE.Points(
      this.particleGeometry,
      new THREE.PointsMaterial({
        color: 0xffffff,
        map: this.glowMap,
        vertexColors: true,
        size: 0.29,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.exhaustParticles.frustumCulled = false;
    this.scenePointMaterials.push({ material: this.exhaustParticles.material as THREE.PointsMaterial, size: .29 });
    this.scene.add(this.exhaustParticles);
    // ── Bullet trail line segments ──
    this.bulletGeometry.setAttribute('position', new THREE.BufferAttribute(this.bulletPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.bulletGeometry.setAttribute('color', new THREE.BufferAttribute(this.bulletColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.bulletTrails = new THREE.LineSegments(
      this.bulletGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        linewidth: 2,
      }),
    );
    this.bulletTrails.frustumCulled = false;
    this.bulletGeometry.setDrawRange(0, 0); this.bulletTrails.visible = false;
    this.scene.add(this.bulletTrails, this.carRig.miniguns.casingMesh);
    // ── Gun smoke particle system ──
    this.smokeGeometry.setAttribute('position', new THREE.BufferAttribute(this.smokePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeometry.setAttribute('particleSize', new THREE.BufferAttribute(this.smokeSizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeometry.setAttribute('particleOpacity', new THREE.BufferAttribute(this.smokeOpacities, 1).setUsage(THREE.DynamicDrawUsage));
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = smokeCanvas.height = 128;
    const sCtx = smokeCanvas.getContext('2d')!;
    const cloud = sCtx.createImageData(128, 128);
    // Layered, irregular density rather than a stack of circular smoke discs.
    const density = (x: number, y: number, scale: number) => {
      const a = x / scale, b = y / scale, ix = Math.floor(a), iy = Math.floor(b);
      const hash = (u: number, v: number) => { const n = Math.sin(u * 127.1 + v * 311.7) * 43758.5453; return n - Math.floor(n); };
      const fx = (a - ix) ** 2 * (3 - 2 * (a - ix)), fy = (b - iy) ** 2 * (3 - 2 * (b - iy));
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), fx), THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx), fy);
    };
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const radius = Math.hypot((x - 64) / 64, (y - 64) / 64), index = (y * 128 + x) * 4;
      const n = .5 * density(x, y, 24) + .3 * density(x, y, 12) + .2 * density(x, y, 5);
      cloud.data[index] = cloud.data[index + 1] = cloud.data[index + 2] = 185 + n * 45;
      cloud.data[index + 3] = 255 * Math.exp(-radius * radius * 2.8) * Math.max(0, 1 - radius ** 4) * (.55 + n * .65);
    }
    sCtx.putImageData(cloud, 0, 0);
    const smokeTexture = new THREE.CanvasTexture(smokeCanvas);
    smokeTexture.colorSpace = THREE.SRGBColorSpace;
    const smokeMaterial = new THREE.PointsMaterial({
      map: smokeTexture,
      color: 0xc3cbd0,
      size: 0.8,
      transparent: true,
      opacity: 0.95,
      blending: THREE.NormalBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    smokeMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float particleSize;\nattribute float particleOpacity;\nvarying float vOpacity;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        'gl_PointSize = size;',
        'gl_PointSize = particleSize;\nvOpacity = particleOpacity;'
      );
      shader.fragmentShader = 'varying float vOpacity;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <premultiplied_alpha_fragment>',
        'gl_FragColor.a *= vOpacity;\n#include <premultiplied_alpha_fragment>'
      );
    };
    this.smokeMesh = new THREE.Points(this.smokeGeometry, smokeMaterial);
    this.smokeMesh.frustumCulled = false;
    this.smokeGeometry.setDrawRange(0, 0); this.smokeMesh.visible = false;
    this.scene.add(this.smokeMesh);
    this.camera.position.set(-22, 6, -8);
    this.camera.lookAt(0, 1.2, -2.2);
    this.resize();
    // Prepare dormant weapons and nitro in the composer's color space before play.
    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.renderTarget1);
    for (const effect of [this.carRig.nitroEffects.mesh, ...this.muzzleFlashes,
      this.carRig.miniguns.glow, this.carRig.miniguns.casingMesh, this.bulletTrails, this.smokeMesh]) {
      this.renderer.compile(effect, this.camera, this.scene);
    }
    this.renderer.setRenderTarget(previousTarget);
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('keydown', this.keyDownHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    window.addEventListener('blur', this.blurHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    canvas.addEventListener('pointerdown', this.pointerDownHandler);
    canvas.addEventListener('pointermove', this.pointerMoveHandler);
    canvas.addEventListener('pointerup', this.pointerUpHandler);
    canvas.addEventListener('pointercancel', this.pointerUpHandler);
    canvas.addEventListener('lostpointercapture', this.pointerUpHandler);
    canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
    this.animationFrame = requestAnimationFrame(this.frameHandler);
  }

  private animationFrame = 0;

  private createWorld() {
    // The camera-centered island sky supplies the full background, including the aurora.
    // Broad sky and pavement bounce keep dark clothing and the car's shaded
    // panels readable without lifting the neon or washing out the night sky.
    const hemisphere = new THREE.HemisphereLight(0xb3c9e3, 0x48404c, 1.2);
    hemisphere.name = 'City / soft night sky and ground bounce';
    this.scene.add(hemisphere);
    const ambient = new THREE.AmbientLight(0x8895aa, .32);
    ambient.name = 'City / low ambient fill';
    this.scene.add(ambient);
    // Fill from the opposite side of the moon: both former directionals lit
    // the rear of the car, leaving faces and the front fascia in deep shadow.
    const streetFill = new THREE.DirectionalLight(0xdac4b3, .85);
    streetFill.name = 'City / warm street fill';
    streetFill.position.set(-36, 26, -42);
    this.scene.add(streetFill);
    const cyanMoon = new THREE.DirectionalLight(0xc2d5ec, 1.45);
    cyanMoon.name = 'City / cool moon key';
    cyanMoon.position.set(72, 74, -88);
    this.keyLight = cyanMoon;
    cyanMoon.castShadow = true;
    cyanMoon.shadow.mapSize.set(1024, 1024);
    Object.assign(cyanMoon.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 110 });
    cyanMoon.shadow.normalBias = .045;
    cyanMoon.shadow.bias = -.00015;
    this.scene.add(cyanMoon, cyanMoon.target);

    const roadTexture = makeRoadTexture();
    const acrossTexture = roadTexture.clone();
    acrossTexture.repeat.set(CITY_SPAN / 22, ROAD_WIDTH / 22);
    acrossTexture.needsUpdate = true;
    const alongTexture = roadTexture.clone();
    alongTexture.repeat.set(ROAD_WIDTH / 22, CITY_SPAN / 22);
    alongTexture.needsUpdate = true;
    const wetRoadAcross = new THREE.MeshStandardMaterial({
      color: 0x3c4147,
      map: acrossTexture,
      bumpMap: acrossTexture,
      bumpScale: .025,
      metalness: .025,
      roughness: .72,
      envMapIntensity: .18,
    });
    const wetRoadAlong = wetRoadAcross.clone();
    wetRoadAlong.map = alongTexture;
    wetRoadAlong.bumpMap = alongTexture;
    finishNightRoad(wetRoadAcross);
    finishNightRoad(wetRoadAlong);
    const puddleGeometry = new THREE.CircleGeometry(1, 14);
    const puddleMaterial = new THREE.MeshStandardMaterial({
      color: 0x131a21,
      metalness: .12,
      roughness: .38,
      envMapIntensity: 0,
      transparent: true,
      opacity: .2,
      depthWrite: false,
    });
    const puddles = new THREE.InstancedMesh(puddleGeometry, puddleMaterial, 180);
    const puddleRandom = rng(13514);
    const puddleMatrix = new THREE.Matrix4();
    for (let i = 0; i < 180; i += 1) {
      const line = ROAD_COORDS[Math.floor(puddleRandom() * ROAD_COORDS.length)];
      const across = puddleRandom() > 0.5;
      const along = -CITY_SPAN / 2 + puddleRandom() * CITY_SPAN;
      const radius = 0.35 + puddleRandom() * 1.7;
      puddleMatrix.compose(
        new THREE.Vector3(
          across ? along : line + (puddleRandom() - 0.5) * 12,
          0.022,
          across ? line + (puddleRandom() - 0.5) * 12 : along,
        ),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
        new THREE.Vector3(radius * (0.8 + puddleRandom()), radius * 0.35, 1),
      );
      puddles.setMatrixAt(i, puddleMatrix);
    }
    this.scene.add(puddles);

    const horizontalStreets: THREE.Mesh[] = [];
    for (const road of ROAD_COORDS) {
      const horizontal = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY_SPAN, ROAD_WIDTH),
        wetRoadAcross,
      );
      horizontal.rotation.x = -Math.PI / 2;
      horizontal.position.set(0, 0.008, road);
      horizontalStreets.push(horizontal);
      const vertical = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_WIDTH, CITY_SPAN),
        wetRoadAlong,
      );
      vertical.rotation.x = -Math.PI / 2;
      vertical.position.set(road, 0.009, 0);
      horizontalStreets.push(vertical);
    }
    this.scene.add(...horizontalStreets);

    const lanePositions: number[] = [];
    const glowPositions: number[] = [];
    const coverage = CITY_SPAN / 2;
    for (const street of ROAD_COORDS) {
      for (let along = -coverage; along < coverage; along += 11) {
        if (ROAD_COORDS.some(cross => Math.abs(along + 2.6 - cross) < 11)) continue;
        for (const lane of [-4.4, 4.4]) {
          addQuad(lanePositions, along, street + lane - 0.055, along + 5.2, street + lane + 0.055, 0.034);
          addQuad(lanePositions, street + lane - 0.055, along, street + lane + 0.055, along + 5.2, 0.034);
        }
      }
      for (const side of [-1, 1]) {
        for (let along = -coverage; along < coverage; along += 32) {
          addQuad(glowPositions, along, street + side * 8.76 - 0.04, along + 18, street + side * 8.76 + 0.04, 0.035);
          addQuad(glowPositions, street + side * 8.76 - 0.04, along, street + side * 8.76 + 0.04, along + 18, 0.035);
        }
      }
    }
    const laneGeometry = new THREE.BufferGeometry();
    laneGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lanePositions, 3));
    laneGeometry.computeVertexNormals();
    const lanes = new THREE.Mesh(
      laneGeometry,
      new THREE.MeshBasicMaterial({ color: 0x8e979b, transparent: true, opacity: .7, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.scene.add(lanes);
    const curbGeometry = new THREE.BufferGeometry();
    curbGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
    curbGeometry.computeVertexNormals();
    const curbs = new THREE.Mesh(
      curbGeometry,
      new THREE.MeshBasicMaterial({ color: 0x19a8c9, transparent: true, opacity: 0.24, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.scene.add(curbs);

    const platformGeometry = new THREE.BoxGeometry(26, 0.24, 26);
    const platformMaterial = new THREE.MeshStandardMaterial({ color: 0x171e2b, metalness: 0.48, roughness: 0.7 });
    const platforms = new THREE.InstancedMesh(platformGeometry, platformMaterial, (ROAD_COORDS.length - 1) * (ROAD_COORDS.length - 1));
    platforms.count = 0;
    const platformMatrix = new THREE.Matrix4();
    for (const xRoad of ROAD_COORDS.slice(0, -1)) {
      for (const zRoad of ROAD_COORDS.slice(0, -1)) {
        platformMatrix.setPosition(xRoad + ROAD_STEP / 2, 0.12, zRoad + ROAD_STEP / 2);
        const index = platforms.count;
        platforms.setMatrixAt(index, platformMatrix);
        platforms.count += 1;
      }
    }
    this.scene.add(platforms);

    const styles = makeSkylineStyles();
    const skyline = [];
    let buildingIndex = 1;
    const signMaterials = new Map<string, THREE.MeshBasicMaterial>();
    for (const xRoad of ROAD_COORDS.slice(0, -1)) {
      for (const zRoad of ROAD_COORDS.slice(0, -1)) {
        const x = xRoad + ROAD_STEP / 2;
        const z = zRoad + ROAD_STEP / 2;
        const plan = planSkylineBuilding(x, z, buildingIndex);
        skyline.push(plan);
        addSkylineBuilding(this.scene, styles, this.colliders, plan, signMaterials);
        buildingIndex += 1;
      }
    }
    this.scene.userData.cyberpunkSkyline = skyline;
    platforms.instanceMatrix.needsUpdate = true;

    const stars = new Float32Array(600 * 3);
    const starRandom = rng(772);
    for (let i = 0; i < 600; i += 1) {
      stars[i * 3] = (starRandom() - 0.5) * 900;
      stars[i * 3 + 1] = 48 + starRandom() * 180;
      stars[i * 3 + 2] = (starRandom() - 0.5) * 420;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    const starsMesh = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xa7d4ff, size: 0.7, transparent: true, opacity: 0.64, sizeAttenuation: true }),
    );
    this.scenePointMaterials.push({ material: starsMesh.material, size: .7 });
    this.scene.add(starsMesh);
    addTunnel(this.scene, this.colliders);
    addSkyBridge(this.scene, -44, 0x26dcf1);
    addSkyBridge(this.scene, 132, 0xff47a8);
    addSkyBridge(this.scene, -220, 0x26dcf1);
    addSkyBridge(this.scene, 264, 0xff47a8);
    addSkyBridge(this.scene, -132, 0xff47a8);
    addSkyBridge(this.scene, 308, 0x26dcf1);
    addStreetlights(this.scene);
    addCityDetail(this.scene);
    this.coveredRoads.push(...addInfrastructure(this.scene, this.colliders));

    // ── Creative additions for the expanded city ──
    this.addHoloBillboards(styles);
    this.addNeonAvenues();
    this.addMonorail();
  }

  private addHoloBillboards(styles: FacadeStyle[]) {
    const transmissions = Array.from({ length: 4 }, (_, i) => new THREE.MeshBasicMaterial({
      map: makeHologramTexture(i), color: new THREE.Color(1.18, 1.18, 1.18),
      toneMapped: false, side: THREE.DoubleSide,
    }));
    const positions: [number, number][] = [
      [-176, -176], [176, 176], [-176, 176], [176, -176],
      [-264, 0], [264, 0], [0, -264], [0, 264],
      [-352, -88], [352, 88],
    ];
    positions.forEach(([x, z], i) => {
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      group.rotation.y = i % 4 * Math.PI / 2;
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.5, 20, 8),
        new THREE.MeshStandardMaterial({ color: 0x1a2840, metalness: 0.85, roughness: 0.3 }),
      );
      pylon.position.set(0, 10, -11.8);
      group.add(pylon);
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 8),
        transmissions[i % transmissions.length],
      );
      panel.position.set(0, 17, -12.35);
      panel.rotation.y = Math.PI;
      panel.name = 'Cyberpunk / civic transmission';
      group.add(panel);
      this.neonSigns.push(panel);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.5, 0.08, 8, 24),
        new THREE.MeshBasicMaterial({ color: styles[i % styles.length].trim, toneMapped: false }),
      );
      ring.position.set(0, 12.2, -11.8);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      this.scene.add(group);
    });
  }

  private addNeonAvenues() {
    const neonStripMaterial = new THREE.MeshBasicMaterial({
      color: 0x22ccee, transparent: true, opacity: 0.18, toneMapped: false, side: THREE.DoubleSide,
      depthWrite: false, forceSinglePass: true,
    });
    const pinkStripMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3388, transparent: true, opacity: 0.15, toneMapped: false, side: THREE.DoubleSide,
      depthWrite: false, forceSinglePass: true,
    });
    const cyanPositions: number[] = [];
    const pinkPositions: number[] = [];
    for (let seg = -CITY_SPAN / 2; seg < CITY_SPAN / 2; seg += 16) {
      addQuad(cyanPositions, seg + 1, -.06, seg + 15, .06, .04);
      addQuad(pinkPositions, -.06, seg + 1, .06, seg + 15, .04);
    }
    // Flat, separate quads need one transparent pass per avenue, with no per-strip sorting.
    for (const [positions, material] of [[cyanPositions, neonStripMaterial], [pinkPositions, pinkStripMaterial]] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      const strip = new THREE.Mesh(geometry, material);
      strip.name = 'City / batched avenue glow';
      this.scene.add(strip);
      strip.updateMatrix(); strip.updateMatrixWorld(true);
      strip.matrixAutoUpdate = false; strip.matrixWorldAutoUpdate = false;
    }
  }

  private addMonorail() {
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x1e2d40, metalness: 0.85, roughness: 0.28 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x32e8ff, toneMapped: false });
    const segments = 64;
    const radius = 310;
    const height = 28;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const length = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2);
      const angle = Math.atan2(x1 - x0, z1 - z0);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, length + 0.5), railMaterial);
      beam.position.set(mx, height, mz);
      beam.rotation.y = angle;
      this.scene.add(beam);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, length + 0.5), glowMat);
      glow.position.set(mx, height - 0.34, mz);
      glow.rotation.y = angle;
      this.scene.add(glow);
      if (i % 4 === 0 && !occupiesRoad(x0, z0, 1.1)) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, height, 8), railMaterial);
        pillar.position.set(x0, height / 2, z0);
        this.scene.add(pillar);
        const baseRing = new THREE.Mesh(
          new THREE.TorusGeometry(1.0, 0.06, 6, 16),
          i % 8 === 0 ? glowMat : new THREE.MeshBasicMaterial({ color: 0xff3fa0, toneMapped: false }),
        );
        baseRing.position.set(x0, 0.1, z0);
        baseRing.rotation.x = Math.PI / 2;
        this.scene.add(baseRing);
      }
    }
  }

  private updateWheelContacts() {
    const cosine = Math.cos(this.yaw), sine = Math.sin(this.yaw);
    for (let i = 0; i < WHEEL_CONTACTS.length; i++) {
      const local = WHEEL_CONTACTS[i], c = this.wheelContacts[i];
      this.roadSnow.sample(this.carPosition.x + cosine * local.x + sine * local.z, this.carPosition.z - sine * local.x + cosine * local.z, c);
      const compacted = this.snowTracks.compactionAt(c.x, c.z);
      c.height -= Math.min(.02, c.depth * .2) * compacted;
      c.depth *= 1 - compacted * .25;
      c.grip += .045 * compacted * c.coverage;
    }
  }

  private updateSnow(delta = 0) {
    const focus = this.person && this.person.mode !== 'driving' ? this.person.position : this.carPosition;
    this.roadSnow.update(focus);
    const height = window.innerHeight * this.scenePixelRatio;
    this.snowfall.update(this.elapsed, focus, this.person?.mode === 'walking' ? this.personCameraYaw : this.yaw, height);
    this.snowTracks.update(this.elapsed, this.wheelContacts, this.yaw, this.velocity.length(), Math.abs(this.velocity.dot(this.right)), height, delta);
  }

  private onKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (!this.active || event.defaultPrevented || event.target instanceof Element &&
      event.target.closest('button, input, select, textarea, a, [contenteditable="true"], dialog')) return;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f', 'c', 'o', 'p', 'e', 'shift', '+', '=', '-'].includes(key)) event.preventDefault();
    const firstPress = !event.repeat && !this.pressed.has(key);
    if ((key === 's' || key === 'arrowdown') && !event.repeat && !this.pressed.has('s') && !this.pressed.has('arrowdown')) {
      this.reverseEngaged = this.velocity.length() < .3;
    }
    this.pressed.add(key);
    if (key === 'e' && firstPress) this.interactVehicle();
    if ((key === 'p' || key === 'shift') && firstPress) this.activateNitro();
    if (key === 'r' && !event.repeat) this.reset();
    if (key === 'c' && !event.repeat) this.toggleCameraView();
    if (key === 'o' && !event.repeat) this.toggleOrbitView();
  }

  private onKeyUp(event: KeyboardEvent) {
    this.pressed.delete(event.key.toLowerCase());
    if (!this.pressed.has('s') && !this.pressed.has('arrowdown')) this.reverseEngaged = false;
  }

  setDriving(active: boolean) {
    this.active = active;
    this.cancelNitro();
    if (!active) this.resetWeapons();
    this.pressed.clear();
    this.previousTime = 0;
    this.physicsAccumulator = 0;
    if (active) {
      this.audio.start();
      this.renderer.domElement.focus({ preventScroll: true });
    }
  }

  audioDiagnostics() { return this.audio.diagnostics(); }

  suspendControls() { this.blurHandler(); this.resetWeapons(); }

  getGraphicsStatus(): GraphicsStatus {
    return { preset: this.graphicsQuality, recommended: this.recommendedGraphics, automatic: this.automaticGraphics,
      fps: this.measuredFps, resolutionScale: this.scenePixelRatio };
  }

  setGraphicsQuality(preset: GraphicsQuality) {
    if (!isGraphicsQuality(preset)) return;
    this.graphicsQuality = preset;
    // A deliberate selection stays exact until the player enables adaptation.
    this.automaticGraphics = false;
    this.qualityLevel = 0;
    saveGraphicsPreference(preset, this.automaticGraphics);
    this.resize();
  }

  setAutomaticGraphics(enabled: boolean) {
    this.automaticGraphics = enabled;
    this.qualityLevel = 0;
    saveGraphicsPreference(this.graphicsQuality, enabled);
    this.resize();
  }

  interactVehicle() {
    if (!this.active) return false;
    const accepted = this.person.interact(this.carPosition, this.yaw, this.velocity.length());
    if (accepted) {
      this.cancelNitro(); this.resetWeapons();
      this.velocity.set(0, 0, 0);
      this.vehicleMotion.acceleration = this.vehicleMotion.yawRate = 0;
      this.physicsAccumulator = 0; this.steerInput = 0; this.reverseEngaged = false;
      if (this.person.mode === 'exiting') {
        if (this.cameraView === 'chase' || this.cameraView === 'driver') this.drivingCamera = this.cameraView;
        this.personCameraYaw = this.yaw;
        this.personCameraElevation = .22;
        this.setCameraView('person');
      }
      this.lastTelemetry = { speed: 0, boost: this.boostCharge / 100, drifting: false, boosting: false, firing: false, person: this.person.telemetry };
      this.onTelemetry(this.lastTelemetry);
    }
    this.renderer.domElement.focus({ preventScroll: true });
    return accepted;
  }

  activateNitro() {
    if (!this.active || this.person.mode !== 'driving' || this.cameraView === 'orbit' || this.nitroRemaining > 0 || this.boostCharge < 99.999 ||
      this.pressed.has('s') || this.pressed.has('arrowdown') || this.pressed.has(' ')) return false;
    const longitudinal = -this.velocity.x * Math.sin(this.yaw) - this.velocity.z * Math.cos(this.yaw);
    const accelerating = this.pressed.has('w') || this.pressed.has('arrowup');
    if (longitudinal < -.05 || this.reverseEngaged || longitudinal <= 0 && !accelerating) return false;
    this.nitroTargetSpeed = Math.min(MAX_NITRO_SPEED_KMH / 3.6,
      Math.max(accelerating ? 1 : 0, this.velocity.length() * NITRO_SPEED_MULTIPLIER));
    this.nitroRemaining = 3;
    return true;
  }

  private cancelNitro() {
    this.nitroRemaining = 0;
    this.nitroTargetSpeed = 0;
    this.carRig.nitroEffects.reset();
    this.lastTelemetry.boosting = false;
  }

  toggleCameraView() {
    if (this.person.mode !== 'driving') return;
    this.setCameraView(this.cameraView === 'chase' ? 'driver' : 'chase');
  }

  toggleOrbitView() {
    if (this.person.mode !== 'driving') return;
    if (this.cameraView === 'orbit') this.setCameraView(this.drivingCamera);
    else {
      this.drivingCamera = this.cameraView === 'driver' ? 'driver' : 'chase';
      this.orbitAzimuth = .65; this.orbitElevation = .25; this.orbitDistance = 7.2;
      this.setCameraView('orbit');
    }
  }

  private setCameraView(view: CameraView) {
    this.cameraView = view;
    this.person?.setDriverView(view === 'driver' && this.person.mode === 'driving');
    if (view === 'orbit') this.cancelNitro();
    this.orbitPointers.clear();
    this.pressed.clear();
    this.renderer.domElement.style.touchAction = view === 'orbit' || view === 'person' ? 'none' : '';
    this.renderer.domElement.style.cursor = view === 'orbit' || view === 'person' ? 'grab' : '';
    this.camera.near = view === 'driver' ? .025 : .1;
    this.camera.fov = view === 'driver' ? this.driverCameraFov() : view === 'orbit' ? 50 : 66;
    this.camera.updateProjectionMatrix();
    this.carRig.cockpit.refresh(this.lastTelemetry);
    this.updateCamera(0, true);
    this.onCameraView(this.cameraView);
    this.renderer.domElement.focus({ preventScroll: true });
  }

  private onOrbitPointerDown(event: PointerEvent) {
    if ((this.cameraView !== 'orbit' && this.cameraView !== 'person') || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    this.orbitPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.focus({ preventScroll: true });
  }

  private onOrbitPointerMove(event: PointerEvent) {
    const point = this.orbitPointers.get(event.pointerId);
    if (!point || (this.cameraView !== 'orbit' && this.cameraView !== 'person')) return;
    event.preventDefault();
    if (this.cameraView === 'person') {
      this.personCameraYaw -= (event.clientX - point.x) * .006;
      this.personCameraElevation = THREE.MathUtils.clamp(this.personCameraElevation + (event.clientY - point.y) * .004, -.10, .82);
      point.x = event.clientX; point.y = event.clientY;
      return;
    }
    if (this.orbitPointers.size > 1) {
      const other = Array.from(this.orbitPointers.entries()).find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(point.x - other.x, point.y - other.y);
        const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        if (before > 1 && after > 1) this.orbitDistance = THREE.MathUtils.clamp(this.orbitDistance * before / after, 3.8, 12);
      }
    } else {
      this.orbitAzimuth -= (event.clientX - point.x) * .007;
      this.orbitElevation = THREE.MathUtils.clamp(this.orbitElevation + (event.clientY - point.y) * .005, .04, 1.42);
    }
    point.x = event.clientX; point.y = event.clientY;
  }

  private driverCameraFov() {
    // A portrait screen still needs enough horizontal view for both hands.
    const aspect = Math.max(.2, this.camera.aspect);
    return Math.max(72, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 6) / aspect)));
  }

  private updateCamera(delta: number, snap = false) {
    this.camera.up.copy(this.cameraUp);
    if (snap) {
      this.reflections.invalidate();
      this.shadowPosition.set(Infinity, Infinity, Infinity); this.shadowFrame = 0;
    }
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speedRatio = Math.min(this.velocity.length() / 76, 1);
    const driver = this.cameraView === 'driver';
    if (this.cameraView === 'person') {
      this.cameraTarget.copy(this.person.position); this.cameraTarget.y += 1.14;
      const distance = this.personCameraDistance * Math.max(1, .82 / this.camera.aspect);
      const horizontal = Math.cos(this.personCameraElevation) * distance;
      this.desiredCamera.set(this.cameraTarget.x + Math.sin(this.personCameraYaw) * horizontal,
        this.cameraTarget.y + Math.sin(this.personCameraElevation) * distance,
        this.cameraTarget.z + Math.cos(this.personCameraYaw) * horizontal);
      let limit = 1;
      for (const solid of this.cameraCollisionWorld.query(this.cameraTarget, this.desiredCamera)) limit = Math.min(limit, cameraWallEntry(this.cameraTarget, this.desiredCamera, solid));
      this.desiredCamera.lerp(this.cameraTarget, 1 - limit);
      this.desiredCamera.y = Math.max(this.desiredCamera.y, this.roadSnow.sample(this.desiredCamera.x, this.desiredCamera.z).height + .22);
      if (snap) this.camera.position.copy(this.desiredCamera);
      else this.camera.position.lerp(this.desiredCamera, 1 - Math.exp(-delta * 12));
      // The smoothed orbit can cut across a corner even when its endpoint is clear.
      let actualLimit = 1;
      for (const solid of this.cameraCollisionWorld.query(this.cameraTarget, this.camera.position)) actualLimit = Math.min(actualLimit, cameraWallEntry(this.cameraTarget, this.camera.position, solid));
      this.camera.position.lerp(this.cameraTarget, 1 - actualLimit);
      this.camera.lookAt(this.cameraTarget);
      return;
    }
    if (this.cameraView === 'orbit') {
      this.orbitAzimuth += ((this.pressed.has('arrowright') ? 1 : 0) - (this.pressed.has('arrowleft') ? 1 : 0)) * delta * 1.6;
      this.orbitElevation = THREE.MathUtils.clamp(this.orbitElevation + ((this.pressed.has('arrowup') ? 1 : 0) - (this.pressed.has('arrowdown') ? 1 : 0)) * delta, .04, 1.42);
      const zoom = (this.pressed.has('-') ? 1 : 0) - (this.pressed.has('+') || this.pressed.has('=') ? 1 : 0);
      this.orbitDistance = THREE.MathUtils.clamp(this.orbitDistance * Math.exp(zoom * delta), 3.8, 12);
      const distance = this.orbitDistance * Math.max(1, 1 / this.camera.aspect);
      const angle = this.orbitAzimuth + this.yaw;
      const horizontal = Math.cos(this.orbitElevation) * distance;
      this.cameraTarget.copy(this.carPosition); this.cameraTarget.y += .76;
      this.desiredCamera.set(this.cameraTarget.x + Math.sin(angle) * horizontal,
        this.cameraTarget.y + Math.sin(this.orbitElevation) * distance, this.cameraTarget.z + Math.cos(angle) * horizontal);
      // A small camera sphere stops at nearby walls without scanning the whole city.
      let limit = 1;
      for (const solid of this.cameraCollisionWorld.query(this.cameraTarget, this.desiredCamera)) {
        limit = Math.min(limit, cameraWallEntry(this.cameraTarget, this.desiredCamera, solid));
      }
      this.desiredCamera.lerp(this.cameraTarget, 1 - limit);
      // Immediate input keeps every angle directly inspectable, including the roof.
      this.camera.position.copy(this.desiredCamera);
      this.camera.lookAt(this.cameraTarget);
      return;
    }
    if (driver) {
      // Use the same suspension transform as the dashboard. A yaw-only seat
      // leaves the cabin moving around the eye whenever the body pitches/rolls.
      this.carRig.body.updateWorldMatrix(true, false);
      this.camera.position.copy(this.carRig.cockpit.eye).applyMatrix4(this.carRig.body.matrixWorld);
      this.cameraOffset.set(0, 0, -1).transformDirection(this.carRig.body.matrixWorld);
      this.camera.up.set(0, 1, 0).transformDirection(this.carRig.body.matrixWorld);
      this.cameraTarget.copy(this.camera.position).addScaledVector(this.cameraOffset, 30)
        .addScaledVector(this.right, -this.steerInput * speedRatio * .45);
      // Include the closer steering rim and both gripping hands below the road.
      this.cameraTarget.addScaledVector(this.camera.up, -11.0);
    } else {
      this.cameraTarget.copy(this.carPosition).addScaledVector(this.forward, 2.2);
      this.cameraTarget.y += 1.3;
      this.desiredCamera.copy(this.carPosition)
        .addScaledVector(this.forward, -(8.4 + speedRatio * 1.6))
        .addScaledVector(this.right, -this.steerInput * speedRatio * (this.lastTelemetry.drifting ? .42 : .14));
      this.desiredCamera.y += 3.1 + speedRatio * .45 + Math.sin(this.elapsed * 19) * speedRatio * (this.lastTelemetry.boosting ? .08 : .018);
      if (snap) this.camera.position.copy(this.desiredCamera);
      else {
        this.camera.position.addScaledVector(this.velocity, delta);
        this.camera.position.lerp(this.desiredCamera, 1 - Math.exp(-delta * 5.3));
      }
    }
    this.camera.lookAt(this.cameraTarget);
    const targetFov = (driver ? this.driverCameraFov() : 66) + speedRatio * (driver ? 3 : 7) + (this.lastTelemetry.boosting ? (driver ? 2 : 5) : 0);
    const nextFov = snap ? targetFov : this.camera.fov + (targetFov - this.camera.fov) * (1 - Math.exp(-delta * 2.2));
    if (Math.abs(nextFov - this.camera.fov) > .0001) { this.camera.fov = nextFov; this.camera.updateProjectionMatrix(); }
  }

  private reset() {
    this.carPosition.set(-22, 0.015, -22);
    this.car.position.copy(this.carPosition);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.vehicleMotion.yaw = 0; this.vehicleMotion.yawRate = 0; this.vehicleMotion.steeringAngle = 0;
    this.vehicleMotion.acceleration = 0; this.physicsAccumulator = 0; this.reverseEngaged = false;
    this.suspensionVelocity = 0; this.snowTracks.resetContinuity();
    this.roadSkidMarks.resetContinuity(); this.tireFeedback.reset();
    this.car.rotation.set(0, 0, 0);
    this.carRig.body.rotation.set(0, 0, 0);
    this.carRig.body.position.y = 0;
    this.person.resetDriving(this.carPosition, this.yaw);
    this.carRig.driverDoor.rotation.y = 0;
    this.lastPersonMode = 'driving';
    if (this.cameraView === 'person') this.setCameraView(this.drivingCamera);
    this.particles.length = 0;
    this.pressed.clear();
    this.steerInput = 0;
    this.boostCharge = 100;
    this.cancelNitro();
    this.carRig.cockpit.steeringWheel.rotation.z = 0;
    this.updateCamera(0, true);
    this.resetWeapons();
    for (const flash of this.muzzleFlashes) flash.visible = false;
    this.lastTelemetry = { speed: 0, boost: 1, drifting: false, boosting: false, firing: false, person: this.person.telemetry };
    this.carRig.cockpit.refresh(this.lastTelemetry);
    this.onTelemetry(this.lastTelemetry);
    this.onMapPosition(this.carPosition.x, this.carPosition.z, this.yaw, this.traffic.markers);
  }

  private renderPixelRatio() {
    const profile = GRAPHICS_PRESETS[this.graphicsQuality];
    const pressureScale = Math.sqrt([1, .78, .60, .46, .35][this.qualityLevel]);
    return Math.min((window.devicePixelRatio || 1) * profile.renderScale, profile.maxPixelRatio,
      Math.sqrt(profile.pixelBudget / Math.max(1, window.innerWidth * window.innerHeight))) * pressureScale;
  }

  private updateTextureQuality() {
    const anisotropy = Math.min(GRAPHICS_PRESETS[this.graphicsQuality].anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const key of ['map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap']) {
          const texture = (material as unknown as Record<string, unknown>)[key];
          if (!(texture instanceof THREE.Texture) || this.configuredTextures.get(texture) === anisotropy) continue;
          texture.anisotropy = anisotropy; texture.needsUpdate = true;
          this.configuredTextures.set(texture, anisotropy);
        }
      }
    });
  }

  private updateRenderQuality(frameMs: number, delta: number) {
    // Ignore shader warmup, background tabs and isolated long pauses. Measure
    // sustained frame cost so one collision or a resize cannot lower quality.
    if (document.hidden || this.elapsed < Math.max(this.qualityWarmup, this.qualityResumeTime) || delta <= 0) return;
    const sampleMs = Math.min(frameMs, 500);
    this.qualitySampleTime += sampleMs / 1000;
    this.qualitySampleFrames++;
    this.qualitySampleMs += sampleMs;
    if (frameMs > 25) this.qualitySampleSlowFrames++;
    const severePressure = this.qualitySampleMs / this.qualitySampleFrames > 45;
    if (this.qualitySampleTime < 4 || this.qualitySampleFrames < (severePressure ? 15 : 60)) return;
    this.averageFrame = this.qualitySampleMs / this.qualitySampleFrames;
    this.measuredFps = Math.round(1000 / Math.max(1, this.averageFrame));
    // Include textures from asynchronously loaded car and character models.
    this.updateTextureQuality();
    const slowFrameRatio = this.qualitySampleSlowFrames / this.qualitySampleFrames;
    let next = this.qualityLevel;
    // A few deferred reflection captures or new shaders are not sustained overload.
    // Require two sampling windows before reducing effects, one step at a time.
    const pressure = this.averageFrame > 22 || slowFrameRatio > .18;
    this.qualityPressureTime = pressure ? this.qualityPressureTime + this.qualitySampleTime : 0;
    if (this.automaticGraphics && (this.qualityPressureTime >= 8 || this.averageFrame > 45) && next < 4) {
      next++;
      this.qualityPressureTime = 0;
      this.qualityRecoveryTime = 0;
    } else if (this.automaticGraphics && this.averageFrame < 17.8 && slowFrameRatio < .04 && next > 0) {
      this.qualityRecoveryTime += this.qualitySampleTime;
      if (this.qualityRecoveryTime >= 12) { next--; this.qualityRecoveryTime = 0; }
    } else this.qualityRecoveryTime = 0;
    this.qualitySampleTime = 0; this.qualitySampleFrames = 0; this.qualitySampleMs = 0;
    this.qualitySampleSlowFrames = 0;
    if (next === this.qualityLevel) { this.onGraphicsStatus(this.getGraphicsStatus()); return; }
    this.qualityLevel = next;
    this.resize();
  }

  private resize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const profile = GRAPHICS_PRESETS[this.graphicsQuality];
    this.scenePixelRatio = this.renderPixelRatio();
    this.qualityResumeTime = this.elapsed + 2;
    this.qualitySampleTime = 0; this.qualitySampleFrames = 0;
    this.qualitySampleMs = 0; this.qualitySampleSlowFrames = 0;
    this.qualityPressureTime = 0; this.qualityRecoveryTime = 0;
    // Present the low-resolution scene at a modestly higher resolution so the
    // edge/detail resolve can reconstruct it before the browser stretches the canvas.
    const presentationRatio = Math.min((window.devicePixelRatio || 1) * profile.renderScale, profile.maxPixelRatio,
      Math.max(this.scenePixelRatio, Math.sqrt(650_000 / (width * height))));
    this.renderer.setPixelRatio(presentationRatio);
    // Built-in point shaders use the renderer's ratio, even inside the composer.
    // Keep their projected size tied to the scene buffer during reconstruction.
    for (const point of this.scenePointMaterials) point.material.size = point.size * this.scenePixelRatio / presentationRatio;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(this.scenePixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.presentationPass.setPreset(this.graphicsQuality, this.qualityLevel);
    this.island.aurora.setQuality(this.graphicsQuality === 'low' ? 3 : this.graphicsQuality === 'medium' ? 2 : 0);
    // Glow is built in five small draws and added in the existing output draw.
    // Its appearance stays consistent instead of switching off while driving.
    this.bloomPass.enabled = true;
    this.bloomPass.strength = profile.bloomStrength;
    this.bloomPass.radius = this.graphicsQuality === 'ultra' ? .42 : .48;
    this.bloomPass.setQuality(profile.bloomResolution);
    this.presentationPass.uniforms.bloomEnabled.value = 1;
    this.bloomPass.setSize(width * this.scenePixelRatio, height * this.scenePixelRatio);
    this.reflections.setPreset(this.graphicsQuality, this.qualityLevel);
    this.reflections.invalidate();
    // Retain shadows at every tier; reduce their capture size and refresh rate.
    this.renderer.shadowMap.enabled = true;
    const shadowSize = Math.max(256, Math.round(profile.shadowSize / (1 + this.qualityLevel * .3)));
    if (this.keyLight.shadow.mapSize.x !== shadowSize) {
      this.keyLight.shadow.mapSize.set(shadowSize, shadowSize);
      this.keyLight.shadow.map?.dispose(); this.keyLight.shadow.map = null;
    }
    this.shadowPosition.set(Infinity, Infinity, Infinity); this.shadowFrame = 0;
    this.renderer.shadowMap.needsUpdate = true;
    this.keyLight.shadow.radius = this.graphicsQuality === 'ultra' ? 1.8 : 1;
    this.snowfall.setDensity(profile.snowDensity);
    this.updateStreetLights(this.carPosition, profile.streetLights);
    this.updateCityVisibility(this.carPosition, this.qualityLevel, profile.detailScale);
    this.updateTextureQuality();
    this.onGraphicsStatus(this.getGraphicsStatus());
  }

  private updateDriving(delta: number) {
    const key = (...values: string[]) => values.some((value) => this.pressed.has(value));
    const orbit = this.cameraView === 'orbit';
    const brakeKey = key('s') || !orbit && key('arrowdown');
    const brake = brakeKey && !this.reverseEngaged ? 1 : 0;
    const throttle = (key('w') || !orbit && key('arrowup') ? 1 : 0) - (brakeKey && this.reverseEngaged ? 1 : 0);
    const steer = (key('a') || !orbit && key('arrowleft') ? 1 : 0) - (key('d') || !orbit && key('arrowright') ? 1 : 0);
    this.steerInput = steer;
    const drifting = key(' ');
    if (brake > 0 || drifting || throttle < 0 || orbit) this.cancelNitro();
    let boosting = this.nitroRemaining > 0 && this.boostCharge > 0;
    this.previousPosition.copy(this.carPosition);
    this.vehicleMotion.yaw = this.yaw;
    const step = 1 / 120;
    this.physicsAccumulator += delta;
    const input = { throttle, brake, steer, steeringAssist: PLAYER_STEERING_ASSIST, handbrake: drifting, boost: boosting, boostTargetSpeed: this.nitroTargetSpeed };
    let trafficImpact = 0;
    while (this.physicsAccumulator + 1e-9 >= step) {
      input.boost = this.nitroRemaining > 0 && this.boostCharge > 0;
      input.boostTargetSpeed = input.boost ? this.nitroTargetSpeed : 0;
      this.updateWheelContacts();
      stepVehicle(this.vehicleMotion, input, this.wheelContacts, step);
      const impact = this.traffic.step(step, this.vehicleMotion);
      if (impact > 0) this.cancelNitro();
      trafficImpact = Math.max(trafficImpact, impact);
      if (input.boost) {
        this.nitroRemaining = Math.max(0, this.nitroRemaining - step);
        this.boostCharge = Math.max(0, this.boostCharge - step * (100 / 3));
      } else this.boostCharge = Math.min(100, this.boostCharge + step * (drifting ? 4 : 10));
      this.yaw = this.vehicleMotion.yaw;
      this.physicsAccumulator = Math.max(0, this.physicsAccumulator - step);
    }
    if (trafficImpact > 8) for (let i = 0; i < 10; i++) this.spawnParticle(this.carPosition, 0xffb34b, false);
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const longitudinal = this.velocity.dot(this.forward);
    boosting = this.nitroRemaining > 1e-8 && this.boostCharge > 1e-8;
    if (!boosting) { this.nitroRemaining = 0; this.nitroTargetSpeed = 0; }

    const collision = this.collisionWorld.sweep(this.previousPosition, this.carPosition, this.yaw);
    if (collision) {
      this.cancelNitro(); boosting = false;
      const travel = this.previousPosition.distanceTo(this.carPosition);
      const contact = Math.max(0, collision.time - .002 / Math.max(travel, .002));
      this.carPosition.lerpVectors(this.previousPosition, this.carPosition, contact);
      if (this.velocity.length() > 8) for (let i = 0; i < 12; i++) this.spawnParticle(this.carPosition, 0xffb34b, false);
      const box = collision.collider;
      const hx = box.hx + Math.abs(Math.cos(this.yaw)) * CAR_HALF_WIDTH + Math.abs(Math.sin(this.yaw)) * CAR_HALF_LENGTH;
      const hz = box.hz + Math.abs(Math.sin(this.yaw)) * CAR_HALF_WIDTH + Math.abs(Math.cos(this.yaw)) * CAR_HALF_LENGTH;
      const sx = this.carPosition.x - box.x, sz = this.carPosition.z - box.z;
      const hitX = Math.abs(Math.abs(sx) - hx) < Math.abs(Math.abs(sz) - hz);
      const nx = hitX ? Math.sign(sx) : 0, nz = hitX ? 0 : Math.sign(sz);
      const normalSpeed = this.velocity.x * nx + this.velocity.z * nz;
      if (normalSpeed < 0) { this.velocity.x -= normalSpeed * 1.04 * nx; this.velocity.z -= normalSpeed * 1.04 * nz; }
    }
    if (Math.abs(this.carPosition.x) > CITY_EDGE || Math.abs(this.carPosition.z) > CITY_EDGE) {
      this.cancelNitro(); boosting = false;
      if (Math.abs(this.carPosition.x) > CITY_EDGE) { this.carPosition.x = THREE.MathUtils.clamp(this.carPosition.x, -CITY_EDGE, CITY_EDGE); this.velocity.x *= -.04; }
      if (Math.abs(this.carPosition.z) > CITY_EDGE) { this.carPosition.z = THREE.MathUtils.clamp(this.carPosition.z, -CITY_EDGE, CITY_EDGE); this.velocity.z *= -.04; }
    }
    this.updateWheelContacts();
    const supportHeight = this.wheelContacts.reduce((sum, c) => sum + c.height, 0) / 4 + .006;
    // Exact critically damped spring: long render frames cannot make a parked
    // car oscillate. Preserve travel over uneven ground and settle to a true rest.
    const suspensionOffset = this.carPosition.y - supportHeight;
    const suspensionRate = this.suspensionVelocity + 8 * suspensionOffset;
    const suspensionDecay = Math.exp(-8 * delta);
    this.carPosition.y = supportHeight + (suspensionOffset + suspensionRate * delta) * suspensionDecay;
    this.suspensionVelocity = (this.suspensionVelocity - 8 * suspensionRate * delta) * suspensionDecay;
    if (Math.abs(this.carPosition.y - supportHeight) < .00001 && Math.abs(this.suspensionVelocity) < .00001) {
      this.carPosition.y = supportHeight; this.suspensionVelocity = 0;
    }
    this.car.position.copy(this.carPosition);
    this.car.rotation.y = this.yaw;
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const pivot = this.wheelMeshes[i].parent;
      if (pivot) pivot.position.y = .378 + this.wheelContacts[i].height - this.carPosition.y;
    }
    const wheelSpin = this.velocity.length() * delta / .378;
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      if (!(drifting && WHEEL_CONTACTS[i].z > 0)) this.wheelMeshes[i].rotation.x -= wheelSpin * (longitudinal < 0 ? -1 : 1);
    }
    for (const pivot of this.carRig.steering) pivot.rotation.y = this.vehicleMotion.steeringAngle;
    const suspensionEase = 1 - Math.exp(-delta * 8);

    // Dynamic firing detection
    const firing = key('f');

    const braking = brake > 0 || throttle > 0 && longitudinal < -.5 || drifting;
    const speedRatio = Math.min(this.velocity.length() / 35, 1);
    const c = this.wheelContacts;
    const groundPitch = Math.atan2((c[0].height + c[2].height - c[1].height - c[3].height) / 2, 2.86);
    const groundRoll = Math.atan2((c[2].height + c[3].height - c[0].height - c[1].height) / 2, 1.79);
    const targetPitch = THREE.MathUtils.clamp(groundPitch + this.vehicleMotion.acceleration / 9.81 * .038, -.2, .2);
    this.carRig.body.rotation.x = THREE.MathUtils.lerp(this.carRig.body.rotation.x, targetPitch, suspensionEase);
    const targetRoll = THREE.MathUtils.clamp(groundRoll - this.vehicleMotion.yawRate * this.velocity.length() / 9.81 * .055, -.2, .2);
    this.carRig.body.rotation.z = THREE.MathUtils.lerp(this.carRig.body.rotation.z, targetRoll, suspensionEase);

    // Road feedback fades out before stopping; only actual weapon recoil moves
    // the body while stationary. Engine idle is carried by audio.
    const roadRumble = Math.sin(this.elapsed * 44) * speedRatio * .0035 * THREE.MathUtils.smoothstep(this.velocity.length(), .3, 3);
    const recoilShudder = (this.carRig.miniguns.recoil[0] + this.carRig.miniguns.recoil[1]) * -.14;
    this.carRig.body.position.y = roadRumble + recoilShudder;

    // Dynamic brake disc thermal heating & dissipation (glowing red-hot carbon rotors)
    if (braking && speedRatio > .05) {
      this.brakeHeat = Math.min(1.0, this.brakeHeat + delta * 2.8 * speedRatio);
    } else {
      this.brakeHeat = Math.max(0.0, this.brakeHeat - delta * 0.7);
    }
    for (const disc of this.brakeDiscs) {
      (disc.material as THREE.MeshStandardMaterial).emissiveIntensity = this.brakeHeat * 2.5;
    }

    // Reverse lights
    const reversing = longitudinal < -0.5;
    for (const revLight of this.reverseLights) {
      (revLight.material as THREE.MeshStandardMaterial).emissiveIntensity = reversing ? 2.2 : 0.0;
    }

    this.carRig.nitroEffects.update(this.elapsed, delta, boosting ? 1 : 0);
    const brakeIntensity = braking ? 4.5 : 1.6;
    for (const brakeLight of this.brakeLights) {
      (brakeLight.material as THREE.MeshStandardMaterial).emissiveIntensity = brakeIntensity;
    }
    const engineIntensity = boosting ? 2.2 : .025;
    for (const exhaust of this.exhaustMeshes) {
      (exhaust.material as THREE.MeshStandardMaterial).emissiveIntensity = engineIntensity;
    }
    this.underglow.scale.set(boosting ? 1.05 : 1, 1, boosting ? 1.2 : 1);
    const lateralSpeed = Math.abs(this.velocity.dot(this.right));
    const tires = this.tireFeedback.update(this.velocity.length(), lateralSpeed, brake, drifting, this.wheelContacts);
    this.roadSkidMarks.update(this.elapsed, this.wheelContacts, tires.wheels);
    const sliding = this.velocity.length() > 5 && lateralSpeed > Math.max(1.8, this.velocity.length() * .12);
    this.driftTimer -= delta;
    if (sliding && this.vehicleMotion.snow < .25 && this.driftTimer <= 0) {
      for (let i = 0; i < 3; i++) this.spawnParticle(this.car.position, 0x7ba7b7, false);
      this.driftTimer = .035;
    }
    this.updateWeapons(delta, firing);
    const speed = this.velocity.length() * 3.6;
    const telemetry: DriveTelemetry = { speed, boost: this.boostCharge / 100, drifting: sliding, boosting, firing };
    this.lastTelemetry = telemetry;
    this.audio.update({
      speed: this.velocity.length(), engineLoad: throttle > 0 ? 1 : throttle < 0 ? .55 : .2,
      boosting, drifting: telemetry.drifting, tireSqueal: tires.squeal, steering: steer, reversing: longitudinal < -1,
    });
  }

  private resetWeapons() {
    this.carRig.miniguns.reset(); this.audio.stopFiring(); this.audio.updateGunSpin(0);
    this.freeSmokeParticles.push(...this.smokeParticles); this.freeBullets.push(...this.bullets);
    this.smokeParticles.length = 0; this.bullets.length = 0; this.gunSmokeTimer = 0;
    this.smokeGeometry.setDrawRange(0, 0); this.bulletGeometry.setDrawRange(0, 0);
    this.smokeMesh.visible = this.bulletTrails.visible = false;
  }

  private updateWeapons(delta: number, firing: boolean) {
    const guns = this.carRig.miniguns;
    const shots = guns.update(delta, firing, this.elapsed, this.velocity, this.qualityLevel);
    if (firing) this.audio.fireGun(guns.spin / MINIGUN_SPIN); else this.audio.stopFiring();
    this.audio.updateGunSpin(guns.spin / MINIGUN_SPIN);
    for (const shot of shots) {
      // Equal/opposite projectile momentum reaches the vehicle as well as the cradle.
      this.velocity.addScaledVector(shot.direction, -SHOT_IMPULSE / 1950);
      this.spawnBullet(shot);
      if (shot.tracer || this.qualityLevel < 2) this.spawnGunSmoke(shot.position, shot.direction);
    }
    this.gunSmokeTimer -= delta;
    if (this.gunSmokeTimer <= 0) {
      guns.muzzleAnchors.forEach((anchor, i) => {
        if (guns.heat[i] < .07) return;
        const position = anchor.getWorldPosition(this.weaponPosition);
        const direction = this.weaponDirection.set(0, 0, -1).transformDirection(anchor.matrixWorld);
        this.spawnGunSmoke(position, direction, .3 + guns.heat[i] * .25, true);
      });
      this.gunSmokeTimer = .085;
    }
  }

  private spawnBullet(shot: GunShot) {
    const bullet = this.freeBullets.pop() ?? this.bullets.shift()!;
    const position = bullet.position.copy(shot.position);
    const direction = bullet.velocity.copy(shot.direction);
    direction.x += (Math.random() - .5) * .002; direction.y += (Math.random() - .5) * .002;
    direction.normalize();
    const velocity = direction.multiplyScalar(BULLET_SPEED).add(this.velocity);
    bullet.velocity.copy(velocity); bullet.life = .65; bullet.age = 0; bullet.tracer = shot.tracer; this.bullets.push(bullet);
    for (let i = 0; shot.tracer && i < 2; i++) {
      const sparkVelocity = shot.direction.clone().multiplyScalar(5 + Math.random() * 7).addScaledVector(this.velocity, .6);
      sparkVelocity.x += (Math.random() - .5) * 2; sparkVelocity.y += Math.random() * 1.5;
      this.particles.push({ position: position.clone(), velocity: sparkVelocity, life: .045 + Math.random() * .06, color: new THREE.Color(0xffb968) });
      if (this.particles.length > 180) this.particles.shift();
    }
  }

  private spawnGunSmoke(muzzlePos: THREE.Vector3, direction: THREE.Vector3, intensity = 1, residual = false) {
    const particle = this.freeSmokeParticles.pop() ?? this.smokeParticles.shift()!;
    const velocity = particle.velocity.copy(direction).multiplyScalar(residual ? .15 : 2 + Math.random() * 2).addScaledVector(this.velocity, residual ? .25 : .7);
    velocity.y += residual ? .45 : .2;
    const maxLife = (residual ? 1.6 : 1.4) + Math.random() * .75;
    particle.position.copy(muzzlePos); particle.life = particle.maxLife = maxLife;
    particle.size = residual ? .17 : .20 + Math.random() * .12; particle.opacity = (residual ? .48 : .76) * intensity;
    particle.seed = Math.random() * 20; this.smokeParticles.push(particle);
  }

  private spawnBulletImpact(position: THREE.Vector3, direction: THREE.Vector3) {
    for (let i = 0; i < 7; i++) {
      const velocity = direction.clone().multiplyScalar(-1 - Math.random() * 3);
      velocity.x += (Math.random() - .5) * 5; velocity.y = .8 + Math.random() * 2; velocity.z += (Math.random() - .5) * 5;
      this.particles.push({ position: position.clone(), velocity, life: .13 + Math.random() * .18, color: new THREE.Color(i % 2 ? 0xff9e3d : 0xffd291) });
    }
    this.spawnGunSmoke(position, direction.clone().negate(), .65);
    if (this.particles.length > 180) this.particles.splice(0, this.particles.length - 180);
  }

  private updateBullets(delta: number) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i]; bullet.life -= delta; bullet.age += delta;
      if (bullet.life <= 0) { this.recycleBullet(i); continue; }
      const previous = this.bulletPrevious.copy(bullet.position);
      // SI-unit flight with gravity and mild aerodynamic drag.
      bullet.position.addScaledVector(bullet.velocity, delta); bullet.position.y -= 4.905 * delta * delta;
      bullet.velocity.y -= 9.81 * delta; bullet.velocity.multiplyScalar(Math.exp(-.065 * delta));
      let hit: number | null = null;
      if (bullet.position.y <= .035) hit = previous.y <= .035 ? 0 : (previous.y - .035) / (previous.y - bullet.position.y);
      for (const building of this.collisionWorld.query(previous, bullet.position)) {
        const fraction = projectileHitFraction(previous, bullet.position, building);
        if (fraction !== null && (hit === null || fraction < hit)) hit = fraction;
      }
      if (hit !== null) {
        const impact = previous.lerp(bullet.position, hit);
        // Flight and collision remain exact for all rounds; distant sparks cannot be seen.
        const effectRange = this.qualityLevel >= 2 ? 90 : 140;
        if ((bullet.tracer || this.qualityLevel < 2) && impact.distanceToSquared(this.carPosition) < effectRange * effectRange) {
          this.spawnBulletImpact(impact, this.weaponDirection.copy(bullet.velocity).normalize());
        }
        this.recycleBullet(i);
      }
    }
    // Upload only the live tracer span; stale buffer entries stay outside the draw range.
    let count = 0;
    for (const bullet of this.bullets) {
      if (!bullet.tracer) continue;
      const idx = count++ * 6, fade = Math.min(bullet.life * 3, 1), speed = bullet.velocity.length();
      const length = Math.min(7, speed * .012, bullet.age * speed) / speed;
      this.bulletPositions[idx] = bullet.position.x;
      this.bulletPositions[idx + 1] = bullet.position.y;
      this.bulletPositions[idx + 2] = bullet.position.z;
      this.bulletPositions[idx + 3] = bullet.position.x - bullet.velocity.x * length;
      this.bulletPositions[idx + 4] = bullet.position.y - bullet.velocity.y * length;
      this.bulletPositions[idx + 5] = bullet.position.z - bullet.velocity.z * length;
      this.bulletColors[idx] = fade; this.bulletColors[idx + 1] = .95 * fade; this.bulletColors[idx + 2] = .5 * fade;
      this.bulletColors[idx + 3] = .35 * fade; this.bulletColors[idx + 4] = .098 * fade; this.bulletColors[idx + 5] = .014 * fade;
    }
    this.bulletGeometry.setDrawRange(0, count * 2); this.bulletTrails.visible = count > 0;
    if (count > 0) for (const name of ['position', 'color']) {
      const attribute = this.bulletGeometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.clearUpdateRanges(); attribute.addUpdateRange(0, count * 6); attribute.needsUpdate = true;
    }
  }

  private recycleBullet(index: number) {
    this.freeBullets.push(this.bullets[index]);
    const last = this.bullets.pop()!;
    if (index < this.bullets.length) this.bullets[index] = last;
  }

  private spawnParticle(origin: THREE.Vector3, color: number, exhaust: boolean) {
    const position = origin.clone();
    const localX = exhaust ? (Math.random() - 0.5) * 0.78 : (Math.random() - 0.5) * 1.65;
    const localZ = exhaust ? 2.2 : 1.45 + Math.random() * 0.6;
    const local = new THREE.Vector3(localX, exhaust ? 0.42 : 0.11, localZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    position.add(local);
    const velocity = new THREE.Vector3();
    velocity.x += (Math.random() - 0.5) * (exhaust ? 2.2 : 6);
    velocity.y += exhaust ? 1 + Math.random() * 1.6 : 0.25 + Math.random() * 0.75;
    velocity.z += 0.8 + Math.random() * (exhaust ? 4.8 : 3);
    velocity.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).addScaledVector(this.velocity, .15);
    this.particles.push({ position, velocity, life: exhaust ? 0.5 + Math.random() * 0.24 : 0.32, color: new THREE.Color(color) });
    if (this.particles.length > 180) this.particles.shift();
  }

  private updateSmoke(delta: number) {
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.life -= delta;
      if (p.life <= 0) {
        this.freeSmokeParticles.push(p);
        const last = this.smokeParticles.pop()!;
        if (i < this.smokeParticles.length) this.smokeParticles[i] = last;
        continue;
      }
      const age = p.maxLife - p.life, drag = 1 - Math.exp(-delta * 2.0);
      p.velocity.x += (.55 + Math.sin(age * 4 + p.seed) * .35 - p.velocity.x) * drag;
      p.velocity.z += (.2 + Math.cos(age * 3 + p.seed) * .3 - p.velocity.z) * drag;
      p.velocity.y += (.85 + Math.sin(age * 5 + p.seed) * .2 - p.velocity.y) * drag;
      p.position.addScaledVector(p.velocity, delta);
      p.size += delta * .44;
    }
    const count = this.smokeParticles.length;
    for (let i = 0; i < count; i++) {
      const p = this.smokeParticles[i], idx = i * 3, t = p.life / p.maxLife;
      this.smokePositions[idx] = p.position.x; this.smokePositions[idx + 1] = p.position.y; this.smokePositions[idx + 2] = p.position.z;
      this.smokeSizes[i] = p.size * (1 + (1 - t) * .65);
      this.smokeOpacities[i] = p.opacity * Math.min(1, (1 - t) * 18 + .45) * t ** 1.6;
    }
    this.smokeGeometry.setDrawRange(0, count); this.smokeMesh.visible = count > 0;
    if (count > 0) for (const name of ['position', 'particleSize', 'particleOpacity']) {
      const attribute = this.smokeGeometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.clearUpdateRanges(); attribute.addUpdateRange(0, count * attribute.itemSize); attribute.needsUpdate = true;
    }
  }

  private updateParticles(delta: number) {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      particle.life -= delta;
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      particle.velocity.y -= delta * 1.8;
      particle.position.addScaledVector(particle.velocity, delta);
    }
    for (let i = 0; i < 180; i += 1) {
      const particle = this.particles[i];
      const index = i * 3;
      if (particle) {
        this.particlePositions[index] = particle.position.x;
        this.particlePositions[index + 1] = particle.position.y;
        this.particlePositions[index + 2] = particle.position.z;
        const fade = Math.min(particle.life * 3, 1);
        this.particleColors[index] = particle.color.r * fade;
        this.particleColors[index + 1] = particle.color.g * fade;
        this.particleColors[index + 2] = particle.color.b * fade;
      } else {
        this.particlePositions[index] = 0;
        this.particlePositions[index + 1] = -1000;
        this.particlePositions[index + 2] = 0;
      }
    }
    this.particleGeometry.setDrawRange(0, this.particles.length);
    this.particleGeometry.attributes.position.needsUpdate = true;
    this.particleGeometry.attributes.color.needsUpdate = true;
  }

  private frame(time: number) {
    if (this.destroyed) return;
    const frameMs = this.previousTime === 0 ? 16 : time - this.previousTime;
    const delta = this.previousTime === 0 ? 0 : Math.min(frameMs / 1000, .1);
    this.previousTime = time;
    this.elapsed += delta;
    this.cityScreenClock.value = this.elapsed;
    this.updateRenderQuality(frameMs, delta);
    this.roadSkidMarks.updateTime(this.elapsed);
    const occupied = this.person.mode === 'driving';
    this.traffic.setPedestrian(occupied ? null : this.person.position);
    if (this.active && delta > 0) {
      if (occupied) this.updateDriving(delta);
      else {
        // The parked car remains anchored while city traffic continues around it.
        this.previousPosition.copy(this.carPosition);
        this.vehicleMotion.yaw = this.yaw;
        this.physicsAccumulator += delta;
        while (this.physicsAccumulator >= 1 / 120) {
          this.traffic.step(1 / 120, this.vehicleMotion);
          this.carPosition.copy(this.previousPosition); this.velocity.set(0, 0, 0);
          this.vehicleMotion.yawRate = this.vehicleMotion.acceleration = 0;
          this.physicsAccumulator -= 1 / 120;
        }
        this.carRig.body.rotation.x *= Math.exp(-delta * 8);
        this.carRig.body.rotation.z *= Math.exp(-delta * 8);
        this.carRig.body.position.y = 0;
        this.audio.update({ speed: 0, engineLoad: 0, boosting: false, drifting: false, tireSqueal: 0, steering: 0, reversing: false });
        this.lastTelemetry = { speed: 0, boost: this.boostCharge / 100, drifting: false, boosting: false, firing: false };
      }
    }
    this.personBlockers.length = 0;
    for (const npc of this.traffic.cars) this.personBlockers.push({ x: npc.motion.position.x, z: npc.motion.position.z, yaw: npc.motion.yaw, hx: CAR_HALF_WIDTH, hz: CAR_HALF_LENGTH });
    this.person.cameraYaw = this.personCameraYaw;
    // The driver's grip uses the wheel's current transform, including steering.
    this.carRig.cockpit.update(delta, this.lastTelemetry, this.steerInput, this.cameraView === 'driver');
    this.person.update(this.active ? delta : 0, this.pressed, this.carPosition, this.yaw, this.velocity.length(), this.personBlockers);
    this.carRig.driverDoor.rotation.y = -.96 * this.person.doorOpenAmount;
    this.person.root.visible = this.person.ready;
    this.person.setDriverView(this.cameraView === 'driver' && this.person.mode === 'driving');
    this.lastTelemetry.person = this.person.telemetry;
    if (this.person.mode !== this.lastPersonMode) {
      if (this.person.mode === 'driving' && this.cameraView === 'person') this.setCameraView(this.drivingCamera);
      this.lastPersonMode = this.person.mode;
      this.onTelemetry(this.lastTelemetry);
    }
    const focus = this.person.mode === 'driving' ? this.carPosition : this.person.position;
    this.traffic.updateVisuals(this.active ? delta : 0, focus);
    this.pedestrianCarBlocker.x = this.carPosition.x; this.pedestrianCarBlocker.z = this.carPosition.z;
    this.pedestrianCarBlocker.yaw = this.yaw;
    this.personBlockers.push(this.pedestrianCarBlocker);
    this.pedestrians.update(this.active ? delta : 0, focus, this.graphicsQuality,
      this.personBlockers, occupied ? null : this.person.position);
    if (this.active) {
      this.parkedMarker.x = this.carPosition.x; this.parkedMarker.z = this.carPosition.z; this.parkedMarker.yaw = this.yaw;
      this.onMapPosition(focus.x, focus.z, this.person.mode === 'driving' ? this.yaw : this.person.yaw - Math.PI,
        this.traffic.markers, this.person.mode === 'driving' ? undefined : this.parkedMarker);
    }
    this.updateSnow(delta);
    this.updateParticles(delta);
    this.updateBullets(delta);
    this.updateSmoke(delta);
    this.steam.update(this.elapsed, window.innerHeight * this.scenePixelRatio);
    this.reflections.update(this.elapsed);
    this.island.update(this.elapsed);
    const graphicsProfile = GRAPHICS_PRESETS[this.graphicsQuality];
    this.updateStreetLights(focus, graphicsProfile.streetLights);
    this.updateCityVisibility(focus, this.qualityLevel, graphicsProfile.detailScale);
    this.flying.forEach(({ vehicle, phase, radius, height, speed, index }) => {
      const angle = phase + this.elapsed * speed * (index % 2 === 0 ? 1 : -1);
      vehicle.position.set(Math.cos(angle) * radius, height + Math.sin(angle * 1.6) * 2.4, Math.sin(angle) * radius);
      vehicle.rotation.y = -angle + Math.PI / 2;
    });

    this.updateCamera(delta);
    const speedRatio = Math.min(this.velocity.length() / 76, 1);

    this.presentationPass.uniforms.strength.value = this.lastTelemetry.boosting ? speedRatio * .006 : 0;
    this.presentationPass.uniforms.bloomEnabled.value = this.bloomPass.enabled ? 1 : 0;
    this.keyLight.position.set(focus.x + 22, focus.y + 38, focus.z + 16);
    this.keyLight.target.position.copy(focus);
    const shadowChanged = this.shadowPosition.distanceToSquared(focus) > .0625 || Math.abs(this.shadowYaw - this.yaw) > .025 ||
      this.person.mode !== 'driving' ||
      this.active && this.pedestrians.visible > 0 ||
      this.active && this.traffic.cars.some(car => car.rig.car.visible && car.motion.velocity.lengthSq() > .01);
    const shadowInterval = graphicsProfile.shadowInterval + this.qualityLevel * 3;
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled && this.shadowFrame++ % shadowInterval === 0 && shadowChanged;
    if (this.renderer.shadowMap.needsUpdate) { this.shadowPosition.copy(focus); this.shadowYaw = this.yaw; }
    this.renderer.info.reset();
    this.composer.render();
    this.telemetryTimer += delta;
    if (this.active && this.telemetryTimer > 0.085) {
      this.telemetryTimer = 0;
      this.onTelemetry(this.lastTelemetry);
    }
    this.animationFrame = requestAnimationFrame(this.frameHandler);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    window.removeEventListener('blur', this.blurHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.pointerDownHandler);
    canvas.removeEventListener('pointermove', this.pointerMoveHandler);
    canvas.removeEventListener('pointerup', this.pointerUpHandler);
    canvas.removeEventListener('pointercancel', this.pointerUpHandler);
    canvas.removeEventListener('lostpointercapture', this.pointerUpHandler);
    canvas.removeEventListener('wheel', this.wheelHandler);
    this.orbitPointers.clear();
    canvas.style.touchAction = '';
    canvas.style.cursor = '';
    this.audio.dispose();
    this.person.destroy();
    this.pedestrians.destroy();
    this.scene.traverse((object) => {
      if (object instanceof THREE.BatchedMesh) { object.customDepthMaterial?.dispose(); object.dispose(); }
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        const drawable = object as THREE.Mesh | THREE.Points | THREE.LineSegments;
        drawable.geometry.dispose();
        const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
          if ('bumpMap' in material && material.bumpMap instanceof THREE.Texture) material.bumpMap.dispose();
          if ('roughnessMap' in material && material.roughnessMap instanceof THREE.Texture) material.roughnessMap.dispose();
          if ('alphaMap' in material && material.alphaMap instanceof THREE.Texture) material.alphaMap.dispose();
          if ('emissiveMap' in material && material.emissiveMap instanceof THREE.Texture) material.emissiveMap.dispose();
          material.dispose();
        }
      }
    });
    this.glowMap.dispose();
    this.environment.dispose();
    this.island.dispose();
    this.keyLight.shadow.map?.dispose();
    this.reflections.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.configuredTextures.clear();
  }
}
