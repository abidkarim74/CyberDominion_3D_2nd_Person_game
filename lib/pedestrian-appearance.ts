import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { PERSON_MODEL_HEIGHT, PERSON_WORLD_HEIGHT, PERSON_WORLD_SCALE } from './person-scale';

export type WinterOuterwear = 'parka' | 'puffer' | 'wool-coat' | 'anorak';
export type WinterHeadwear = 'beanie' | 'pom-beanie' | 'fur-hood' | 'earmuffs' | 'cap' | 'none' | 'trapper-cap';

/** A persistent identity: streaming a person in and out never changes their clothes. */
export type PedestrianAppearance = {
  seed: number;
  signature: string;
  outerwear: WinterOuterwear;
  headwear: WinterHeadwear;
  coat: number;
  trim: number;
  scarf: number;
  trousers: number;
  boots: number;
  skin: number;
  skinShade: number;
  hair: number;
  hat: number;
  bag: 'none' | 'backpack' | 'satchel';
  bagColor: number;
  /** Small anatomical height variation relative to the player's original model. */
  height: number;
  build: number;
  face: number;
  hairStyle: number;
  scarfStyle: number;
  glasses: boolean;
};

const COATS = [0x36506b, 0x8a4c37, 0x597461, 0x8b344e, 0xb78347, 0x565768, 0x2c656d, 0xafa48b, 0x27344b, 0x66503f, 0x845a75, 0x45677d, 0x526442, 0x954c48, 0x6e7589, 0xa89478];
const SCARVES = [0xd9b56b, 0xb74856, 0x7babb0, 0xd5c8a6, 0x78709f, 0xb27754, 0x477976, 0xb8b9c6, 0x9aaf82, 0x657790];
const SKIN = [0xf1c9aa, 0xd5a17b, 0xbc835f, 0x9b674b, 0x744932, 0x53382c, 0xe3b792, 0xb68b75];
const HAIR = [0x211d1c, 0x493329, 0x6c4931, 0xb28e57, 0x8c4a2d, 0x97948d, 0xc4b9a2, 0x343132];
const TROUSERS = [0x273343, 0x444653, 0x4b5148, 0x64574d, 0x37323d, 0x44596b, 0x514951];
const BOOTS = [0x292b31, 0x514036, 0x3d3432, 0x5c5043, 0x28333b];
const OUTERWEAR: WinterOuterwear[] = ['parka', 'puffer', 'wool-coat', 'anorak'];
// These describe the equipment actually authored in the four Blender assets.
const HEADWEAR: Record<WinterOuterwear, WinterHeadwear> = {
  parka: 'beanie', puffer: 'none', 'wool-coat': 'none', anorak: 'trapper-cap',
};
const SOURCE_FILES = OUTERWEAR.map(variant => `/models/pedestrians/${variant}.glb`);

/** Independent hashed draws avoid neighboring NPCs having neighboring palette choices. */
export function createPedestrianAppearance(seed: number): PedestrianAppearance {
  let state = (seed ^ 0x63e2a9b5) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ state >>> 15, state | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const coat = pick(COATS), scarf = pick(SCARVES), skin = pick(SKIN), hair = pick(HAIR);
  const tinted = new THREE.Color(coat).offsetHSL((random() - .5) * .028, 0, (random() - .5) * .055).getHex();
  const outerwear = pick(OUTERWEAR), headwear = HEADWEAR[outerwear];
  const appearance: PedestrianAppearance = {
    seed, signature: '', outerwear, headwear, coat: tinted,
    trim: new THREE.Color(tinted).multiplyScalar(.58).getHex(), scarf,
    trousers: pick(TROUSERS), boots: pick(BOOTS), skin,
    skinShade: new THREE.Color(skin).multiplyScalar(.55).getHex(), hair,
    hat: random() < .48 ? scarf : pick(COATS),
    // Accessory silhouettes are authored with the garments rather than added primitives.
    bag: 'none', bagColor: 0x514836,
    height: .96 + random() * .08,
    build: random(), face: random(),
    hairStyle: OUTERWEAR.indexOf(outerwear),
    scarfStyle: outerwear === 'wool-coat' ? 1 : outerwear === 'anorak' ? 2 : 0,
    glasses: false,
  };
  appearance.signature = [outerwear, headwear, tinted.toString(16), scarf.toString(16), skin.toString(16), hair.toString(16),
    appearance.hat.toString(16), appearance.trousers.toString(16), appearance.height.toFixed(4), appearance.build.toFixed(4)].join('/');
  return appearance;
}

