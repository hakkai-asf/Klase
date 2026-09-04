import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BACK_CHAIRS, CLASSROOM, DESK_GRID, PLAYER_RADIUS, backChairCell, classroomSeats, clampClassroom, deskCell, resolvePlayerMove, type Seat } from "@klase/shared";

export type { Seat };
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

const classroomUrl = new URL("../../../assets/classroom/cleaned-classroom.glb", import.meta.url).href;
const nuChairUrl = new URL("../../../assets/furnitures/nu-chair.glb", import.meta.url).href;
const ceilingUrl = new URL("../../../assets/textures/ceiling-texture.glb", import.meta.url).href;
const floorUrl = new URL("../../../assets/textures/floor-texture.glb", import.meta.url).href;
const ceilingLightUrl = new URL("../../../assets/classroom/ceiling-light.glb", import.meta.url).href;
const tableUrl = new URL("../../../assets/furnitures/school table.glb", import.meta.url).href;
const tvUrl = new URL("../../../assets/furnitures/flat-screen_tv.glb", import.meta.url).href;
const whiteboardUrl = new URL("../../../assets/furnitures/whiteboard.glb", import.meta.url).href;
const doorUrl = new URL("../../../assets/classroom/door.glb", import.meta.url).href;
const airconUrl = new URL("../../../assets/furnitures/aircon.glb", import.meta.url).href;

const ROOM = {
  wall: 0xe3e0db,
  door: 0xc8b79d,
  ceiling: 0xfaf8f6,
  ceilingLine: 0xa8a49e,
  floor: 0xe8dfd4,
  board: 0xb1c5c4,
};

function flattenPaint(std: THREE.MeshStandardMaterial, hex: number) {
  std.color.setHex(hex);
  std.map = null;
  std.lightMap = null;
  std.roughnessMap = null;
  std.metalnessMap = null;
  std.aoMap = null;
  std.normalMap = null;
  std.emissiveMap = null;
}

type Kit = {
  classroom: THREE.Object3D;
  nuChair: THREE.Object3D;
  ceiling: THREE.Object3D;
  floor: THREE.Object3D;
  ceilingLight: THREE.Object3D;
  table: THREE.Object3D;
  tv: THREE.Object3D;
  whiteboard: THREE.Object3D;
  door: THREE.Object3D;
  aircon: THREE.Object3D;
};

let kit: Kit | null = null;

export async function preloadClassroom() {
  if (kit) return;
  const gltf = new GLTFLoader();
  const [room, chair, ceiling, floor, light, table, tv, board, door, aircon] = await Promise.all([
    gltf.loadAsync(classroomUrl),
    gltf.loadAsync(nuChairUrl),
    gltf.loadAsync(ceilingUrl),
    gltf.loadAsync(floorUrl),
    gltf.loadAsync(ceilingLightUrl),
    gltf.loadAsync(tableUrl),
    gltf.loadAsync(tvUrl),
    gltf.loadAsync(whiteboardUrl),
    gltf.loadAsync(doorUrl),
    gltf.loadAsync(airconUrl),
  ]);
  kit = {
    classroom: room.scene,
    nuChair: chair.scene,
    ceiling: ceiling.scene,
    floor: floor.scene,
    ceilingLight: light.scene,
    table: table.scene,
    tv: tv.scene,
    whiteboard: board.scene,
    door: door.scene,
    aircon: aircon.scene,
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    kit = null;
  });
}

function meshBounds(mesh: THREE.Mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  return { box, size };
}

function matName(mesh: THREE.Mesh) {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return `${mesh.name} ${(mat as THREE.Material)?.name ?? ""}`;
}

function isCeilingDetail(box: THREE.Box3, size: THREE.Vector3) {
  return box.min.y > 3 && size.y < 0.5;
}

function isReplacedSurface(mesh: THREE.Mesh) {
  return (
    mesh.name === "Material3_6" ||
    mesh.name === "Material3_6_1" ||
    mesh.name === "Material2_9" ||
    mesh.name === "Material2_10" ||
    mesh.name === "Material2_11" ||
    mesh.name === "Material2_12" ||
    mesh.name === "Material2_13" ||
    mesh.name === "Material2_14" ||
    mesh.name === "Material3_7"
  );
}

function isDoorGlass(mesh: THREE.Mesh) {
  return mesh.name === "Material2" || /Translucent_Glass_Gray_1|Material3_10/i.test(matName(mesh));
}

function isWindowWall(mesh: THREE.Mesh) {
  return mesh.name === "Material2_6" || /Translucent_Glass_Gray_2/i.test(matName(mesh));
}

