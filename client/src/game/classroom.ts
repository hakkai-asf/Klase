import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CLASSROOM, DESK_GRID, PLAYER_RADIUS, classroomSeats, clampClassroom, type Seat } from "@klase/shared";

export type { Seat };
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

const classroomUrl = new URL("../../../assets/classroom/cleaned-classroom.glb", import.meta.url).href;
const nuChairUrl = new URL("../../../assets/furnitures/nu-chair.glb", import.meta.url).href;

const CEILING_CAP_Y = 3.5;

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
  const { width: w, depth: d, wallThickness: t } = CLASSROOM;
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: -d / 2, maxZ: -d / 2 + t });
  colliders.push({ minX: -w / 2, maxX: -w / 2 + t, minZ: -d / 2, maxZ: d / 2 });
  colliders.push({ minX: w / 2 - t, maxX: w / 2, minZ: -d / 2, maxZ: d / 2 });
  colliders.push({ minX: -w / 2, maxX: w / 2, minZ: d / 2 - t, maxZ: d / 2 });
}

function addPillarColliders(colliders: AABB[]) {
  const hx = CLASSROOM.width / 2;
  const hz = CLASSROOM.depth / 2;
  const colW = 0.95;
  const colAlong = 1.35;
  for (const z of [-5.05, 5.15]) {
    colliders.push({ minX: -hx, maxX: -hx + colW, minZ: z - colAlong / 2, maxZ: z + colAlong / 2 });
    colliders.push({ minX: hx - colW, maxX: hx, minZ: z - colAlong / 2, maxZ: z + colAlong / 2 });
  }
  const endAlong = 1.2;
  colliders.push({ minX: hx - colW, maxX: hx, minZ: -hz, maxZ: -hz + endAlong });
  colliders.push({ minX: hx - colW, maxX: hx, minZ: hz - endAlong, maxZ: hz });
  colliders.push({ minX: -hx, maxX: -4.2, minZ: -hz, maxZ: -13.05 });
  colliders.push({ minX: -hx, maxX: -4.2, minZ: 13.45, maxZ: hz });
}

function keepFarL(mesh: THREE.Mesh) {
  filterTriangles(mesh, (a, b, c) => {
    const minX = Math.min(a.x, b.x, c.x);
    const minZ = Math.min(a.z, b.z, c.z);
    const maxX = Math.max(a.x, b.x, c.x);
    const maxZ = Math.max(a.z, b.z, c.z);
    const cx = (a.x + b.x + c.x) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    const onLeft = maxX < -4.15;
    const onBoard = maxZ < -12.95;
    const onFront = minZ > 14.0 && minX > 3.2;
    const leftFrontDoor = cx < -5.5 && cz > 10.5 && cz < 13.5;
    return (onLeft || onBoard || onFront || leftFrontDoor) && Math.max(a.y, b.y, c.y) >= 0.12;
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
      if (mesh.name.endsWith("_1")) {
        mesh.visible = false;
        return;
      }
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

    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        const chair = place(scene, kit.nuChair, x, z, DESK_GRID.rotY, { height: 0.95 });
        colliders.push(aabbOf(chair, 0.04));
      }
    }
  } else {
    fallbackRoom(scene, colliders, fpWalls);
    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        colliders.push({ minX: x - 0.34, maxX: x + 0.34, minZ: z - 0.32, maxZ: z + 0.32 });
      }
    }
  }

  scene.add(new THREE.HemisphereLight(0xfff6ea, 0xfff6ea, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e4, 1.12);
  sun.position.set(10, 16, 10);
  sun.castShadow = false;
  scene.add(sun);

  return { colliders, seats, fpWalls, isoWalls };
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