type Template = {
  model: THREE.Group;
  idle: THREE.AnimationClip;
  walk: THREE.AnimationClip;
  meshes: number;
  triangles: number;
};
type MaterialBinding = { material: THREE.MeshStandardMaterial; original: THREE.MeshStandardMaterial };
type Actor = {
  root: THREE.Group;
  model: THREE.Object3D;
  variant: WinterOuterwear;
  identity?: number;
  signature?: string;
  mixer: THREE.AnimationMixer;
  idle: THREE.AnimationAction;
  walk: THREE.AnimationAction;
  materials: THREE.Material[];
  tints: MaterialBinding[];
  meshes: THREE.Mesh[];
  skeletons: Set<THREE.Skeleton>;
  motion: number;
  time: number;
};
type Request = {
  appearance?: PedestrianAppearance;
  x: number; y: number; z: number; yaw: number; phase: number; speed: number; time: number;
  frame: number;
};

/**
 * A bounded local pool of Blender-authored people, derived from the player's rig.
 * The city keeps all resident identities, but only nearby bodies and independent
 * skeletons exist here. Source geometry, animation clips and texture atlases are
 * shared; clothing tints and skeleton poses belong to each active person.
 */
export class WinterPedestrianRenderer {
  readonly root = new THREE.Group();
  readonly maxVisible: number;
  private readonly templates = new Map<WinterOuterwear, Template>();
  private readonly actors: Actor[] = [];
  private readonly active = new Map<number, Actor>();
  private readonly requests: Request[];
  private readonly selected = new Set<number>();
  private readonly sharedTextures = new Map<string, THREE.Texture>();
  private readonly failures = new Map<WinterOuterwear, string>();
  private readonly tint = new THREE.Color();
  private disposed = false;
  private frame = 0;
  private requestCount = 0;
  private visibleCount = 0;
  private drawCalls = 0;
  private triangleCount = 0;

  constructor(scene: THREE.Scene, maxVisible = 40) {
    this.maxVisible = Math.max(1, Math.min(40, Math.floor(maxVisible)));
    this.requests = Array.from({ length: this.maxVisible }, () => ({
      x: 0, y: 0, z: 0, yaw: 0, phase: 0, speed: 0, time: 0, frame: -1,
    }));
    this.root.name = 'Winter pedestrians / Blender player-derived models';
    this.root.userData.dynamic = true;
    this.root.userData.pedestrian = true;
    this.root.userData.authoredBodyHeight = PERSON_MODEL_HEIGHT;
    this.root.userData.playerScale = PERSON_WORLD_SCALE;
    scene.add(this.root);
    const loader = new GLTFLoader();
    for (const variant of OUTERWEAR) void this.loadTemplate(loader, variant);
  }

  get diagnostics() {
    return {
      ready: !this.disposed && this.templates.size === OUTERWEAR.length,
      disposed: this.disposed,
      loadingError: this.failures.size ? [...this.failures.values()].join(' ') : undefined,
      loadingErrors: [...this.failures.values()],
      sourceFiles: [...SOURCE_FILES],
      templates: [...this.templates.keys()], templateCount: this.templates.size,
      visible: this.visibleCount, capacity: this.maxVisible, poolSize: this.actors.length,
      skeletonCount: this.actors.reduce((count, actor) => count + actor.skeletons.size, 0),
      batches: this.drawCalls, instances: this.visibleCount, triangles: this.triangleCount,
      authoredHeight: PERSON_MODEL_HEIGHT, authoredBodyHeight: PERSON_MODEL_HEIGHT,
      playerScale: PERSON_WORLD_SCALE, targetHeight: PERSON_WORLD_HEIGHT,
    };
  }

  beginFrame() {
    this.frame++;
    this.requestCount = 0;
  }

  /** phase is an accumulated full walk cycle in radians; speed is metres/second. */
  set(index: number, appearance: PedestrianAppearance, x: number, groundY: number, z: number,
    yaw: number, phase: number, speed = 1, time = 0) {
    if (this.disposed || index < 0 || index >= this.maxVisible) return;
    const request = this.requests[index];
    request.appearance = appearance;
    request.x = x; request.y = groundY; request.z = z; request.yaw = yaw;
    request.phase = phase; request.speed = speed; request.time = time; request.frame = this.frame;
    this.requestCount = Math.max(this.requestCount, index + 1);
  }