function flushBoard(mesh: THREE.Mesh) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const innerZ = -CLASSROOM.depth / 2 + CLASSROOM.wallThickness;
  mesh.position.z += innerZ + 0.04 - box.max.z;
  mesh.renderOrder = 2;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const std = mat as THREE.MeshStandardMaterial;
    std.side = THREE.FrontSide;
    std.polygonOffset = true;
    std.polygonOffsetFactor = -1;
    std.polygonOffsetUnits = -1;
  }
}

function isGlbWall(mesh: THREE.Mesh) {
  return (
    mesh.name === "Material2_7" ||
    mesh.name === "Material3_8" ||
    mesh.name === "Material3_9" ||
    isDoorGlass(mesh) ||
    isWindowWall(mesh)
  );
}

function lerpAttr(out: number[], attr: THREE.BufferAttribute, i0: number, i1: number, t: number) {
  const n = attr.itemSize;
  const arr = attr.array;
  for (let c = 0; c < n; c++) {
    const a = arr[i0 * n + c]!;
    const b = arr[i1 * n + c]!;
    out.push(a + (b - a) * t);
  }
}

function copyAttr(out: number[], attr: THREE.BufferAttribute, i: number) {
  const n = attr.itemSize;
  const arr = attr.array;
  for (let c = 0; c < n; c++) out.push(arr[i * n + c]!);
}

/** Keep z <= cutZ. Splits room-spanning tris so left/right walls stay on the board half. */
function clipMeshMaxZ(mesh: THREE.Mesh, cutZ: number) {
  mesh.updateMatrixWorld(true);
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const pos = src.getAttribute("position");
  if (!pos) return;
  const names = Object.keys(src.attributes);
  const buckets: Record<string, number[]> = {};
  for (const name of names) buckets[name] = [];
  const world = new THREE.Vector3();
  const zAt = (i: number) => {
    world.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    return world.z;
  };
  const emitIndex = (i: number) => {
    for (const name of names) copyAttr(buckets[name]!, src.getAttribute(name) as THREE.BufferAttribute, i);
  };
  const emitLerp = (i0: number, i1: number, t: number) => {
    for (const name of names) lerpAttr(buckets[name]!, src.getAttribute(name) as THREE.BufferAttribute, i0, i1, t);
  };
  const emitPoly = (verts: { i?: number; i0?: number; i1?: number; t?: number }[]) => {
    if (verts.length < 3) return;
    const fan = (a: number, b: number, c: number) => {
      const va = verts[a]!;
      const vb = verts[b]!;
      const vc = verts[c]!;
      for (const v of [va, vb, vc]) {
        if (v.i !== undefined) emitIndex(v.i);
        else emitLerp(v.i0!, v.i1!, v.t!);
      }
    };
    fan(0, 1, 2);
    if (verts.length === 4) fan(0, 2, 3);
  };

  const triCount = Math.floor(pos.count / 3);
  let outTris = 0;
  let clipped = false;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    const z0 = zAt(i0);
    const z1 = zAt(i1);
    const z2 = zAt(i2);
    const in0 = z0 <= cutZ;
    const in1 = z1 <= cutZ;
    const in2 = z2 <= cutZ;
    const nIn = (in0 ? 1 : 0) + (in1 ? 1 : 0) + (in2 ? 1 : 0);
    if (nIn === 3) {
      emitIndex(i0);
      emitIndex(i1);
      emitIndex(i2);
      outTris++;
      continue;
    }
    clipped = true;
    if (nIn === 0) continue;
    const idx = [i0, i1, i2];
    const zin = [z0, z1, z2];
    const inside = [in0, in1, in2];
    const poly: { i?: number; i0?: number; i1?: number; t?: number }[] = [];
    for (let e = 0; e < 3; e++) {
      const cur = e;
      const nxt = (e + 1) % 3;
      if (inside[cur]) poly.push({ i: idx[cur] });
      if (inside[cur] !== inside[nxt]) {
        const dz = zin[nxt]! - zin[cur]!;
        const tEdge = Math.abs(dz) < 1e-8 ? 0 : (cutZ - zin[cur]!) / dz;
        poly.push({ i0: idx[cur], i1: idx[nxt], t: Math.min(1, Math.max(0, tEdge)) });
      }
    }
    const before = buckets.position!.length;
    emitPoly(poly);
    outTris += (buckets.position!.length - before) / (pos.itemSize * 3);
  }

  if (!clipped && outTris === triCount) return;
  if (outTris === 0) {
    mesh.visible = false;
    return;
  }
  const next = new THREE.BufferGeometry();
  for (const name of names) {
    const attr = src.getAttribute(name)!;
    next.setAttribute(name, new THREE.BufferAttribute(new Float32Array(buckets[name]!), attr.itemSize));
  }
  next.computeVertexNormals();
  mesh.geometry = next;
}

