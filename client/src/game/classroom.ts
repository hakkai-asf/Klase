import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CLASSROOM, DESK_GRID, PLAYER_RADIUS, classroomSeats, clampClassroom, resolvePlayerMove, type Seat } from "@klase/shared";

export type { Seat };
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

const classroomUrl = new URL("../../../assets/classroom/cleaned-classroom.glb", import.meta.url).href;
const nuChairUrl = new URL("../../../assets/furnitures/nu-chair.glb", import.meta.url).href;

const CEILING_CAP_Y = 3.5;

const ROOM = {
  wall: 0xe3e0db,
  door: 0xcebd9f,
  ceiling: 0xbfbec3,
  grid: 0x9e9e9e,
  floor: 0xb9b0a4,
  board: 0xb0c4c3,
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
};

let kit: Kit | null = null;

export async function preloadClassroom() {
  if (kit) return;
  const gltf = new GLTFLoader();
  const [room, chair] = await Promise.all([gltf.loadAsync(classroomUrl), gltf.loadAsync(nuChairUrl)]);
  kit = { classroom: room.scene, nuChair: chair.scene };
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

function isCeilingGrid(mesh: THREE.Mesh, box: THREE.Box3, size: THREE.Vector3) {
  if (!isCeilingDetail(box, size) || size.y > 0.02) return false;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const std = mat as THREE.MeshStandardMaterial;
  const hex = std?.color?.getHex() ?? 0;
  return /Color_008|Material2_9/i.test(matName(mesh)) || hex < 0x808080;
}

function isDoorGlass(mesh: THREE.Mesh) {
  return mesh.name === "Material2" || /Translucent_Glass_Gray_1|Material3_10/i.test(matName(mesh));
}

function isWindowWall(mesh: THREE.Mesh) {
  return mesh.name === "Material2_6" || /Translucent_Glass_Gray_2/i.test(matName(mesh));
}

function pullCeilingGridForward(mesh: THREE.Mesh) {
  mesh.position.y -= 0.018;
  mesh.renderOrder = 20;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const std = mat as THREE.MeshStandardMaterial;
    std.depthWrite = true;
    std.polygonOffset = true;
    std.polygonOffsetFactor = -2;
    std.polygonOffsetUnits = -2;
  }
}

function pullBoardForward(mesh: THREE.Mesh) {
  mesh.position.z += 0.03;
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

function rebuildKept(mesh: THREE.Mesh, src: THREE.BufferGeometry, keepTri: boolean[], keepN: number) {
  if (keepN === 0) {
    mesh.visible = false;
    return;
  }
  const next = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const attr = src.getAttribute(name);
    if (!attr) continue;
    const itemSize = attr.itemSize;
    const arr = new Float32Array(keepN * 3 * itemSize);
    let w = 0;
    for (let t = 0; t < keepTri.length; t++) {
      if (!keepTri[t]) continue;
      for (let k = 0; k < 3; k++) {
        const srcI = (t * 3 + k) * itemSize;
        for (let c = 0; c < itemSize; c++) arr[w++] = attr.array[srcI + c]!;
      }
    }
    next.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  next.computeVertexNormals();
  mesh.geometry = next;
}

function filterTriangles(mesh: THREE.Mesh, keepFn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => boolean) {
  mesh.updateMatrixWorld(true);
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const pos = src.getAttribute("position");
  if (!pos) return;
  const triCount = Math.floor(pos.count / 3);
  const keepTri = new Array<boolean>(triCount);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let keepN = 0;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    const keep = keepFn(a, b, c);
    keepTri[t] = keep;
    if (keep) keepN++;
  }
  if (keepN === triCount) return;
  rebuildKept(mesh, src, keepTri, keepN);
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

function stripShellCaps(mesh: THREE.Mesh) {
  filterTriangles(mesh, (a, b, c) => {
    const maxY = Math.max(a.y, b.y, c.y);
    const avgY = (a.y + b.y + c.y) / 3;
    return avgY <= CEILING_CAP_Y && maxY >= 0.08;
  });
}

function prepareProp(
  src: THREE.Object3D,
  opts: { height?: number; width?: number; depth?: number } = {},
) {
  const root = new THREE.Group();
  const model = src.clone(true);
  root.add(model);
  root.updateMatrixWorld(true);
  const size0 = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  let s = 1;
  if (opts.height) s = opts.height / Math.max(size0.y, 0.001);
  if (opts.width) s = Math.min(s, opts.width / Math.max(size0.x, 0.001));
  if (opts.depth) s = Math.min(s, opts.depth / Math.max(size0.z, 0.001));
  if (Number.isFinite(s) && Math.abs(s - 1) > 0.001) model.scale.multiplyScalar(s);
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

function addHollowWalls(colliders: AABB[]) {
  const { width: w, depth: d, wallThickness: t, cutZ } = CLASSROOM;
  const minZ = -d / 2;
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ, maxZ: minZ + t });
  colliders.push({ minX: -w / 2, maxX: -w / 2 + t, minZ, maxZ: cutZ });
  colliders.push({ minX: w / 2 - t, maxX: w / 2, minZ, maxZ: cutZ });
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: cutZ - t, maxZ: cutZ });
}

