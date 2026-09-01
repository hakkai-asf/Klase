import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CLASSROOM, DESK_GRID, PLAYER_RADIUS, classroomSeats, clampClassroom, type Seat } from "@klase/shared";

export type { Seat };
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

const classroomUrl = new URL("../../../assets/classroom/classroom.glb", import.meta.url).href;
const schoolDeskUrl = new URL("../../../assets/furnitures/school-desk.glb", import.meta.url).href;

const CEILING_CAP_Y = 3.5;
const WALL_BAND = 0.5;
const INTERIOR_FURNITURE_Y = 1.2;

const HIDE_MESH = new Set([
  "Material2_1",
  "Material2_2",
  "Material2_3",
  "Material2_4",
  "Material2_17",
  "Material2_18",
  "Material3",
  "Material3_1",
  "Material3_3",
  "Material3_4",
  "Material3_5",
  "Material3_6",
  "Material3_9",
  "Material3_11",
  "Material3_12",
  "Material3_13",
  "Material3_14",
  "Material3_15",
]);

type Kit = {
  classroom: THREE.Object3D;
  schoolDesk: THREE.Object3D;
};

let kit: Kit | null = null;

export async function preloadClassroom() {
  if (kit) return;
  const gltf = new GLTFLoader();
  const [room, school] = await Promise.all([gltf.loadAsync(classroomUrl), gltf.loadAsync(schoolDeskUrl)]);
  kit = { classroom: room.scene, schoolDesk: school.scene };
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

function isGlass(mesh: THREE.Mesh) {
  return /Translucent_Glass|Material3_10/i.test(matName(mesh)) || mesh.name === "Material2";
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

function styleGlass(mesh: THREE.Mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const std = mat as THREE.MeshStandardMaterial;
    std.color.set(0x6a7680);
    std.transparent = true;
    std.opacity = 0.3;
    std.depthWrite = false;
    std.roughness = 0.18;
    std.metalness = 0.08;
    std.side = THREE.FrontSide;
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

function stripInteriorFurniture(mesh: THREE.Mesh) {
  const hx = CLASSROOM.width / 2 - WALL_BAND;
  const hz = CLASSROOM.depth / 2 - WALL_BAND;
  filterTriangles(mesh, (a, b, c) => {
    const cx = (a.x + b.x + c.x) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    const maxY = Math.max(a.y, b.y, c.y);
    const nearWall = Math.abs(cx) > hx || Math.abs(cz) > hz;
    return nearWall || maxY >= INTERIOR_FURNITURE_Y;
  });
}

function stripCeilingCap(mesh: THREE.Mesh) {
  filterTriangles(mesh, (a, b, c) => (a.y + b.y + c.y) / 3 <= CEILING_CAP_Y);
}

function addPlainFloor(scene: THREE.Scene) {
  const { width: w, depth: d } = CLASSROOM;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({
      color: 0xd8d4cc,
      roughness: 0.92,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.002;
  scene.add(floor);
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
  const { width: w, depth: d, wallThickness: t } = CLASSROOM;
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: -d / 2, maxZ: -d / 2 + t });
  colliders.push({ minX: -w / 2, maxX: -w / 2 + t, minZ: -d / 2, maxZ: d / 2 });
  colliders.push({ minX: w / 2 - t, maxX: w / 2, minZ: -d / 2, maxZ: d / 2 });
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: d / 2 - t, maxZ: d / 2 });
}

function fallbackRoom(scene: THREE.Scene, colliders: AABB[], fpWalls: THREE.Group) {
  const { width: w, depth: d, wallHeight: h, wallThickness: t } = CLASSROOM;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0xb08968, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf8f4ec, roughness: 0.88 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), wallMat);
  back.position.set(0, h / 2, -d / 2 + t / 2);
  scene.add(back);
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, h, d), wallMat);
  left.position.set(-w / 2 + t / 2, h / 2, 0);
  scene.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(t, h, d), wallMat);
  right.position.set(w / 2 - t / 2, h / 2, 0);
  fpWalls.add(right);
  const front = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), wallMat);
  front.position.set(0, h / 2, d / 2 - t / 2);
  fpWalls.add(front);
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(w, t, d), wallMat);
  ceiling.position.set(0, h, 0);
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
  const next = src.map((mat) => {
    const std = (mat as THREE.MeshStandardMaterial).clone();
    std.side = THREE.DoubleSide;
    return std;
  });
  mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
}

export function buildClassroom(scene: THREE.Scene): { colliders: AABB[]; seats: Seat[]; fpWalls: THREE.Group } {
  const colliders: AABB[] = [];
  const seats = classroomSeats();
  const fpWalls = new THREE.Group();
  fpWalls.visible = false;
  scene.add(fpWalls);
  addHollowWalls(colliders);

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
      if (HIDE_MESH.has(mesh.name)) {
        mesh.visible = false;
        return;
      }
      if (isGlass(mesh)) {
        styleGlass(mesh);
        return;
      }
      const { box, size } = meshBounds(mesh);
      if (isCeilingDetail(box, size)) {
        if (isCeilingGrid(mesh, box, size)) pullCeilingGridForward(mesh);
        fpMeshes.push(mesh);
        return;
      }
      if (mesh.name === "Material3_2") {
        stripInteriorFurniture(mesh);
        return;
      }
      if (mesh.name === "Material2_7") {
        stripCeilingCap(mesh);
        fpMeshes.push(mesh);
      }
    });
    for (const mesh of fpMeshes) fpWalls.attach(mesh);
    addPlainFloor(scene);

    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        const desk = place(scene, kit.schoolDesk, x, z, DESK_GRID.rotY, { height: 1.15, depth: 1.55 });
        const box = aabbOf(desk);
        const midZ = (box.minZ + box.maxZ) / 2;
        colliders.push({ ...box, minZ: midZ - 0.08 });
      }
    }
  } else {
    fallbackRoom(scene, colliders, fpWalls);
    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        colliders.push({ minX: x - 0.85, maxX: x + 0.85, minZ: z - 0.5, maxZ: z + 0.5 });
      }
    }
  }

  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8a909c, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e4, 1.12);
  sun.position.set(10, 16, 10);
  sun.castShadow = false;
  scene.add(sun);

  return { colliders, seats, fpWalls };
}

function blocked(
  px: number,
  pz: number,
  boxes: AABB[],
  others: { x: number; z: number }[],
  radius = PLAYER_RADIUS,
) {
  if (
    boxes.some(
      (b) =>
        px + radius > b.minX &&
        px - radius < b.maxX &&
        pz + radius > b.minZ &&
        pz - radius < b.maxZ,
    )
  )
    return true;
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
  if (blocked(nx, z, boxes, others)) nx = x;
  if (blocked(nx, nz, boxes, others)) nz = z;
  return { x: nx, z: nz };
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