function prepareProp(
  src: THREE.Object3D,
  opts: { height?: number; width?: number; depth?: number; flip?: boolean; stretch?: boolean; rotZ?: number } = {},
) {
  const root = new THREE.Group();
  const model = src.clone(true);
  if (opts.flip) model.rotation.x = Math.PI;
  if (opts.rotZ) model.rotation.z = opts.rotZ;
  root.add(model);
  root.updateMatrixWorld(true);
  const size0 = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  if (opts.stretch) {
    model.scale.x *= opts.width ? opts.width / Math.max(size0.x, 0.001) : 1;
    model.scale.y *= opts.height ? opts.height / Math.max(size0.y, 0.001) : 1;
    model.scale.z *= opts.depth ? opts.depth / Math.max(size0.z, 0.001) : 1;
  } else {
    let s = Number.POSITIVE_INFINITY;
    if (opts.height) s = Math.min(s, opts.height / Math.max(size0.y, 0.001));
  if (opts.width) s = Math.min(s, opts.width / Math.max(size0.x, 0.001));
  if (opts.depth) s = Math.min(s, opts.depth / Math.max(size0.z, 0.001));
    if (!Number.isFinite(s)) s = 1;
    if (Math.abs(s - 1) > 0.001) model.scale.multiplyScalar(s);
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  model.position.x -= c.x;
  model.position.z -= c.z;
  model.position.y -= box.min.y;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
  });
  return root;
}

function aabbOf(obj: THREE.Object3D, pad = 0.06): AABB {
  const box = new THREE.Box3().setFromObject(obj);
  return {
    minX: box.min.x - pad,
    maxX: box.max.x + pad,
    minZ: box.min.z - pad,
    maxZ: box.max.z + pad,
  };
}

function placeInstancedChairs(
  scene: THREE.Scene,
  src: THREE.Object3D,
  poses: { x: number; z: number }[],
  rotY: number,
  opts: { height?: number; width?: number; depth?: number },
  colliders: AABB[],
) {
  if (!poses.length) return;
  const proto = prepareProp(src, opts);
  proto.updateMatrixWorld(true);
  const parts: THREE.Mesh[] = [];
  proto.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) parts.push(mesh);
  });
  const dummy = new THREE.Object3D();
  const local = new THREE.Matrix4();
  for (const part of parts) {
    const inst = new THREE.InstancedMesh(part.geometry, part.material, poses.length);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    local.copy(part.matrixWorld);
    for (let i = 0; i < poses.length; i++) {
      dummy.position.set(poses[i]!.x, 0, poses[i]!.z);
      dummy.rotation.set(0, rotY, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix.multiply(local));
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
  }
  for (const pose of poses) {
    proto.position.set(pose.x, 0, pose.z);
    proto.rotation.y = rotY;
    proto.updateMatrixWorld(true);
    colliders.push(aabbOf(proto, 0.04));
  }
}

function place(
  scene: THREE.Scene,
  src: THREE.Object3D,
  x: number,
  z: number,
  rotY: number,
  opts: { height?: number; width?: number; depth?: number; y?: number },
) {
  const prop = prepareProp(src, opts);
  prop.position.set(x, opts.y ?? 0, z);
  prop.rotation.y = rotY;
  scene.add(prop);
  prop.updateMatrixWorld(true);
  return prop;
}

function placeOnFrontWall(
  scene: THREE.Scene,
  src: THREE.Object3D,
  x: number,
  y: number,
  opts: { width?: number; height?: number; rotY?: number; poke?: number; flip?: boolean },
) {
  const prop = prepareProp(src, opts);
  prop.rotation.y = opts.rotY ?? 0;
  prop.position.set(x, y, 0);
  scene.add(prop);
  prop.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(prop);
  const innerZ = -CLASSROOM.depth / 2 + CLASSROOM.wallThickness;
  prop.position.z += innerZ + (opts.poke ?? 0.04) - box.min.z;
  prop.updateMatrixWorld(true);
  return prop;
}

function paintWhiteboard(root: THREE.Object3D) {
  const board = new THREE.MeshStandardMaterial({
    color: ROOM.board,
    roughness: 0.18,
    metalness: 0.42,
    envMapIntensity: 1.15,
    side: THREE.FrontSide,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x8a8884,
    roughness: 0.45,
    metalness: 0.55,
  });
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = /WhiteBoard/i.test(mesh.name) ? board : trim;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
}

