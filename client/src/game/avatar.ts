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
const sitUrl = new URL("../../../assets/animations/sitting/Sitting Idle.glb", import.meta.url).href;

type LocoPhase = "idle" | "start" | "walk" | "stop";

type Rig = {
  template: THREE.Object3D;
  walk: THREE.AnimationClip;
  idle: THREE.AnimationClip | null;
  start: THREE.AnimationClip | null;
  stop: THREE.AnimationClip | null;
  sit: THREE.AnimationClip | null;
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

/** Mixamo animation-only GLBs omit node.children; this is the standard Mixamo tree. */
const MIXAMO_PARENT: Record<string, string> = {
  Spine: "Hips",
  Spine1: "Spine",
  Spine2: "Spine1",
  Neck: "Spine2",
  Head: "Neck",
  LeftShoulder: "Spine2",
  LeftArm: "LeftShoulder",
  LeftForeArm: "LeftArm",
  LeftHand: "LeftForeArm",
  RightShoulder: "Spine2",
  RightArm: "RightShoulder",
  RightForeArm: "RightArm",
  RightHand: "RightForeArm",
  LeftUpLeg: "Hips",
  LeftLeg: "LeftUpLeg",
  LeftFoot: "LeftLeg",
  LeftToeBase: "LeftFoot",
  RightUpLeg: "Hips",
  RightLeg: "RightUpLeg",
  RightFoot: "RightLeg",
  RightToeBase: "RightFoot",
  LeftHandThumb1: "LeftHand",
  LeftHandThumb2: "LeftHandThumb1",
  LeftHandThumb3: "LeftHandThumb2",
  LeftHandIndex1: "LeftHand",
  LeftHandIndex2: "LeftHandIndex1",
  LeftHandIndex3: "LeftHandIndex2",
  LeftHandMiddle1: "LeftHand",
  LeftHandMiddle2: "LeftHandMiddle1",
  LeftHandMiddle3: "LeftHandMiddle2",
  LeftHandRing1: "LeftHand",
  LeftHandRing2: "LeftHandRing1",
  LeftHandRing3: "LeftHandRing2",
  LeftHandPinky1: "LeftHand",
  LeftHandPinky2: "LeftHandPinky1",
  LeftHandPinky3: "LeftHandPinky2",
  RightHandThumb1: "RightHand",
  RightHandThumb2: "RightHandThumb1",
  RightHandThumb3: "RightHandThumb2",
  RightHandIndex1: "RightHand",
  RightHandIndex2: "RightHandIndex1",
  RightHandIndex3: "RightHandIndex2",
  RightHandMiddle1: "RightHand",
  RightHandMiddle2: "RightHandMiddle1",
  RightHandMiddle3: "RightHandMiddle2",
  RightHandRing1: "RightHand",
  RightHandRing2: "RightHandRing1",
  RightHandRing3: "RightHandRing2",
  RightHandPinky1: "RightHand",
  RightHandPinky2: "RightHandPinky1",
  RightHandPinky3: "RightHandPinky2",
};

type GltfNode = {
  name?: string;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};

function mixamoKey(name: string) {
  return name.replace(/^mixamorig:?/i, "");
}

function mixamoSource(nodes: GltfNode[], scale: number) {
  const bones = nodes.map((n) => {
    const b = new THREE.Bone();
    b.name = (n.name ?? "").replace(/:/g, "");
    if (n.translation) b.position.fromArray(n.translation).multiplyScalar(scale);
    if (n.rotation) b.quaternion.fromArray(n.rotation);
    if (n.scale) b.scale.fromArray(n.scale);
    return b;
  });
  const byKey = new Map(bones.map((b) => [mixamoKey(b.name), b]));
  for (const [child, parent] of Object.entries(MIXAMO_PARENT)) {
    const c = byKey.get(child);
    const p = byKey.get(parent);
    if (c && p) p.add(c);
  }
  const holder = new THREE.Group();
  holder.name = "MixamoSitSource";
  for (const b of bones) {
    if (!b.parent) holder.add(b);
  }
  return holder;
}

function bakeRestIntoClip(clip: THREE.AnimationClip, nodes: GltfNode[]) {
  const rest = new Map<string, THREE.Quaternion>();
  for (const n of nodes) {
    rest.set((n.name ?? "").replace(/:/g, ""), n.rotation ? new THREE.Quaternion().fromArray(n.rotation) : new THREE.Quaternion());
  }
  const q = new THREE.Quaternion();
  const r = new THREE.Quaternion();
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".quaternion")) continue;
    const restQ = rest.get(track.name.slice(0, -".quaternion".length));
    if (!restQ) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!);
      r.copy(restQ).multiply(q);
      v[i] = r.x;
      v[i + 1] = r.y;
      v[i + 2] = r.z;
      v[i + 3] = r.w;
    }
  }
  return clip;
}