function stripLeftClerestory(mesh: THREE.Mesh) {
  filterTriangles(mesh, (a, b, c) => {
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    return !(cx < -5.5 && cy > 2.9);
  });
}

function addLeftClerestoryPatch(scene: THREE.Scene) {
  const { depth: d, cutZ } = CLASSROOM;
  const minZ = -d / 2;
  const y0 = 2.7;
  const y1 = 3.87;
  const mat = new THREE.MeshStandardMaterial({
    color: ROOM.wall,
    roughness: 0.6,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(cutZ - minZ, y1 - y0), mat);
  patch.rotation.y = Math.PI / 2;
  patch.position.set(-6.95, (y0 + y1) / 2, (minZ + cutZ) / 2);
  patch.castShadow = false;
  patch.receiveShadow = false;
  scene.add(patch);
}

function addCutWall(fpWalls: THREE.Group) {
  const { width: w, wallHeight: h, wallThickness: t, cutZ } = CLASSROOM;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, t),
    new THREE.MeshStandardMaterial({ color: ROOM.wall, roughness: 0.6, metalness: 0 }),
  );
  wall.position.set(0, h / 2, cutZ - t / 2);
  wall.castShadow = false;
  wall.receiveShadow = false;
  fpWalls.add(wall);
}

function addPillarColliders(colliders: AABB[]) {
  const hx = CLASSROOM.width / 2;
  const hz = CLASSROOM.depth / 2;
  const colW = 0.95;
  const colAlong = 1.35;
  for (const z of [-5.05]) {
    colliders.push({ minX: -hx, maxX: -hx + colW, minZ: z - colAlong / 2, maxZ: z + colAlong / 2 });
    colliders.push({ minX: hx - colW, maxX: hx, minZ: z - colAlong / 2, maxZ: z + colAlong / 2 });
  }
  const endAlong = 1.2;
  colliders.push({ minX: hx - colW, maxX: hx, minZ: -hz, maxZ: -hz + endAlong });
  colliders.push({ minX: -hx, maxX: -4.2, minZ: -hz, maxZ: -13.05 });
}

function keepFarL(mesh: THREE.Mesh) {
  filterTriangles(mesh, (a, b, c) => {
    const maxX = Math.max(a.x, b.x, c.x);
    const maxZ = Math.max(a.z, b.z, c.z);
    const onLeft = maxX < -4.15;
    const onBoard = maxZ < -12.95;
    return (onLeft || onBoard) && Math.max(a.y, b.y, c.y) >= 0.12;
  });
}

function cloneFarL(mesh: THREE.Mesh, isoWalls: THREE.Group) {
  const iso = mesh.clone();
  iso.geometry = mesh.geometry.clone();
  const mat = mesh.material;
  iso.material = Array.isArray(mat) ? mat.map((m) => m.clone()) : mat.clone();
  mesh.updateMatrixWorld(true);
  iso.matrix.copy(mesh.matrixWorld);
  iso.matrix.decompose(iso.position, iso.quaternion, iso.scale);
  isoWalls.add(iso);
  iso.updateMatrixWorld(true);
  keepFarL(iso);
}

function fallbackRoom(scene: THREE.Scene, colliders: AABB[], fpWalls: THREE.Group) {
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
  const wallMat = new THREE.MeshStandardMaterial({ color: ROOM.wall, roughness: 0.6 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), wallMat);
  back.position.set(0, h / 2, -d / 2 + t / 2);
  scene.add(back);
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, h, playD), wallMat);
  left.position.set(-w / 2 + t / 2, h / 2, midZ);
  scene.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(t, h, playD), wallMat);
  right.position.set(w / 2 - t / 2, h / 2, midZ);
  fpWalls.add(right);
  addCutWall(fpWalls);
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
    else if (mesh.name === "Material2_10" || /0009_Linen/i.test(name)) {
      flattenPaint(std, ROOM.ceiling);
      std.emissive.setHex(ROOM.ceiling);
      std.emissiveIntensity = 0.06;
      std.side = THREE.BackSide;
    } else if (mesh.name === "Material2_9" || /Color_008/i.test(name)) flattenPaint(std, ROOM.grid);
    else if (mesh.name === "Material3_6" || /Wood_Square_Tile/i.test(name)) flattenPaint(std, ROOM.floor);
    else if (mesh.name === "Material3_16" || /whiteboard/i.test(name)) flattenPaint(std, ROOM.board);
  }
}

function addCeilingWash(scene: THREE.Scene) {
  const color = 0xf6ddc8;
  const xs = [-4.21, -1.12, 1.98];
  const zs = [-11.7, -7.06, -2.42];
  for (const x of xs) {
    for (const z of zs) {
      if (z > CLASSROOM.cutZ - 0.4) continue;
      const lamp = new THREE.PointLight(color, 12, 8.5, 2);
      lamp.position.set(x, 3.55, z);
      lamp.castShadow = false;
      scene.add(lamp);
    }
  }
}

