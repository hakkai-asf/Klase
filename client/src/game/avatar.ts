import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { BodyId, Look } from "@klase/shared";

const SKIN = 0xe8d5c4;
const BODY = 0xf2ebe3;

const xBotUrl = new URL("../../../assets/characters/X Bot.glb", import.meta.url).href;
const yBotUrl = new URL("../../../assets/characters/Y Bot.glb", import.meta.url).href;
const xBotSkinnedUrl = new URL("../../../assets/characters/Xbot.skinned.glb", import.meta.url).href;
const walkUrl = new URL("../../../assets/animations/walking/Walking.glb", import.meta.url).href;
const walkStartUrl = new URL("../../../assets/animations/walking/Start Walking.glb", import.meta.url).href;
const walkStopUrl = new URL("../../../assets/animations/walking/Stop Walking.glb", import.meta.url).href;
const idleUrl = new URL("../../../assets/animations/idle/Breathing Idle.glb", import.meta.url).href;

type LocoPhase = "idle" | "start" | "walk" | "stop";

type Rig = {
  template: THREE.Object3D;
  walk: THREE.AnimationClip;
  idle: THREE.AnimationClip | null;
  start: THREE.AnimationClip | null;
  stop: THREE.AnimationClip | null;
};

let rigs: { x: Rig; y: Rig } | null = null;
let previews: { x: THREE.Object3D; y: THREE.Object3D } | null = null;

function mat(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.02 });
}

function swingLimb(x: number, y: number, radius: number, length: number) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), mat(SKIN));
  mesh.position.y = -length / 2 - radius * 0.2;
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

function stripRootXZ(clip: THREE.AnimationClip) {
  const next = clip.clone();
  next.tracks = next.tracks.map((track) => {
    if (!/hips\.position/i.test(track.name)) return track;
    const t = track.clone();
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = 0;
      v[i + 2] = 0;
    }
    return t;
  });
  return next;
}

function nodeNames(root: THREE.Object3D) {
  const names = new Set<string>();
  root.traverse((o) => {
    if (o.name) names.add(o.name);
  });
  return names;
}

function resolveBoneName(raw: string, names: Set<string>) {
  if (names.has(raw)) return raw;
  const noColon = raw.replace(/:/g, "");
  if (names.has(noColon)) return noColon;
  const withColon = raw.includes(":") ? raw : raw.replace(/^mixamorig/, "mixamorig:");
  if (names.has(withColon)) return withColon;
  const tail = raw.split(":").pop() ?? raw;
  for (const n of names) {
    const nt = n.split(":").pop();
    if (n === tail || nt === tail || n.replace(/:/g, "") === noColon) return n;
  }
  return null;
}

function remapClip(clip: THREE.AnimationClip, root: THREE.Object3D, name = clip.name) {
  const names = nodeNames(root);
  const next = clip.clone();
  next.name = name;
  next.tracks = next.tracks.flatMap((track) => {
    const dot = track.name.lastIndexOf(".");
    if (dot < 0) return [track];
    const bone = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const match = resolveBoneName(bone, names);
    if (!match) return [];
    const t = track.clone();
    t.name = `${match}.${prop}`;
    return [t];
  });
  return stripRootXZ(next);
}

function firstClip(anims: THREE.AnimationClip[], fallbackName: string) {
  const clip = anims[0]?.clone();
  if (!clip) throw new Error(`No animation in ${fallbackName}`);
  return clip;
}

function tryRemap(clip: THREE.AnimationClip | null, root: THREE.Object3D, name: string) {
  if (!clip) return null;
  const remapped = remapClip(clip, root, name);
  return remapped.tracks.length > 0 ? remapped : null;
}

function adaptClip(clip: THREE.AnimationClip | null, root: THREE.Object3D, name: string) {
  if (!clip) return null;
  const names = nodeNames(root);
  const first = clip.tracks[0]?.name ?? "";
  const dot = first.lastIndexOf(".");
  const bone = dot >= 0 ? first.slice(0, dot) : "";
  if (bone && names.has(bone)) {
    const next = stripRootXZ(clip.clone());
    next.name = name;
    return next;
  }
  return tryRemap(clip, root, name);
}

function isSkinned(root: THREE.Object3D) {
  let skinned = false;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  return skinned;
}