function scaleHipPosition(clip: THREE.AnimationClip, scale: number) {
  for (const track of clip.tracks) {
    if (!/hips\.position/i.test(track.name)) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i++) v[i]! *= scale;
  }
}

function orderedBones(bones: THREE.Bone[]) {
  const set = new Set(bones);
  const out: THREE.Bone[] = [];
  const seen = new Set<THREE.Bone>();
  const visit = (b: THREE.Object3D | null) => {
    if (!b || !((b as THREE.Bone).isBone) || seen.has(b as THREE.Bone) || !set.has(b as THREE.Bone)) return;
    if (b.parent && set.has(b.parent as THREE.Bone)) visit(b.parent);
    seen.add(b as THREE.Bone);
    out.push(b as THREE.Bone);
  };
  for (const b of bones) visit(b);
  return out;
}

function bakeSitOntoTarget(sourceRoot: THREE.Object3D, targetRoot: THREE.Object3D, srcClip: THREE.AnimationClip, fps = 18) {
  const srcBy = new Map<string, THREE.Bone>();
  sourceRoot.traverse((o) => {
    if ((o as THREE.Bone).isBone) srcBy.set(o.name, o as THREE.Bone);
  });
  const pairs: THREE.Bone[] = [];
  targetRoot.traverse((o) => {
    if ((o as THREE.Bone).isBone && srcBy.has(o.name)) pairs.push(o as THREE.Bone);
  });
  const bones = orderedBones(pairs);
  const duration = srcClip.duration;
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const qSrc = new THREE.Quaternion();
  const qPar = new THREE.Quaternion();
  const qLoc = new THREE.Quaternion();
  const srcDir = new THREE.Vector3();
  const srcPos = new THREE.Vector3();
  const srcChildPos = new THREE.Vector3();
  const parentInv = new THREE.Quaternion();
  const desired = new THREE.Vector3();
  const tgtAxis = new THREE.Vector3();
  const pWorld = new THREE.Vector3();
  const quatTracks = bones.map((b) => ({
    bone: b,
    times: new Float32Array(frames),
    values: new Float32Array(frames * 4),
  }));
  const hip = bones.find((b) => /hips$/i.test(b.name));
  const hipPos = hip ? { times: new Float32Array(frames), values: new Float32Array(frames * 3) } : null;
  const srcMixer = new THREE.AnimationMixer(sourceRoot);
  const act = srcMixer.clipAction(srcClip);
  act.play();
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * duration;
    srcMixer.setTime(Math.min(t, Math.max(0, duration - 1e-4)));
    sourceRoot.updateMatrixWorld(true);
    for (const rec of quatTracks) {
      const src = srcBy.get(rec.bone.name)!;
      const tgtChild = rec.bone.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
      const srcChild = src.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
      if (tgtChild && srcChild && tgtChild.position.lengthSq() > 1e-8) {
        src.getWorldPosition(srcPos);
        srcChild.getWorldPosition(srcChildPos);
        srcDir.subVectors(srcChildPos, srcPos).normalize();
        if (rec.bone.parent) {
          rec.bone.parent.updateMatrixWorld(true);
          rec.bone.parent.getWorldQuaternion(qPar);
          parentInv.copy(qPar).invert();
          desired.copy(srcDir).applyQuaternion(parentInv);
        } else {
          desired.copy(srcDir);
        }
        tgtAxis.copy(tgtChild.position).normalize();
        qLoc.setFromUnitVectors(tgtAxis, desired);
      } else {
        src.getWorldQuaternion(qSrc);
        if (rec.bone.parent) {
          rec.bone.parent.updateMatrixWorld(true);
          rec.bone.parent.getWorldQuaternion(qPar);
          qLoc.copy(qPar).invert().multiply(qSrc);
        } else {
          qLoc.copy(qSrc);
        }
      }
      rec.bone.quaternion.copy(qLoc);
      rec.bone.updateMatrixWorld(true);
      rec.times[f] = t;
      qLoc.toArray(rec.values, f * 4);
    }
    if (hip && hipPos) {
      srcBy.get(hip.name)!.getWorldPosition(pWorld);
      if (hip.parent) hip.parent.worldToLocal(pWorld);
      hip.position.copy(pWorld);
      hip.updateMatrixWorld(true);
      hipPos.times[f] = t;
      hip.position.toArray(hipPos.values, f * 3);
    }
  }
  srcMixer.stopAllAction();
  const tracks: THREE.KeyframeTrack[] = quatTracks.map(
    (rec) => new THREE.QuaternionKeyframeTrack(`${rec.bone.name}.quaternion`, rec.times, rec.values),
  );
  if (hip && hipPos) {
    tracks.unshift(new THREE.VectorKeyframeTrack(`${hip.name}.position`, hipPos.times, hipPos.values));
  }
  return new THREE.AnimationClip("Sit", duration, tracks);
}