  endFrame() {
    if (this.disposed) return;
    this.visibleCount = 0; this.drawCalls = 0; this.triangleCount = 0;
    this.selected.clear();
    for (let i = 0; i < this.requestCount; i++) {
      const request = this.requests[i];
      if (request.frame === this.frame && request.appearance && this.templates.has(request.appearance.outerwear)) {
        this.selected.add(request.appearance.seed);
      }
    }
    // Reconcile the whole selection first: distance sorting must never steal a
    // model from a person who appears later in this same frame's selection.
    for (const actor of this.actors) {
      if (actor.identity !== undefined && !this.selected.has(actor.identity)) {
        this.active.delete(actor.identity);
        actor.identity = undefined;
        actor.root.visible = false;
      }
    }
    for (let i = 0; i < this.requestCount; i++) {
      const request = this.requests[i], appearance = request.appearance;
      if (request.frame !== this.frame || !appearance) continue;
      const template = this.templates.get(appearance.outerwear);
      if (!template) continue;
      let actor = this.active.get(appearance.seed);
      if (actor && actor.variant !== appearance.outerwear) {
        this.active.delete(appearance.seed);
        actor.identity = undefined;
        actor.root.visible = false;
        actor = undefined;
      }
      if (!actor) actor = this.acquire(appearance.outerwear, template);
      if (!actor) continue;
      if (actor.identity !== appearance.seed || actor.signature !== appearance.signature) {
        this.applyAppearance(actor, appearance);
        actor.identity = appearance.seed;
        actor.signature = appearance.signature;
        actor.motion = THREE.MathUtils.clamp(request.speed / .65, 0, 1);
        actor.time = request.time;
        this.active.set(appearance.seed, actor);
      }
      this.pose(actor, request, i);
      this.visibleCount++;
      this.drawCalls += template.meshes;
      this.triangleCount += template.triangles;
    }
  }