function lightCeilingFixtures(mesh: THREE.Mesh) {
  const name = matName(mesh);
  const isIlu = mesh.name === "Material2_14" || /white_ilu/i.test(name);
  const isLouver = mesh.name === "Material3_7" || /0131_Silver/i.test(name);
  const isHousing = mesh.name === "Material2_13" || /0133_Gray/i.test(name);
  if (!isIlu && !isLouver && !isHousing) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const std = mat as THREE.MeshStandardMaterial;
    std.map = null;
    std.emissiveMap = null;
    std.color.set(0xffffff);
    std.emissive.set(0xffeedd);
    std.emissiveIntensity = isHousing ? 0.18 : 0.42;
    std.side = THREE.FrontSide;
    std.metalness = 0;
    std.roughness = 0.35;
  }
}

function stripEdgeFixtures(mesh: THREE.Mesh) {
  if (mesh.name === "Material2_11" || mesh.name === "Material2_12") {
    mesh.visible = false;
    return;
  }
  if (mesh.name !== "Material2_14" && mesh.name !== "Material3_7" && mesh.name !== "Material2_13") return;
  filterTriangles(mesh, (a, b, c) => {
    const cx = (a.x + b.x + c.x) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    return cx < 4.4 && cz < -0.5;
  });
}

/** Solid lid above the fixtures. Only parented to fpWalls so aerial stays open. */
function addCeilingBacking(host: THREE.Object3D) {
  const { width: w, depth: d, cutZ } = CLASSROOM;
  const minZ = -d / 2;
  const spanZ = cutZ - minZ;
  const mat = new THREE.MeshStandardMaterial({
    color: ROOM.ceiling,
    roughness: 0.85,
    metalness: 0,
    emissive: ROOM.ceiling,
    emissiveIntensity: 0.06,
    side: THREE.BackSide,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.24, spanZ - 0.08), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(0, 3.99, minZ + spanZ / 2);
  plane.castShadow = false;
  plane.receiveShadow = false;
  host.add(plane);
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
  addPillarColliders(colliders);

  if (kit) {
    const room = kit.classroom.clone(true);
    fitClassroom(room);
    scene.add(room);
    room.updateMatrixWorld(true);

    const fpMeshes: THREE.Mesh[] = [];
    room.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      prepRoomMesh(mesh);
      paintRoomSurfaces(mesh);
      lightCeilingFixtures(mesh);
      if (mesh.name.endsWith("_1")) {
        mesh.visible = false;
        return;
      }
      clipMeshMaxZ(mesh, CLASSROOM.cutZ);
      stripEdgeFixtures(mesh);
      if (!mesh.visible) return;
      if (mesh.name === "Material2" || mesh.name === "Material2_6") stripLeftClerestory(mesh);
      if (!mesh.visible) return;
      if (isDoorGlass(mesh)) {
        cloneFarL(mesh, isoWalls);
        fpMeshes.push(mesh);
        return;
      }
      if (mesh.name === "Material3_8") {
        cloneFarL(mesh, isoWalls);
        fpMeshes.push(mesh);
        return;
      }
      if (isWindowWall(mesh)) {
        fpMeshes.push(mesh);
        return;
      }
      if (mesh.name === "Material3_16") {
        pullBoardForward(mesh);
        return;
      }
      const { box, size } = meshBounds(mesh);
      if (isCeilingDetail(box, size)) {
        if (isCeilingGrid(mesh, box, size)) pullCeilingGridForward(mesh);
        fpMeshes.push(mesh);
        return;
      }
      if (mesh.name === "Material2_7") {
        stripShellCaps(mesh);
        cloneFarL(mesh, isoWalls);
        fpMeshes.push(mesh);
      }
    });
    for (const mesh of fpMeshes) fpWalls.attach(mesh);
    addCeilingBacking(fpWalls);
    addCutWall(fpWalls);
    addLeftClerestoryPatch(scene);

    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        const chair = place(scene, kit.nuChair, x, z, DESK_GRID.rotY, { height: 1.24 });
        colliders.push(aabbOf(chair, 0.04));
      }
    }
  } else {
    fallbackRoom(scene, colliders, fpWalls);
    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        colliders.push({ minX: x - 0.39, maxX: x + 0.39, minZ: z - 0.37, maxZ: z + 0.37 });
      }
    }
  }

  scene.add(new THREE.HemisphereLight(0xf5e8dc, 0xb8a090, 1.02));
  scene.add(new THREE.AmbientLight(0xeee4d8, 0.28));
  const sun = new THREE.DirectionalLight(0xf5e4d4, 0.32);
  sun.position.set(4, 18, -6);
  sun.castShadow = false;
  scene.add(sun);
  addCeilingWash(scene);

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