function paintTable(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0xd0cdc8,
      roughness: 0.62,
      metalness: 0.06,
    });
  });
}

function paintDoor(root: THREE.Object3D) {
  const wood = new THREE.MeshStandardMaterial({
    color: ROOM.door,
    roughness: 0.7,
    metalness: 0.04,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0xc8ccd0,
    roughness: 0.3,
    metalness: 0.72,
  });
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = /Cylinder/i.test(mesh.name) ? metal : wood;
  });
}

function placeOnLeftWall(
  scene: THREE.Scene,
  src: THREE.Object3D,
  z: number,
  y: number,
  opts: {
    width?: number;
    height?: number;
    depth?: number;
    rotY?: number;
    poke?: number;
    flip?: boolean;
    stretch?: boolean;
    rotZ?: number;
  },
) {
  const prop = prepareProp(src, opts);
  prop.rotation.y = opts.rotY ?? -Math.PI / 2;
  prop.position.set(0, y, z);
  scene.add(prop);
  prop.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(prop);
  const innerX = -CLASSROOM.width / 2 + CLASSROOM.wallThickness;
  prop.position.x += innerX + (opts.poke ?? 0.02) - box.min.x;
  prop.updateMatrixWorld(true);
  return prop;
}

function addLeftWallFurniture(scene: THREE.Scene, pack: Kit, colliders: AABB[]) {
  const { depth: d, wallThickness: t, cutZ } = CLASSROOM;
  const minZ = -d / 2 + t;
  const maxZ = cutZ - t;
  const doorW = 1.38;
  const doorH = 2.62;
  const acAlong = 2.45;
  const acH = 0.68;
  const acDeep = 0.42;
  const edge = 0.62;
  const acGap = 0.38;
  const frontDoorZ = minZ + edge + doorW / 2;
  const backDoorZ = maxZ - edge - doorW / 2;
  const frontAcZ = frontDoorZ + doorW / 2 + acGap + acAlong / 2;
  const backAcZ = backDoorZ - doorW / 2 - acGap - acAlong / 2;
  const acY = CEILING_Y - acH;

  const frontDoor = placeOnLeftWall(scene, pack.door, frontDoorZ, 0, {
    width: doorW,
    height: doorH,
    rotY: -Math.PI / 2,
    poke: 0.015,
  });
  paintDoor(frontDoor);
  colliders.push(aabbOf(frontDoor, 0.02));
  const backDoor = placeOnLeftWall(scene, pack.door, backDoorZ, 0, {
    width: doorW,
    height: doorH,
    rotY: -Math.PI / 2,
    poke: 0.015,
  });
  paintDoor(backDoor);
  colliders.push(aabbOf(backDoor, 0.02));

  const acOpts = {
    width: acAlong,
    height: acH,
    depth: acDeep,
    stretch: true,
    rotY: Math.PI / 2,
    poke: 0.02,
  };
  const frontAc = placeOnLeftWall(scene, pack.aircon, frontAcZ, acY, acOpts);
  const backAc = placeOnLeftWall(scene, pack.aircon, backAcZ, acY, acOpts);
  liftAircon(frontAc);
  copyMeshMaterials(frontAc, backAc);
  for (const ac of [frontAc, backAc]) {
    ac.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ac);
    ac.position.y += CEILING_Y - box.max.y;
    ac.updateMatrixWorld(true);
  }
}

function addFrontFurniture(scene: THREE.Scene, pack: Kit, colliders: AABB[]) {
  const innerZ = -CLASSROOM.depth / 2 + CLASSROOM.wallThickness;
  const table = place(scene, pack.table, 0, innerZ + 1.55, 0, { width: 4.25, height: 0.95 });
  paintTable(table);
  colliders.push(aabbOf(table, 0.05));
  const tv = placeOnFrontWall(scene, pack.tv, 0, 2.12, {
    width: 2.05,
    rotY: Math.PI,
    poke: 0.2,
    flip: true,
  });
  tv.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0x1c1c1e,
      roughness: 0.22,
      metalness: 0.65,
    });
  });
  const left = placeOnFrontWall(scene, pack.whiteboard, -3.2, 0.82, { width: 3.8, rotY: Math.PI, poke: 0.03 });
  paintWhiteboard(left);
  const right = placeOnFrontWall(scene, pack.whiteboard, 3.2, 0.82, { width: 3.8, rotY: Math.PI, poke: 0.03 });
  paintWhiteboard(right);
}