function clipNamed(anims: THREE.AnimationClip[], re: RegExp) {
  return anims.find((a) => re.test(a.name))?.clone() ?? null;
}

async function rigFromGltf(
  scene: THREE.Object3D,
  anims: THREE.AnimationClip[],
  walkFallback: THREE.AnimationClip | null,
  idleFallback: THREE.AnimationClip | null,
  startFallback: THREE.AnimationClip | null,
  stopFallback: THREE.AnimationClip | null,
) {
  let walk = clipNamed(anims, /^walk$/i) ?? clipNamed(anims, /walk/i);
  if (walk) walk = stripRootXZ(walk);
  else walk = adaptClip(walkFallback, scene, "Walk");
  if (!walk) throw new Error("No walk clip");
  walk.name = "Walk";

  let idle = adaptClip(idleFallback, scene, "Idle") ?? clipNamed(anims, /idle/i);
  if (idle) {
    idle = stripRootXZ(idle);
    idle.name = "Idle";
  }
  const start = adaptClip(startFallback, scene, "WalkStart");
  const stop = adaptClip(stopFallback, scene, "WalkStop");
  return { template: scene, walk, idle, start, stop };
}

function cloneModel(template: THREE.Object3D) {
  let skinned = false;
  template.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  return skinned ? cloneSkinned(template) : template.clone(true);
}

function skeletonBox(root: THREE.Object3D) {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  let n = 0;
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    o.getWorldPosition(p);
    box.expandByPoint(p);
    n++;
  });
  return n > 2 ? box : null;
}

function measureBox(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  const bones = skeletonBox(model);
  if (bones && bones.max.y - bones.min.y > 0.25) return bones;
  return new THREE.Box3().setFromObject(model);
}

function fitToHeight(model: THREE.Object3D, meters = 1.7) {
  const box = measureBox(model);
  const h = box.max.y - box.min.y;
  if (h < 0.001) return;
  const s = meters / h;
  // Mixamo mesh AABBs are often ~2cm under a 0.01 armature; the skinned body is already meters.
  if (s < 8) model.scale.multiplyScalar(s);
  const planted = measureBox(model);
  model.position.y -= planted.min.y;
}

function enableShadows(model: THREE.Object3D) {
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}

async function loadGltf(url: string) {
  const loader = new GLTFLoader();
  return loader.loadAsync(url);
}

export async function preloadAvatars() {
  if (rigs) return;
  const [xGltf, yGltf, walkGltf, idleGltf, startGltf, stopGltf, skinnedGltf] = await Promise.all([
    loadGltf(xBotUrl),
    loadGltf(yBotUrl),
    loadGltf(walkUrl),
    loadGltf(idleUrl),
    loadGltf(walkStartUrl),
    loadGltf(walkStopUrl),
    loadGltf(xBotSkinnedUrl),
  ]);
  const walkFallback = firstClip(walkGltf.animations, "Walking.glb");
  const idleFallback = firstClip(idleGltf.animations, "Breathing Idle.glb");
  const startFallback = firstClip(startGltf.animations, "Start Walking.glb");
  const stopFallback = firstClip(stopGltf.animations, "Stop Walking.glb");
  previews = { x: xGltf.scene, y: yGltf.scene };
  const skinnedFallback = await rigFromGltf(
    skinnedGltf.scene,
    skinnedGltf.animations,
    walkFallback,
    idleFallback,
    startFallback,
    stopFallback,
  );

  const xSkinned = isSkinned(xGltf.scene);
  const ySkinned = isSkinned(yGltf.scene);
  if (!xSkinned || !ySkinned) {
    console.warn(
      "[Klase] X/Y Bot.glb have no skin weights (frozen T-pose). Using skinned Mixamo Xbot. Re-export with Armature, do not Apply the modifier.",
    );
  }

  const x = xSkinned
    ? await rigFromGltf(xGltf.scene, xGltf.animations, walkFallback, idleFallback, startFallback, stopFallback)
    : skinnedFallback;
  const y = ySkinned
    ? await rigFromGltf(yGltf.scene, yGltf.animations, walkFallback, idleFallback, startFallback, stopFallback)
    : skinnedFallback;
  rigs = { x, y };
}