  /** Remove before the scene's generic teardown; all source resources are shared. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const actor of this.actors) this.disposeActor(actor);
    this.actors.length = 0;
    this.active.clear(); this.selected.clear();
    disposeSourceResources([...this.templates.values()].map(template => template.model), this.sharedTextures.values());
    this.templates.clear(); this.sharedTextures.clear(); this.failures.clear();
    this.visibleCount = 0; this.drawCalls = 0; this.triangleCount = 0;
    this.root.clear();
    for (const request of this.requests) request.appearance = undefined;
  }

  private async loadTemplate(loader: GLTFLoader, variant: WinterOuterwear) {
    const path = `/models/pedestrians/${variant}.glb`;
    try {
      const gltf = await loader.loadAsync(path);
      if (this.disposed) { disposeSourceResources([gltf.scene]); return; }
      const idle = gltf.animations.find(clip => /(^|[|:])idle$/i.test(clip.name));
      const walk = gltf.animations.find(clip => /(^|[|:])walk$/i.test(clip.name));
      let meshes = 0, triangles = 0, skinned = 0;
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        if (object instanceof THREE.SkinnedMesh) skinned++;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
      });
      if (!idle || !walk || !skinned) {
        disposeSourceResources([gltf.scene]);
        throw new Error('The Blender model requires a skinned human mesh and Idle/Walk animation clips.');
      }
      boundAnimatedMeshes(gltf.scene, [idle, walk]);
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (!(material instanceof THREE.MeshStandardMaterial) || !material.map ||
            !/(coat|trousers)/i.test(material.name)) continue;
          // The neutral atlas supplies fabric detail; the identity supplies its
          // colour. Treat that detail as a linear multiplier so the player's
          // dark source shirt does not blacken every new outfit.
          material.map.colorSpace = THREE.LinearSRGBColorSpace;
          material.map.needsUpdate = true;
        }
      });
      this.shareAtlasTextures(gltf.scene);
      this.templates.set(variant, { model: gltf.scene, idle, walk, meshes, triangles });
    } catch (error) {
      if (this.disposed) return;
      const message = `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`;
      this.failures.set(variant, message);
      console.error(message);
    }
  }

  private acquire(variant: WinterOuterwear, template: Template) {
    let index = this.actors.findIndex(actor => actor.identity === undefined && actor.variant === variant);
    if (index >= 0) return this.actors[index];
    index = this.actors.findIndex(actor => actor.identity === undefined);
    if (index < 0 && this.actors.length >= this.maxVisible) return undefined;
    if (index >= 0) this.disposeActor(this.actors[index]);
    const actor = this.createActor(variant, template);
    if (index >= 0) this.actors[index] = actor;
    else this.actors.push(actor);
    return actor;
  }

  private createActor(variant: WinterOuterwear, template: Template): Actor {
    const root = new THREE.Group(), model = cloneSkeleton(template.model);
    root.name = `Pedestrian / ${variant}`;
    root.userData.dynamic = true; root.userData.pedestrian = true;
    root.visible = false;
    root.add(model); this.root.add(root);
    const originals = new Map<THREE.Material, THREE.Material>();
    const tints: MaterialBinding[] = [], meshes: THREE.Mesh[] = [], skeletons = new Set<THREE.Skeleton>();
    const skinBindings: THREE.SkinnedMesh[] = [];
    const materialFor = (original: THREE.Material) => {
      let material = originals.get(original);
      if (!material) {
        material = original.clone(); originals.set(original, material);
        if (material instanceof THREE.MeshStandardMaterial && original instanceof THREE.MeshStandardMaterial) {
          tints.push({ material, original });
        }
      }
      return material;
    };
    model.traverse(object => {
      object.userData.dynamic = true; object.userData.pedestrian = true;
      if (!(object instanceof THREE.Mesh)) return;
      meshes.push(object);
      object.material = Array.isArray(object.material) ? object.material.map(materialFor) : materialFor(object.material);
      object.castShadow = true; object.receiveShadow = true;
      if (object instanceof THREE.SkinnedMesh) {
        // These bounds cover both clips, rather than just the imported bind pose.
        object.frustumCulled = true;
        // SkeletonUtils creates one palette per mesh, even when the GLB's face,
        // garments and hair all use the same skin. Reuse that palette when the
        // complete bone order, inverse matrices and mesh binding are identical.
        const shared = skinBindings.find(mesh => sameSkinBinding(mesh, object));
        if (shared && shared.skeleton !== object.skeleton) {
          object.skeleton.dispose();
          object.skeleton = shared.skeleton;
        } else skinBindings.push(object);
        skeletons.add(object.skeleton);
      }
    });
    const mixer = new THREE.AnimationMixer(model);
    const idle = mixer.clipAction(template.idle).setEffectiveWeight(1).play();
    const walk = mixer.clipAction(template.walk).setEffectiveWeight(0).play();
    return { root, model, variant, mixer, idle, walk, tints, meshes, skeletons,
      materials: [...originals.values()], motion: 0, time: 0 };
  }

  private applyAppearance(actor: Actor, appearance: PedestrianAppearance) {
    const a = appearance;
    actor.root.scale.set(PERSON_WORLD_SCALE * (.97 + a.build * .06),
      PERSON_WORLD_SCALE * a.height, PERSON_WORLD_SCALE * (.98 + a.build * .04));
    Object.assign(actor.root.userData, {
      pedestrianId: a.seed, appearanceSignature: a.signature, outerwear: a.outerwear, headwear: a.headwear,
      height: PERSON_WORLD_HEIGHT * a.height, anatomyHeight: PERSON_WORLD_HEIGHT * a.height,
      authoredBodyHeight: PERSON_MODEL_HEIGHT, playerScale: PERSON_WORLD_SCALE, heightVariation: a.height,
    });
    for (const { material, original } of actor.tints) {
      material.color.copy(original.color);
      const semantic = original.name.toLowerCase();
      if (semantic.includes('coat')) material.color.setHex(a.coat);
      else if (semantic.includes('trousers')) material.color.setHex(a.trousers);
      else if (semantic.includes('boots') || semantic.includes('glove')) material.color.setHex(a.boots);
      else if (semantic.includes('scarf')) material.color.setHex(a.scarf);
      else if (semantic.includes('hat')) material.color.setHex(a.hat);
      else if (semantic.includes('hair')) {
        // Retain the photographed hair's shading and fine alpha strands.
        material.color.multiply(this.tint.setHex(a.hair).lerp(new THREE.Color(0xffffff), .38));
      } else if (semantic.includes('skin')) {
        // The source face atlas supplies pores and facial features. A restrained
        // multiplicative tint preserves those details across complexion shades.
        material.color.multiply(this.tint.setHex(a.skin).lerp(new THREE.Color(0xffffff), .52));
      }
    }
  }

  private pose(actor: Actor, request: Request, index: number) {
    actor.root.position.set(request.x, request.y + .008, request.z);
    actor.root.rotation.y = request.yaw;
    actor.root.visible = true;
    const dt = THREE.MathUtils.clamp(request.time - actor.time, 0, .1);
    const targetMotion = THREE.MathUtils.clamp(request.speed / .65, 0, 1);
    actor.motion += (targetMotion - actor.motion) * (1 - Math.exp(-dt * 12));
    actor.time = request.time;
    const cycle = THREE.MathUtils.euclideanModulo(request.phase, Math.PI * 2) / (Math.PI * 2);
    actor.walk.time = cycle * actor.walk.getClip().duration;
    actor.idle.time = THREE.MathUtils.euclideanModulo(request.time + request.appearance!.face * 7,
      actor.idle.getClip().duration);
    actor.idle.setEffectiveWeight(1 - actor.motion);
    actor.walk.setEffectiveWeight(actor.motion);
    // Pose is sampled from persistent travelled distance, so re-streaming a
    // person or pausing to yield never resets their gait to the first frame.
    actor.mixer.update(0);
    for (const mesh of actor.meshes) mesh.castShadow = index < 12;
  }

  private disposeActor(actor: Actor) {
    actor.root.removeFromParent();
    actor.mixer.stopAllAction();
    actor.mixer.uncacheRoot(actor.model);
    for (const skeleton of actor.skeletons) skeleton.dispose();
    for (const material of actor.materials) material.dispose();
    actor.root.clear();
  }

  /** The face/hair atlases are unchanged copies of the same player textures. */
  private shareAtlasTextures(model: THREE.Object3D) {
    const discarded = new Set<THREE.Texture>(), referenced = new Set<THREE.Texture>();
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        const semantic = material.name.toLowerCase();
        if (!/(skin|hair|eye|lash)/.test(semantic)) continue;
        const properties = material as unknown as Record<string, unknown>;
        for (const property of Object.keys(properties)) {
          const texture = properties[property];
          if (!(texture instanceof THREE.Texture) || !texture.name) continue;
          const image = texture.image as { width?: number; height?: number } | undefined;
          if (!image?.width || !image.height) continue;
          const role = semantic.includes('skin') ? 'skin' : semantic.includes('hair') ? 'hair' : 'eyes';
          const key = `${role}/${property}/${texture.name}/${image.width}x${image.height}/${texture.colorSpace}`;
          const existing = this.sharedTextures.get(key);
          if (existing && existing !== texture) { properties[property] = existing; discarded.add(texture); }
          else this.sharedTextures.set(key, texture);
        }
      }
    });
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) referenced.add(value);
      }
    });
    for (const texture of discarded) if (!referenced.has(texture)) texture.dispose();
  }
}