function addHollowWalls(colliders: AABB[]) {
  const { width: w, depth: d, wallThickness: t, cutZ } = CLASSROOM;
  const minZ = -d / 2;
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ, maxZ: minZ + t });
  colliders.push({ minX: -w / 2, maxX: -w / 2 + t, minZ, maxZ: cutZ });
  colliders.push({ minX: w / 2 - t, maxX: w / 2, minZ, maxZ: cutZ });
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: cutZ - t, maxZ: cutZ });
}

function addCutWall(fpWalls: THREE.Group, mat: THREE.MeshStandardMaterial) {
  const { width: w, wallHeight: h, wallThickness: t, cutZ } = CLASSROOM;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), mat);
  wall.position.set(0, h / 2, cutZ - t / 2);
  wall.castShadow = false;
  wall.receiveShadow = false;
  fpWalls.add(wall);
}

function addRoomWalls(scene: THREE.Scene, fpWalls: THREE.Group) {
  const { width: w, wallHeight: h, wallThickness: t, cutZ, depth: d } = CLASSROOM;
  const minZ = -d / 2;
  const playD = cutZ - minZ;
  const midZ = (minZ + cutZ) / 2;
  const mat = new THREE.MeshStandardMaterial({ color: ROOM.wall, roughness: 1, metalness: 0 });
  const y = h / 2;

  const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), mat);
  board.position.set(0, y, minZ + t / 2);
  board.castShadow = false;
  board.receiveShadow = false;
  scene.add(board);

  const left = new THREE.Mesh(new THREE.BoxGeometry(t, h, playD), mat);
  left.position.set(-w / 2 + t / 2, y, midZ);
  left.castShadow = false;
  left.receiveShadow = false;
  scene.add(left);

  const right = new THREE.Mesh(new THREE.BoxGeometry(t, h, playD), mat.clone());
  right.position.set(w / 2 - t / 2, y, midZ);
  right.castShadow = false;
  right.receiveShadow = false;
  fpWalls.add(right);

  addCutWall(fpWalls, mat.clone());
}

function fallbackRoom(scene: THREE.Scene, fpWalls: THREE.Group) {
  const { width: w, wallHeight: h, wallThickness: t, cutZ, depth: d } = CLASSROOM;
  const playD = cutZ + d / 2;
  const midZ = (cutZ - d / 2) / 2;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, playD),
    new THREE.MeshStandardMaterial({ color: ROOM.floor, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = midZ;
  scene.add(floor);
  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(w, t, playD),
    new THREE.MeshStandardMaterial({ color: ROOM.ceiling, roughness: 0.75 }),
  );
  ceiling.position.set(0, h, midZ);
  fpWalls.add(ceiling);
}

function fitClassroom(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x;
  root.position.z -= c.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

function prepRoomMesh(mesh: THREE.Mesh) {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const next = src.map((mat) => (mat as THREE.MeshStandardMaterial).clone());
  mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
}

function paintRoomSurfaces(mesh: THREE.Mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const std = mat as THREE.MeshStandardMaterial;
    const name = `${mesh.name} ${std.name ?? ""}`;
    if (mesh.name === "Material2_7" || /0128_White/i.test(name)) flattenPaint(std, ROOM.wall);
    else if (mesh.name === "Material3_8" || /Color_003/i.test(name)) flattenPaint(std, ROOM.door);
    else if (mesh.name === "Material3_16" || /whiteboard/i.test(name)) flattenPaint(std, ROOM.board);
  }
}

function playSpan() {
  const { width: w, depth: d, wallThickness: t, cutZ } = CLASSROOM;
  const minZ = -d / 2;
  const spanZ = cutZ - minZ;
  return { w, t, minZ, spanZ, midZ: minZ + spanZ / 2, innerW: w - t * 2 };
}