function retargetMixamoSit(clip: THREE.AnimationClip, nodes: GltfNode[], target: THREE.Object3D) {
  const src = mixamoSource(nodes, 0.01);
  const prepared = bakeRestIntoClip(clip.clone(), nodes);
  scaleHipPosition(prepared, 0.01);
  const baked = bakeSitOntoTarget(src, cloneSkinned(target), prepared);
  baked.name = "Sit";
  return stripRootXZ(baked);
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
  // Clips that shipped in the same GLB as the mesh bind reliably.
  // Mixamo-only files are fallbacks (and start/stop).
  let walk = clipNamed(anims, /^walk$/i) ?? adaptClip(walkFallback, scene, "Walk");
  if (walk) walk = stripRootXZ(walk);
  if (!walk) throw new Error("No walk clip");
  walk.name = "Walk";

  let idle = clipNamed(anims, /^idle$/i) ?? adaptClip(idleFallback, scene, "Idle");
  if (idle) {
    idle = stripRootXZ(idle);
    idle.name = "Idle";
  }
  const start = adaptClip(startFallback, scene, "WalkStart");
  const stop = adaptClip(stopFallback, scene, "WalkStop");
  return { template: scene, walk, idle, start, stop, sit: null as THREE.AnimationClip | null };
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
  const [xGltf, yGltf, walkGltf, idleGltf, startGltf, stopGltf, skinnedGltf, sitGltf] = await Promise.all([
    loadGltf(xBotUrl),
    loadGltf(yBotUrl),
    loadGltf(walkUrl),
    loadGltf(idleUrl),
    loadGltf(walkStartUrl),
    loadGltf(walkStopUrl),
    loadGltf(xBotSkinnedUrl),
    loadGltf(sitUrl),
  ]);
  const walkFallback = firstClip(walkGltf.animations, "Walking.glb");
  const idleFallback = firstClip(idleGltf.animations, "Breathing Idle.glb");
  const startFallback = firstClip(startGltf.animations, "Start Walking.glb");
  const stopFallback = firstClip(stopGltf.animations, "Stop Walking.glb");
  const sitFallback = firstClip(sitGltf.animations, "Sitting Idle.glb");
  const sitNodes = ((sitGltf as { parser?: { json?: { nodes?: GltfNode[] } } }).parser?.json?.nodes ?? []) as GltfNode[];
  previews = { x: xGltf.scene, y: yGltf.scene };
  const skinnedScene = cloneSkinned(skinnedGltf.scene);
  const skinnedFallback = await rigFromGltf(
    skinnedScene,
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
  x.sit = sitNodes.length ? retargetMixamoSit(sitFallback, sitNodes, x.template) : adaptClip(sitFallback, x.template, "Sit");
  y.sit =
    y === x
      ? x.sit
      : sitNodes.length
        ? retargetMixamoSit(sitFallback, sitNodes, y.template)
        : adaptClip(sitFallback, y.template, "Sit");
  rigs = { x, y };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    rigs = null;
    previews = null;
  });
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
  sprite.name = "nametag";
  drawName(canvas, tex, name);
  return { canvas, tex, sprite };
}

function speechSprite(height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 0 }),
  );
  sprite.position.y = height + 0.62;
  sprite.scale.set(1.85, 0.58, 1);
  sprite.visible = false;
  sprite.renderOrder = 12;
  sprite.name = "speech";
  return { canvas, tex, sprite };
}

function micSprite(height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.position.y = height + 0.5;
  sprite.scale.set(0.32, 0.48, 1);
  sprite.visible = false;
  sprite.renderOrder = 11;
  sprite.name = "mic";
  drawMic(canvas, tex, 0);
  return { canvas, tex, sprite };
}