function pickRig(body?: string): Rig | null {
  if (!rigs) return null;
  return body === "y" ? rigs.y : rigs.x;
}

function findBone(root: THREE.Object3D, re: RegExp) {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && re.test(o.name)) found = o;
  });
  return found;
}

function attachSockets(model: THREE.Object3D) {
  const sockets = {
    hat: new THREE.Group(),
    top: new THREE.Group(),
    accessory: new THREE.Group(),
  };
  const head = findBone(model, /head$/i);
  const chest = findBone(model, /spine2|chest|spine1$/i);
  const hips = findBone(model, /hips|pelvis$/i);
  (head ?? model).add(sockets.hat);
  sockets.hat.position.set(0, 0.12, 0);
  (chest ?? model).add(sockets.top);
  (hips ?? model).add(sockets.accessory);
  sockets.accessory.position.set(0, 0.1, -0.12);
  return sockets;
}

function nametagSprite(name: string, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.position.y = height + 0.18;
  sprite.scale.set(1.4, 0.35, 1);
  drawName(canvas, tex, name);
  return { canvas, tex, sprite };
}

function primitiveAvatar(look: Look, nametag: string) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 6, 12), mat(BODY));
  torso.position.y = 0.85;
  torso.castShadow = true;
  body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 16), mat(SKIN));
  head.position.y = 1.48;
  head.castShadow = true;
  body.add(head);
  const lArm = swingLimb(-0.38, 1.12, 0.08, 0.38);
  const rArm = swingLimb(0.38, 1.12, 0.08, 0.38);
  const lLeg = swingLimb(-0.14, 0.58, 0.1, 0.42);
  const rLeg = swingLimb(0.14, 0.58, 0.1, 0.42);
  body.add(lArm, rArm, lLeg, rLeg);
  const sockets = {
    hat: new THREE.Group(),
    top: new THREE.Group(),
    accessory: new THREE.Group(),
  };
  sockets.hat.position.set(0, 1.7, 0);
  sockets.top.position.set(0, 0.92, 0);
  sockets.accessory.position.set(0, 0.95, -0.22);
  body.add(sockets.hat, sockets.top, sockets.accessory);
  const tag = nametagSprite(nametag, 1.85);
  root.add(tag.sprite);
  applyLook(sockets, look);
  return {
    root,
    body,
    sockets,
    canvas: tag.canvas,
    tex: tag.tex,
    look: { ...look },
    limbs: { lArm, rArm, lLeg, rLeg },
    walkT: 0,
    lastX: 0,
    lastZ: 0,
    mixer: null as THREE.AnimationMixer | null,
    walkAction: null as THREE.AnimationAction | null,
    idleAction: null as THREE.AnimationAction | null,
    startAction: null as THREE.AnimationAction | null,
    stopAction: null as THREE.AnimationAction | null,
    phase: "idle" as LocoPhase,
    wantMove: false,
  };
}

export function createAvatar(look: Look, nametag: string) {
  const rig = pickRig(look.body);
  if (!rig) return primitiveAvatar(look, nametag);

  const root = new THREE.Group();
  const model = cloneModel(rig.template);
  fitToHeight(model, 1.7);
  enableShadows(model);
  const body = model;
  root.add(model);

  const sockets = attachSockets(model);
  const tag = nametagSprite(nametag, measureBox(model).max.y);
  root.add(tag.sprite);
  applyLook(sockets, look);

  const mixer = new THREE.AnimationMixer(model);
  const walkAction = mixer.clipAction(rig.walk);
  walkAction.setLoop(THREE.LoopRepeat, Infinity);
  walkAction.enabled = true;
  walkAction.setEffectiveWeight(0);
  walkAction.play();

  let idleAction: THREE.AnimationAction | null = null;
  if (rig.idle) {
    idleAction = mixer.clipAction(rig.idle);
    idleAction.setLoop(THREE.LoopRepeat, Infinity);
    idleAction.enabled = true;
    idleAction.setEffectiveWeight(1);
    idleAction.play();
  }

  let startAction: THREE.AnimationAction | null = null;
  if (rig.start) {
    startAction = mixer.clipAction(rig.start);
    startAction.setLoop(THREE.LoopOnce, 1);
    startAction.clampWhenFinished = true;
    startAction.enabled = true;
    startAction.setEffectiveWeight(0);
  }

  let stopAction: THREE.AnimationAction | null = null;
  if (rig.stop) {
    stopAction = mixer.clipAction(rig.stop);
    stopAction.setLoop(THREE.LoopOnce, 1);
    stopAction.clampWhenFinished = true;
    stopAction.enabled = true;
    stopAction.setEffectiveWeight(0);
  }
  mixer.update(1 / 30);

  return {
    root,
    body,
    sockets,
    canvas: tag.canvas,
    tex: tag.tex,
    look: { ...look },
    limbs: {
      lArm: new THREE.Group(),
      rArm: new THREE.Group(),
      lLeg: new THREE.Group(),
      rLeg: new THREE.Group(),
    },
    walkT: 0,
    lastX: 0,
    lastZ: 0,
    mixer,
    walkAction,
    idleAction,
    startAction,
    stopAction,
    phase: "idle" as LocoPhase,
    wantMove: false,
  };
}