function wrapCentered(src: THREE.Object3D) {
  const wrap = new THREE.Group();
  const model = src.clone(true);
  wrap.add(model);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  model.position.set(-c.x, -box.min.y, -c.z);
  return { wrap, size: box.getSize(new THREE.Vector3()) };
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (found) return;
    if ((o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

function repeatMaps(mat: THREE.MeshStandardMaterial, rx: number, ry: number) {
  for (const map of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap, mat.metalnessMap]) {
    if (!map) continue;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(rx, ry);
    map.needsUpdate = true;
  }
}

function hexRgb(hex: number) {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

function rewriteMap(tex: THREE.Texture | null, paint: (d: Uint8ClampedArray, w: number, h: number) => void) {
  const img = tex?.image as CanvasImageSource & { width?: number; height?: number };
  if (!tex || !img || !img.width || !img.height) return tex;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return tex;
  ctx.drawImage(img, 0, 0);
  const pix = ctx.getImageData(0, 0, canvas.width, canvas.height);
  paint(pix.data, canvas.width, canvas.height);
  ctx.putImageData(pix, 0, 0);
  const next = new THREE.CanvasTexture(canvas);
  next.colorSpace = THREE.SRGBColorSpace;
  next.wrapS = THREE.RepeatWrapping;
  next.wrapT = THREE.RepeatWrapping;
  next.needsUpdate = true;
  return next;
}

function cloneMap(tex: THREE.Texture | null) {
  if (!tex) return null;
  const next = tex.clone();
  next.needsUpdate = true;
  return next;
}

function tintFloorKeepGrout(tex: THREE.Texture | null, hex: number) {
  const tile = hexRgb(hex);
  const grout = {
    r: Math.round(tile.r * 0.58),
    g: Math.round(tile.g * 0.58),
    b: Math.round(tile.b * 0.58),
  };
  return rewriteMap(tex, (d) => {
    let minL = 255;
    let maxL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const luma = d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
      if (luma < minL) minL = luma;
      if (luma > maxL) maxL = luma;
    }
    const range = Math.max(12, maxL - minL);
    for (let i = 0; i < d.length; i += 4) {
      const luma = d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
      const t = Math.pow((luma - minL) / range, 0.75);
      d[i] = grout.r + (tile.r - grout.r) * t;
      d[i + 1] = grout.g + (tile.g - grout.g) * t;
      d[i + 2] = grout.b + (tile.b - grout.b) * t;
    }
  });
}

function darkenCeilingLinesOnly(tex: THREE.Texture | null, lineHex: number) {
  const line = hexRgb(lineHex);
  return rewriteMap(tex, (d, w, h) => {
    const lumaAt = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return 255;
      const i = (y * w + x) * 4;
      return d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
    };
    let sum = 0;
    const n = w * h;
    for (let i = 0; i < d.length; i += 4) sum += d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
    const avg = sum / n;
    const speckleCut = avg - 48;
    const bandCut = avg - 7;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const L = lumaAt(x, y);
        if (L < speckleCut) continue;
        if (L >= bandCut) continue;
        const hLine = lumaAt(x - 3, y) < bandCut && lumaAt(x + 3, y) < bandCut && lumaAt(x - 3, y) > speckleCut && lumaAt(x + 3, y) > speckleCut;
        const vLine = lumaAt(x, y - 3) < bandCut && lumaAt(x, y + 3) < bandCut && lumaAt(x, y - 3) > speckleCut && lumaAt(x, y + 3) > speckleCut;
        if (!hLine && !vLine) continue;
        const i = (y * w + x) * 4;
        d[i] = line.r;
        d[i + 1] = line.g;
        d[i + 2] = line.b;
      }
    }
  });
}

function liftCeilingMap(tex: THREE.Texture | null) {
  return rewriteMap(tex, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, d[i]! * 1.18 + 16);
      d[i + 1] = Math.min(255, d[i + 1]! * 1.18 + 16);
      d[i + 2] = Math.min(255, d[i + 2]! * 1.18 + 16);
    }
  });
}

function addNewFloor(scene: THREE.Scene, src: THREE.Object3D) {
  const { innerW, spanZ, midZ } = playSpan();
  const srcMesh = firstMesh(src);
  const mat = ((srcMesh?.material as THREE.MeshStandardMaterial) ?? new THREE.MeshStandardMaterial()).clone();
  mat.color.setHex(0xffffff);
  mat.emissive.setHex(0x000000);
  mat.aoMap = null;
  mat.lightMap = null;
  mat.metalness = 0;
  mat.map = tintFloorKeepGrout(mat.map, ROOM.floor);
  mat.normalMap = cloneMap(mat.normalMap);
  if (mat.normalMap) mat.normalScale.set(1.35, 1.35);
  mat.roughnessMap = cloneMap(mat.roughnessMap);
  mat.roughness = 0.86;
  const tile = 2.35;
  repeatMaps(mat, innerW / tile, spanZ / tile);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerW, spanZ), mat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.002, midZ);
  floor.receiveShadow = false;
  floor.castShadow = false;
  scene.add(floor);
}

function liftAircon(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = src.map((m) => {
      const std = (m as THREE.MeshStandardMaterial).clone();
      std.color.setRGB(1.55, 1.58, 1.62);
      return std;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
  });
}

function markStatic(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.geometry.computeBoundingSphere();
  });
}