function capsulePath(ctx: CanvasRenderingContext2D, cx: number, top: number, bot: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx - r, top + r);
  ctx.arc(cx, top + r, r, Math.PI, 0);
  ctx.lineTo(cx + r, bot - r);
  ctx.arc(cx, bot - r, r, 0, Math.PI);
  ctx.closePath();
}

export function drawMic(canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, fill: number) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const bodyTop = 10;
  const bodyBot = 56;
  const bodyR = 13;
  const f = Math.max(0, Math.min(1, fill));
  ctx.save();
  capsulePath(ctx, cx, bodyTop, bodyBot, bodyR - 2.5);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#3dba6a";
  ctx.fillRect(0, bodyBot - (bodyBot - bodyTop) * f, w, (bodyBot - bodyTop) * f);
  ctx.restore();
  ctx.strokeStyle = "#4a4e5c";
  ctx.lineWidth = 2.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  capsulePath(ctx, cx, bodyTop, bodyBot, bodyR);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, bodyBot, bodyR + 7, 0.12 * Math.PI, 0.88 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, bodyBot + 7);
  ctx.lineTo(cx, h - 12);
  ctx.moveTo(cx - 9, h - 12);
  ctx.lineTo(cx + 9, h - 12);
  ctx.stroke();
  tex.needsUpdate = true;
}

export function layoutHeadSprites(avatar: {
  headH: number;
  micSprite: THREE.Sprite;
  speechSprite: THREE.Sprite;
}) {
  const h = avatar.headH;
  avatar.micSprite.position.y = h + 0.5;
  avatar.speechSprite.position.y = avatar.micSprite.visible ? h + 0.98 : h + 0.62;
}

export function setLocalFpPresentation(
  avatar: {
    root: THREE.Object3D;
    body: THREE.Object3D;
    sockets: { hat: THREE.Group };
    micSprite: THREE.Sprite;
    speechSprite: THREE.Sprite;
  },
  firstPerson: boolean,
  seated = false,
) {
  avatar.root.visible = true;
  avatar.body.visible = true;
  const hideHead = firstPerson && seated;
  avatar.sockets.hat.visible = !hideHead;
  if (firstPerson) {
    avatar.micSprite.visible = false;
    avatar.speechSprite.visible = false;
  }
  const tag = avatar.root.getObjectByName("nametag");
  if (tag) tag.visible = !firstPerson;

  let headBone: THREE.Bone | null = null;
  avatar.body.traverse((o) => {
    const bone = o as THREE.Bone;
    if (!headBone && bone.isBone && /head$/i.test(o.name)) headBone = bone;
    if (o.name === "Head" && !bone.isBone) o.visible = !hideHead;
  });
  if (headBone) headBone.scale.setScalar(hideHead ? 0.001 : 1);
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
  head.name = "Head";
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
  const speech = speechSprite(1.85);
  const mic = micSprite(1.85);
  root.add(tag.sprite, speech.sprite, mic.sprite);
  applyLook(sockets, look);
  return {
    root,
    body,
    sockets,
    canvas: tag.canvas,
    tex: tag.tex,
    speechCanvas: speech.canvas,
    speechTex: speech.tex,
    speechSprite: speech.sprite,
    speechUntil: 0,
    speechFade: 0,
    headH: 1.85,
    micCanvas: mic.canvas,
    micTex: mic.tex,
    micSprite: mic.sprite,
    micFill: -1,
    voiceUntil: 0,
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
    sitAction: null as THREE.AnimationAction | null,
    phase: "idle" as LocoPhase,
    wantMove: false,
    phaseTime: 0,
  };
}