function sameSkinBinding(a: THREE.SkinnedMesh, b: THREE.SkinnedMesh) {
  const first = a.skeleton, second = b.skeleton;
  return a.bindMode === b.bindMode && a.bindMatrix.equals(b.bindMatrix)
    && a.bindMatrixInverse.equals(b.bindMatrixInverse)
    && first.bones.length === second.bones.length
    && first.boneInverses.length === second.boneInverses.length
    && first.bones.every((bone, index) => bone === second.bones[index]
      && first.boneInverses[index].equals(second.boneInverses[index]));
}

/** Compute once per authored asset; clones inherit these conservative local bounds. */
function boundAnimatedMeshes(model: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const meshes: { mesh: THREE.SkinnedMesh; box: THREE.Box3 }[] = [];
  model.traverse(object => {
    if (object instanceof THREE.SkinnedMesh) meshes.push({ mesh: object, box: new THREE.Box3() });
  });
  const mixer = new THREE.AnimationMixer(model);
  for (const clip of clips) {
    const action = mixer.clipAction(clip).play();
    for (let sample = 0; sample <= 12; sample++) {
      action.time = Math.min(clip.duration - 1e-6, sample / 12 * clip.duration);
      mixer.update(0);
      model.updateMatrixWorld(true);
      for (const { mesh, box } of meshes) {
        mesh.computeBoundingBox();
        box.union(mesh.boundingBox!);
      }
    }
    action.stop();
  }
  mixer.stopAllAction(); mixer.uncacheRoot(model);
  model.updateMatrixWorld(true);
  for (const { mesh, box } of meshes) {
    // Margin covers the smooth intervals between samples and blended clip poses.
    // Mesh-local units differ from metres in the retained player armature.
    const margin = .06 / Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis());
    box.expandByScalar(margin);
    mesh.boundingBox = box;
    mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    mesh.boundingSphere.radius *= 1.12;
  }
}

function disposeSourceResources(models: THREE.Object3D[], extraTextures: Iterable<THREE.Texture> = []) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>(extraTextures), skeletons = new Set<THREE.Skeleton>();
  for (const model of models) model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