function addNewCeiling(host: THREE.Object3D, src: THREE.Object3D) {
  const { w, spanZ, midZ } = playSpan();
  const lidW = w - 0.24;
  const lidD = spanZ - 0.08;
  const { wrap: proto, size } = wrapCentered(src);
  const yScale = 0.08 / Math.max(size.y, 0.001);
  const xzScale = Math.min(lidW / size.x, lidD / size.z) * 0.58;
  proto.scale.set(xzScale, yScale, xzScale);
  proto.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = srcMats.map((m) => {
      const std = (m as THREE.MeshStandardMaterial).clone();
      std.color.setHex(0xffffff);
      std.emissive.setHex(0x000000);
      std.aoMap = null;
      std.lightMap = null;
    std.metalness = 0;
      std.side = THREE.DoubleSide;
      std.map = liftCeilingMap(darkenCeilingLinesOnly(std.map, ROOM.ceilingLine));
      std.normalMap = cloneMap(std.normalMap);
      if (std.normalMap) std.normalScale.set(0.35, 0.35);
      std.roughness = 0.88;
      return std;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
  const tileW = size.x * xzScale;
  const tileD = size.z * xzScale;
  const cols = Math.max(1, Math.ceil(lidW / tileW - 1e-6));
  const rows = Math.max(1, Math.ceil(lidD / tileD - 1e-6));
  const originX = -((cols - 1) * tileW) / 2;
  const originZ = midZ - ((rows - 1) * tileD) / 2;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = col === 0 && row === 0 ? proto : proto.clone(true);
      if (tile !== proto) copyMeshMaterials(proto, tile);
      tile.position.set(originX + col * tileW, 3.91, originZ + row * tileD);
      host.add(tile);
    }
  }
}

const LAMP_XS = [-4.21, -1.12, 1.98];
const LAMP_ZS = [-11.7, -7.06, -2.42];
const CEILING_Y = 3.91;
const LIGHT_POKE = 0.022;
const LIGHT_XZ = 0.42;

function copyMeshMaterials(from: THREE.Object3D, to: THREE.Object3D) {
  const mats: THREE.Material[] = [];
  from.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mats.push(mesh.material as THREE.Material);
  });
  let i = 0;
  to.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mats[i++];
    if (mat) mesh.material = mat;
  });
}

function addCeilingWash(scene: THREE.Scene, fpWalls: THREE.Group, fixture?: THREE.Object3D) {
  const color = 0xfff1dc;
  const lit = new THREE.MeshBasicMaterial({ color: 0xfff8f0, toneMapped: false });
  const frame = new THREE.MeshStandardMaterial({
    color: 0x6a6762,
    metalness: 0.35,
    roughness: 0.5,
  });
  for (const x of LAMP_XS) {
    for (const z of LAMP_ZS) {
      if (z > CLASSROOM.cutZ - 0.4) continue;
      const lamp = new THREE.PointLight(color, 8, 8.5, 1.8);
      lamp.position.set(x, CEILING_Y - 0.12, z);
      lamp.castShadow = false;
      scene.add(lamp);
      if (!fixture) continue;
      const { wrap, size } = wrapCentered(fixture);
      wrap.rotation.x = Math.PI;
      wrap.rotation.y = Math.PI / 2;
      wrap.scale.set(LIGHT_XZ, LIGHT_POKE / Math.max(size.y, 0.001), LIGHT_XZ);
      wrap.position.set(x, CEILING_Y, z);
      wrap.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const name = ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material)?.name ?? "";
        if (/metal/i.test(name)) {
          mesh.visible = false;
          return;
        }
        mesh.material = /outer/i.test(name) ? frame : lit;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
      fpWalls.add(wrap);
    }
  }
}