export function createAvatar(look: Look, nametag: string) {
  const rig = pickRig(look.body);
  if (!rig) return primitiveAvatar(look, nametag);

  const root = new THREE.Group();
  const model = cloneModel(rig.template);
  fitToHeight(model, 1.7);
  enableShadows(model);
  model.traverse((o) => {
    const sk = o as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh) sk.frustumCulled = false;
  });
  const body = model;
  root.add(model);

  const sockets = attachSockets(model);
  const headH = measureBox(model).max.y;
  const tag = nametagSprite(nametag, headH);
  const speech = speechSprite(headH);
  const mic = micSprite(headH);
  root.add(tag.sprite, speech.sprite, mic.sprite);
  applyLook(sockets, look);

  const mixer = new THREE.AnimationMixer(model);
  const walkAction = mixer.clipAction(rig.walk);
  walkAction.setLoop(THREE.LoopRepeat, Infinity);
  walkAction.enabled = true;
  walkAction.setEffectiveTimeScale(1);
  walkAction.setEffectiveWeight(0);
  walkAction.play();

  let idleAction: THREE.AnimationAction | null = null;
  if (rig.idle) {
    idleAction = mixer.clipAction(rig.idle);
    idleAction.setLoop(THREE.LoopRepeat, Infinity);
    idleAction.enabled = true;
    idleAction.setEffectiveTimeScale(1);
    idleAction.setEffectiveWeight(1);
    idleAction.play();
  }

  let sitAction: THREE.AnimationAction | null = null;
  if (rig.sit) {
    sitAction = mixer.clipAction(rig.sit);
    sitAction.setLoop(THREE.LoopRepeat, Infinity);
    sitAction.enabled = true;
    sitAction.setEffectiveTimeScale(1);
    sitAction.setEffectiveWeight(0);
    sitAction.play();
  }

  mixer.update(1 / 30);

  return {
    root,
    body,
    sockets,
    canvas: tag.canvas,
    tex: tag.tex,
    speechCanvas: speech.canvas,
    speechTex: speech.tex,
    speechSprite: speech.sprite,
    speechUntil: 0,
    speechFade: 0,
    headH,
    micCanvas: mic.canvas,
    micTex: mic.tex,
    micSprite: mic.sprite,
    micFill: -1,
    voiceUntil: 0,
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
    startAction: null as THREE.AnimationAction | null,
    stopAction: null as THREE.AnimationAction | null,
    sitAction,
    phase: "idle" as LocoPhase,
    wantMove: false,
    phaseTime: 0,
  };
}

function actionFinished(action: THREE.AnimationAction | null, elapsed: number) {
  if (!action) return true;
  const dur = action.getClip().duration;
  if (dur <= 0.04) return true;
  if (elapsed >= dur - 0.04) return true;
  return !action.isRunning() && elapsed > 0.12;
}

function playOnce(action: THREE.AnimationAction) {
  action.enabled = true;
  action.paused = false;
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.reset();
  action.play();
}

function stepLoco(avatar: {
  phase: LocoPhase;
  phaseTime: number;
  wantMove: boolean;
  walkAction: THREE.AnimationAction;
  idleAction: THREE.AnimationAction | null;
  startAction: THREE.AnimationAction | null;
  stopAction: THREE.AnimationAction | null;
}) {
  const startDur = avatar.startAction?.getClip().duration ?? 0;
  const stopDur = avatar.stopAction?.getClip().duration ?? 0;

  if (avatar.wantMove) {
    if (avatar.phase === "idle" || avatar.phase === "stop") {
      if (avatar.startAction && startDur > 0.08) {
        avatar.phase = "start";
        avatar.phaseTime = 0;
        playOnce(avatar.startAction);
      } else {
        avatar.phase = "walk";
        avatar.phaseTime = 0;
      }
    } else if (avatar.phase === "start" && actionFinished(avatar.startAction, avatar.phaseTime)) {
      avatar.phase = "walk";
      avatar.phaseTime = 0;
    }
    return;
  }
  if (avatar.phase === "walk" || avatar.phase === "start") {
    if (avatar.stopAction && stopDur > 0.08) {
      avatar.phase = "stop";
      avatar.phaseTime = 0;
      playOnce(avatar.stopAction);
    } else {
      avatar.phase = "idle";
      avatar.phaseTime = 0;
    }
  } else if (avatar.phase === "stop" && actionFinished(avatar.stopAction, avatar.phaseTime)) {
    avatar.phase = "idle";
    avatar.phaseTime = 0;
  }
}