function actionFinished(action: THREE.AnimationAction | null) {
  if (!action) return true;
  const dur = action.getClip().duration;
  return dur <= 0 || (!action.isRunning() && action.time >= dur - 0.05);
}

function playOnce(action: THREE.AnimationAction) {
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.paused = false;
  action.enabled = true;
  action.play();
}

function stepLoco(avatar: {
  phase: LocoPhase;
  wantMove: boolean;
  walkAction: THREE.AnimationAction;
  idleAction: THREE.AnimationAction | null;
  startAction: THREE.AnimationAction | null;
  stopAction: THREE.AnimationAction | null;
}) {
  if (avatar.wantMove) {
    if (avatar.phase === "idle" || avatar.phase === "stop") {
      if (avatar.startAction) {
        avatar.phase = "start";
        playOnce(avatar.startAction);
      } else {
        avatar.phase = "walk";
        avatar.walkAction.time = 0;
      }
    } else if (avatar.phase === "start" && actionFinished(avatar.startAction)) {
      avatar.phase = "walk";
      avatar.walkAction.time = 0;
    }
    return;
  }
  if (avatar.phase === "walk" || avatar.phase === "start") {
    if (avatar.stopAction) {
      avatar.phase = "stop";
      playOnce(avatar.stopAction);
    } else {
      avatar.phase = "idle";
    }
  } else if (avatar.phase === "stop" && actionFinished(avatar.stopAction)) {
    avatar.phase = "idle";
  }
}

function blendLoco(
  avatar: {
    phase: LocoPhase;
    walkAction: THREE.AnimationAction;
    idleAction: THREE.AnimationAction | null;
    startAction: THREE.AnimationAction | null;
    stopAction: THREE.AnimationAction | null;
  },
  dt: number,
) {
  const k = Math.min(1, 12 * dt);
  const w = {
    idle: avatar.phase === "idle" ? 1 : 0,
    start: avatar.phase === "start" ? 1 : 0,
    walk: avatar.phase === "walk" ? 1 : 0,
    stop: avatar.phase === "stop" ? 1 : 0,
  };
  const lerp = (action: THREE.AnimationAction | null, target: number) => {
    if (!action) return;
    const cur = action.getEffectiveWeight();
    action.setEffectiveWeight(cur + (target - cur) * k);
  };
  lerp(avatar.idleAction, w.idle);
  lerp(avatar.startAction, w.start);
  lerp(avatar.walkAction, w.walk);
  lerp(avatar.stopAction, w.stop);
}