export function buildClassroom(scene: THREE.Scene): {
  colliders: AABB[];
  seats: Seat[];
  fpWalls: THREE.Group;
  isoWalls: THREE.Group;
} {
  const colliders: AABB[] = [];
  const seats = classroomSeats();
  const fpWalls = new THREE.Group();
  fpWalls.visible = false;
  scene.add(fpWalls);
  const isoWalls = new THREE.Group();
  scene.add(isoWalls);
  addHollowWalls(colliders);
  addRoomWalls(scene, fpWalls);

  if (kit) {
    const room = kit.classroom.clone(true);
    fitClassroom(room);
    scene.add(room);
    room.updateMatrixWorld(true);

    const fpMeshes: THREE.Mesh[] = [];
    room.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (isReplacedSurface(mesh)) {
        mesh.visible = false;
        return;
      }
      prepRoomMesh(mesh);
      paintRoomSurfaces(mesh);
      if (mesh.name.endsWith("_1") || isGlbWall(mesh)) {
        mesh.visible = false;
        return;
      }
      clipMeshMaxZ(mesh, CLASSROOM.cutZ);
      if (!mesh.visible) return;
      if (mesh.name === "Material3_16") {
        mesh.visible = false;
        return;
      }
      const { box, size } = meshBounds(mesh);
      if (isCeilingDetail(box, size)) fpMeshes.push(mesh);
    });
    for (const mesh of fpMeshes) fpWalls.attach(mesh);
    addNewFloor(scene, kit.floor);
    addNewCeiling(fpWalls, kit.ceiling);

    const chairPoses: { x: number; z: number }[] = [];
    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) chairPoses.push(deskCell(col, row));
    }
    for (let i = 0; i < BACK_CHAIRS.count; i++) chairPoses.push(backChairCell(i));
    placeInstancedChairs(scene, kit.nuChair, chairPoses, DESK_GRID.rotY, { height: 1.24 }, colliders);
    addFrontFurniture(scene, kit, colliders);
    addLeftWallFurniture(scene, kit, colliders);
  } else {
    fallbackRoom(scene, fpWalls);
    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const { x, z } = deskCell(col, row);
        colliders.push({ minX: x - 0.39, maxX: x + 0.39, minZ: z - 0.37, maxZ: z + 0.37 });
      }
    }
    for (let i = 0; i < BACK_CHAIRS.count; i++) {
      const { x, z } = backChairCell(i);
      colliders.push({ minX: x - 0.39, maxX: x + 0.39, minZ: z - 0.37, maxZ: z + 0.37 });
    }
  }

  scene.add(new THREE.HemisphereLight(0xf3e7dc, 0xb49e90, 1.02));
  scene.add(new THREE.AmbientLight(0xece3d8, 0.28));
  const sun = new THREE.DirectionalLight(0xf2e2d4, 0.32);
  sun.position.set(4, 18, -6);
  sun.castShadow = false;
  scene.add(sun);
  addCeilingWash(scene, fpWalls, kit?.ceilingLight);
  markStatic(scene);

  return { colliders, seats, fpWalls, isoWalls };
}

function hitsBox(px: number, pz: number, boxes: AABB[], radius = PLAYER_RADIUS) {
  return boxes.some(
    (b) =>
      px + radius > b.minX &&
      px - radius < b.maxX &&
      pz + radius > b.minZ &&
      pz - radius < b.maxZ,
  );
}

function blocked(
  px: number,
  pz: number,
  boxes: AABB[],
  others: { x: number; z: number }[],
  radius = PLAYER_RADIUS,
) {
  if (hitsBox(px, pz, boxes, radius)) return true;
  return others.some((o) => Math.hypot(px - o.x, pz - o.z) < radius * 2);
}

export function resolveMove(
  x: number,
  z: number,
  dx: number,
  dz: number,
  boxes: AABB[],
  others: { x: number; z: number }[] = [],
) {
  let nx = x + dx;
  let nz = z + dz;
  const c = clampClassroom(nx, nz);
  nx = c.x;
  nz = c.z;
  if (hitsBox(nx, z, boxes)) nx = x;
  if (hitsBox(nx, nz, boxes)) nz = z;
  const sep = resolvePlayerMove(x, z, nx, nz, others);
  if (hitsBox(sep.x, sep.z, boxes)) return { x: nx, z: nz };
  return sep;
}

/** Step behind the chair (opposite facing), then try a ring, skipping colliders and other players. */
export function findClearStand(
  x: number,
  z: number,
  rotY: number,
  boxes: AABB[],
  others: { x: number; z: number }[],
) {
  const backX = -Math.sin(rotY);
  const backZ = -Math.cos(rotY);
  const rightX = Math.cos(rotY);
  const rightZ = -Math.sin(rotY);
  const spots: [number, number][] = [];
  for (const dist of [0.95, 1.2, 1.5, 1.85]) {
    spots.push([x + backX * dist, z + backZ * dist]);
    spots.push([x + backX * dist + rightX * 0.75, z + backZ * dist + rightZ * 0.75]);
    spots.push([x + backX * dist - rightX * 0.75, z + backZ * dist - rightZ * 0.75]);
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    spots.push([x + Math.cos(a) * 1.35, z + Math.sin(a) * 1.35]);
  }
  for (const [px, pz] of spots) {
    const c = clampClassroom(px, pz);
    if (!blocked(c.x, c.z, boxes, others)) return c;
  }
  return clampClassroom(x + backX * 1.6, z + backZ * 1.6);
}