function setActionWeight(action: THREE.AnimationAction | null, target: number, k: number) {
  if (!action) return;
  action.enabled = true;
  action.paused = false;
  action.setEffectiveTimeScale(1);
  const cur = action.getEffectiveWeight();
  action.setEffectiveWeight(cur + (target - cur) * k);
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
    sitAction?: THREE.AnimationAction | null;
    phase?: LocoPhase;
    wantMove?: boolean;
    phaseTime?: number;
  },
  dt: number,
  moving: boolean,
  seated = false,
) {
  if (avatar.mixer && avatar.walkAction) {
    const k = Math.min(1, 10 * dt);
    if (seated && avatar.sitAction) {
      const sit = avatar.sitAction;
      if (!sit.isRunning() || sit.getEffectiveWeight() < 0.99) {
        avatar.mixer.stopAllAction();
        sit.reset();
        sit.enabled = true;
        sit.paused = false;
        sit.setEffectiveWeight(1);
        sit.play();
      }
      sit.setEffectiveWeight(1);
      sit.paused = false;
      sit.enabled = true;
      if (avatar.walkAction) {
        avatar.walkAction.enabled = false;
        avatar.walkAction.setEffectiveWeight(0);
      }
      if (avatar.idleAction) {
        avatar.idleAction.enabled = false;
        avatar.idleAction.setEffectiveWeight(0);
      }
      if (avatar.startAction) {
        avatar.startAction.enabled = false;
        avatar.startAction.setEffectiveWeight(0);
      }
      if (avatar.stopAction) {
        avatar.stopAction.enabled = false;
        avatar.stopAction.setEffectiveWeight(0);
      }
    } else {
      if (avatar.walkAction) {
        avatar.walkAction.enabled = true;
        avatar.walkAction.paused = false;
        if (!avatar.walkAction.isScheduled()) avatar.walkAction.play();
      }
      if (avatar.idleAction) {
        avatar.idleAction.enabled = true;
        avatar.idleAction.paused = false;
        if (!avatar.idleAction.isRunning()) avatar.idleAction.play();
      }
      if (avatar.sitAction) {
        avatar.sitAction.enabled = false;
        avatar.sitAction.setEffectiveWeight(0);
      }
      setActionWeight(avatar.walkAction, moving ? 1 : 0, k);
      setActionWeight(avatar.idleAction ?? null, moving ? 0 : 1, k);
      setActionWeight(avatar.startAction ?? null, 0, 1);
      setActionWeight(avatar.stopAction ?? null, 0, 1);
    }
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

export function drawSpeech(canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, text: string) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const raw = text.replace(/\s+/g, " ").trim().slice(0, 120);
  ctx.font = "700 28px Nunito, sans-serif";
  const maxWidth = w - 48;
  const words = raw.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length === 3) break;
    } else {
      cur = test;
    }
  }
  if (lines.length < 3 && cur) lines.push(cur);
  if (lines.length === 3 && (cur !== lines[2] || words.join(" ") !== raw)) {
    let last = lines[2] ?? "";
    while (last.length && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[2] = `${last}…`;
  }
  const lineH = 34;
  const padY = 18;
  const boxH = padY * 2 + lines.length * lineH;
  const boxY = h - boxH - 18;
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.strokeStyle = "rgba(40, 42, 55, 0.12)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(16, boxY, w - 32, boxH, 18);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w / 2 - 14, boxY + boxH);
  ctx.lineTo(w / 2, boxY + boxH + 14);
  ctx.lineTo(w / 2 + 14, boxY + boxH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#2a2d3a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, boxY + padY + lineH * i + lineH / 2);
  });
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
  const rig = pickRig(body);
  const src = rig?.template;
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x2a211c, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffe4c8, 0x3a2a22, 1.15));
  const sun = new THREE.DirectionalLight(0xfff1e0, 1.35);
  sun.position.set(1.6, 2.2, 2.4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffc090, 0.55);
  fill.position.set(-1.4, 1.2, 1.6);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffe8d4, 0.35));

  const model = cloneModel(src);
  fitToHeight(model, 1.7);
  model.rotation.y = 0.35;
  if (body === "y") {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const srcMat = mesh.material;
      const list = (Array.isArray(srcMat) ? srcMat : [srcMat]).map((mat) => {
        const next = (mat as THREE.MeshStandardMaterial).clone();
        next.color?.offsetHSL(0.035, 0.12, 0.06);
        return next;
      });
      mesh.material = Array.isArray(srcMat) ? list : list[0]!;
    });
  }
  scene.add(model);

  if (isSkinned(model) && rig?.idle) {
    const mixer = new THREE.AnimationMixer(model);
    const idle = mixer.clipAction(rig.idle);
    idle.play();
    mixer.update(0.35);
    mixer.stopAllAction();
  }
  model.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 30);
  camera.position.set(0.78, 1.38, 1.92);
  camera.lookAt(0, 1.22, 0);
  renderer.render(scene, camera);
  img.src = canvas.toDataURL("image/png");
  img.alt = body === "y" ? "Y Bot" : "X Bot";

  renderer.dispose();
  return () => {
    img.removeAttribute("src");
  };
}