export function poseWalk(
  avatar: {
    body: THREE.Group | THREE.Object3D;
    limbs: { lArm: THREE.Group; rArm: THREE.Group; lLeg: THREE.Group; rLeg: THREE.Group };
    walkT: number;
    mixer: THREE.AnimationMixer | null;
    walkAction: THREE.AnimationAction | null;
    idleAction?: THREE.AnimationAction | null;
    startAction?: THREE.AnimationAction | null;
    stopAction?: THREE.AnimationAction | null;
    phase?: LocoPhase;
    wantMove?: boolean;
  },
  dt: number,
  moving: boolean,
) {
  if (avatar.mixer && avatar.walkAction) {
    const loco = {
      phase: avatar.phase ?? "idle",
      wantMove: moving,
      walkAction: avatar.walkAction,
      idleAction: avatar.idleAction ?? null,
      startAction: avatar.startAction ?? null,
      stopAction: avatar.stopAction ?? null,
    };
    stepLoco(loco);
    avatar.phase = loco.phase;
    avatar.wantMove = moving;
    blendLoco(loco, dt);
    avatar.mixer.update(dt);
    return;
  }
  if (moving) {
    avatar.walkT += dt * 9;
    const swing = Math.sin(avatar.walkT) * 0.7;
    avatar.limbs.lLeg.rotation.x = swing;
    avatar.limbs.rLeg.rotation.x = -swing;
    avatar.limbs.lArm.rotation.x = -swing * 0.85;
    avatar.limbs.rArm.rotation.x = swing * 0.85;
    (avatar.body as THREE.Group).position.y = Math.abs(Math.sin(avatar.walkT * 2)) * 0.045;
  } else {
    avatar.limbs.lLeg.rotation.x *= 0.8;
    avatar.limbs.rLeg.rotation.x *= 0.8;
    avatar.limbs.lArm.rotation.x *= 0.8;
    avatar.limbs.rArm.rotation.x *= 0.8;
    (avatar.body as THREE.Group).position.y *= 0.8;
  }
}

export function drawName(canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, name: string) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(40, 42, 55, 0.55)";
  ctx.beginPath();
  ctx.roundRect(8, 12, 240, 40, 12);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "700 28px Nunito, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(name.slice(0, 18), 128, 40);
  tex.needsUpdate = true;
}

export function applyLook(
  sockets: { hat: THREE.Group; top: THREE.Group; accessory: THREE.Group },
  look: Look,
) {
  for (const s of Object.values(sockets)) {
    while (s.children.length) s.remove(s.children[0]!);
  }

  if (look.hat === "cap_red" || look.hat === "cap_blue") {
    const color = look.hat === "cap_red" ? 0xc45c4a : 0x4a6cb0;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(color));
    crown.rotation.x = Math.PI;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.22), mat(color));
    brim.position.set(0, -0.02, 0.22);
    sockets.hat.add(crown, brim);
  }
  if (look.hat === "beanie") {
    sockets.hat.add(new THREE.Mesh(new THREE.SphereGeometry(0.29, 16, 12, 0, Math.PI * 2, 0, 1.2), mat(0x6b8f71)));
  }

  if (look.top === "hoodie_blue" || look.top === "hoodie_pink") {
    const color = look.top === "hoodie_blue" ? 0x5b7cbf : 0xd989b0;
    const hoodie = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.5, 6, 12), mat(color));
    sockets.top.add(hoodie);
  }
  if (look.top === "vest") {
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.42), mat(0x6e5a3a));
    sockets.top.add(vest);
  }

  if (look.accessory === "backpack") {
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.18), mat(0x4d5a4a));
    sockets.accessory.add(pack);
  }
  if (look.accessory === "scarf") {
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 8, 16, Math.PI), mat(0xc97b5a));
    scarf.rotation.x = Math.PI / 2;
    scarf.position.set(0, 0.52, 0.22);
    sockets.accessory.add(scarf);
  }
}

export function paintBodyPortrait(img: HTMLImageElement, body: BodyId) {
  const src = previews?.[body] ?? pickRig(body)?.template;
  if (!src) return () => {};

  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(size, size, false);
  renderer.setClearColor(0xffffff, 1);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x8a909c, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(1.2, 2.4, 3.2);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const model = cloneModel(src);
  fitToHeight(model, 1.7);
  model.rotation.y = 0;
  scene.add(model);

  const rig = pickRig(body);
  if (isSkinned(model) && rig?.idle) {
    const mixer = new THREE.AnimationMixer(model);
    const idle = mixer.clipAction(rig.idle);
    idle.play();
    mixer.update(0.08);
    mixer.stopAllAction();
  }
  model.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 30);
  camera.position.set(0, 1.42, 2.05);
  camera.lookAt(0, 1.36, 0);
  renderer.render(scene, camera);
  img.src = canvas.toDataURL("image/png");
  img.alt = body === "y" ? "Y Bot" : "X Bot";

  renderer.dispose();
  return () => {
    img.removeAttribute("src");
  };
}
