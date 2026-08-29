import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CLASSROOM, DESK_GRID, classroomSeats, type Seat } from "@klase/shared";

export type { Seat };
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

const schoolDeskUrl = new URL("../../../assets/furnitures/school-desk.glb", import.meta.url).href;
const teacherDeskUrl = new URL("../../../assets/furnitures/desk.glb", import.meta.url).href;
const whiteboardUrl = new URL("../../../assets/furnitures/whiteboard.glb", import.meta.url).href;
const windowsUrl = new URL("../../../assets/furnitures/windows.glb", import.meta.url).href;
const bookshelfUrl = new URL("../../../assets/furnitures/bookshelf.glb", import.meta.url).href;
const shelf2Url = new URL("../../../assets/furnitures/shelf2.glb", import.meta.url).href;
const floorUrl = new URL("../../../assets/textures/floor-texture.jpg", import.meta.url).href;

type Kit = {
  schoolDesk: THREE.Object3D;
  teacherDesk: THREE.Object3D;
  whiteboard: THREE.Object3D;
  windows: THREE.Object3D;
  bookshelf: THREE.Object3D;
  shelf2: THREE.Object3D;
  floorTex: THREE.Texture;
};

let kit: Kit | null = null;

export async function preloadClassroom() {
  if (kit) return;
  const gltf = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const [school, teacher, board, win, shelf, shelf2, floorTex] = await Promise.all([
    gltf.loadAsync(schoolDeskUrl),
    gltf.loadAsync(teacherDeskUrl),
    gltf.loadAsync(whiteboardUrl),
    gltf.loadAsync(windowsUrl),
    gltf.loadAsync(bookshelfUrl),
    gltf.loadAsync(shelf2Url),
    tex.loadAsync(floorUrl),
  ]);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.wrapS = THREE.RepeatWrapping;
  floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(8, 6);
  floorTex.anisotropy = 8;
  kit = {
    schoolDesk: school.scene,
    teacherDesk: teacher.scene,
    whiteboard: board.scene,
    windows: win.scene,
    bookshelf: shelf.scene,
    shelf2: shelf2.scene,
    floorTex,
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    kit = null;
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
      m.castShadow = true;
      m.receiveShadow = true;
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

function commitCollider(colliders: AABB[], obj: THREE.Object3D) {
  obj.updateMatrixWorld(true);
  colliders.push(aabbOf(obj));
}

function makeVisible(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = src.map((mat) => {
      const std = (mat as THREE.MeshStandardMaterial).clone();
      std.side = THREE.DoubleSide;
      const glass =
        std.transparent || std.opacity < 0.95 || ("transmission" in std && Number(std.transmission) > 0);
      if (glass) {
        std.transparent = true;
        std.opacity = 0.38;
        std.color.set(0x8ec4e8);
        std.emissive.set(0x5aa0d0);
        std.emissiveIntensity = 0.22;
        std.depthWrite = false;
      } else {
        std.transparent = false;
        std.opacity = 1;
        std.depthWrite = true;
      }
      return std;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
  });
}

/** Push an object so its back face sits on the inner -Z wall. */
function flushToBackWall(obj: THREE.Object3D, innerZ: number) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.z += innerZ - box.min.z + 0.03;
  obj.updateMatrixWorld(true);
}

/** Push an object so its back face sits on the inner -X wall. */
function flushToLeftWall(obj: THREE.Object3D, innerX: number) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.x += innerX - box.min.x + 0.03;
  obj.updateMatrixWorld(true);
}

export function buildClassroom(scene: THREE.Scene): { colliders: AABB[]; seats: Seat[] } {
  const colliders: AABB[] = [];
  const seats = classroomSeats();
  const { width: w, depth: d, wallHeight: h, wallThickness: t } = CLASSROOM;

  const floorMat = kit
    ? new THREE.MeshStandardMaterial({ map: kit.floorTex, roughness: 0.72, metalness: 0.02 })
    : new THREE.MeshStandardMaterial({ color: 0xb08968, roughness: 0.85 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf8f4ec, roughness: 0.88 });
  const addWall = (x: number, z: number, sx: number, sz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), wallMat);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    colliders.push({
      minX: x - sx / 2,
      maxX: x + sx / 2,
      minZ: z - sz / 2,
      maxZ: z + sz / 2,
    });
  };

  addWall(0, -d / 2 + t / 2, w, t);
  addWall(-w / 2 + t / 2, 0, t, d);
  colliders.push({
    minX: w / 2 - t,
    maxX: w / 2 + 2,
    minZ: -d / 2,
    maxZ: d / 2,
  });
  colliders.push({
    minX: -w / 2,
    maxX: w / 2,
    minZ: d / 2 - t,
    maxZ: d / 2 + 2,
  });

  const innerZ = -d / 2 + t;
  const innerX = -w / 2 + t;

  if (kit) {
    // Whiteboard GLB faces −X; yaw −90° puts the writing surface into the room.
    const board = place(scene, kit.whiteboard, 0, 0, -Math.PI / 2, { height: 2.05, y: 0.92 });
    makeVisible(board);
    flushToBackWall(board, innerZ);

    // Cluster PCA is ~0°; the old 14.6° offset was from outlier verts in the huge-scale file.
    const teacher = place(scene, kit.teacherDesk, 0, innerZ + 1.9, 0, { height: 0.92 });
    makeVisible(teacher);
    commitCollider(colliders, teacher);

    const shelf = place(scene, kit.bookshelf, 0, -6.2, -Math.PI / 2, { height: 2.45, depth: 0.58 });
    makeVisible(shelf);
    flushToLeftWall(shelf, innerX);
    commitCollider(colliders, shelf);

    for (const z of [0.55, 5.25]) {
      const extra = place(scene, kit.shelf2, 0, z, -Math.PI / 2, { height: 1.85, depth: 0.5 });
      makeVisible(extra);
      flushToLeftWall(extra, innerX);
      commitCollider(colliders, extra);
    }
    for (const x of [-4.2, 4.2]) {
      const extra = place(scene, kit.shelf2, x, 0, Math.PI, { height: 1.85, depth: 0.5 });
      makeVisible(extra);
      flushToBackWall(extra, innerZ);
      commitCollider(colliders, extra);
    }

    for (const x of [-6.55, 6.55]) {
      const win = place(scene, kit.windows, x, 0, 0, { height: 1.95, y: 0.62 });
      makeVisible(win);
      flushToBackWall(win, innerZ);
    }
    for (const z of [-1.15, 2.85]) {
      const win = place(scene, kit.windows, 0, z, Math.PI / 2, { height: 1.95, y: 0.62 });
      makeVisible(win);
      flushToLeftWall(win, innerX);
    }

    for (let row = 0; row < DESK_GRID.rows; row++) {
      for (let col = 0; col < DESK_GRID.cols; col++) {
        const x = DESK_GRID.originX + col * DESK_GRID.spacingX;
        const z = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
        const desk = place(scene, kit.schoolDesk, x, z, DESK_GRID.rotY, { height: 1.15, depth: 1.55 });
        const box = aabbOf(desk);
        // After yaw π the chair is on −Z; keep collision on the desk half.
        const midZ = (box.minZ + box.maxZ) / 2;
        colliders.push({ ...box, minZ: midZ - 0.08 });
      }
    }
  } else {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(7.5, 2.2, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x3f6b4e, roughness: 0.6 }),
    );
    board.position.set(0, 1.7, -d / 2 + 0.28);
    scene.add(board);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        const x = -6 + col * 4;
        const z = -3.2 + row * 3.1;
        colliders.push({ minX: x - 0.85, maxX: x + 0.85, minZ: z - 0.5, maxZ: z + 0.5 });
      }
    }
  }

  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8a909c, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e4, 1.12);
  sun.position.set(10, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  return { colliders, seats };
}

const RADIUS = 0.42;

function blocked(
  px: number,
  pz: number,
  boxes: AABB[],
  others: { x: number; z: number }[],
  radius = RADIUS,
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
  return others.some((o) => Math.hypot(px - o.x, pz - o.z) < radius * 2.15);
}

export function resolveMove(x: number, z: number, dx: number, dz: number, boxes: AABB[]) {
  let nx = x + dx;
  let nz = z + dz;
  if (blocked(nx, z, boxes, [])) nx = x;
  if (blocked(nx, nz, boxes, [])) nz = z;
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
    const cx = Math.max(-9.2, Math.min(9.2, px));
    const cz = Math.max(-7.2, Math.min(7.2, pz));
    if (!blocked(cx, cz, boxes, others)) return { x: cx, z: cz };
  }
  return {
    x: Math.max(-9.2, Math.min(9.2, x + backX * 1.6)),
    z: Math.max(-7.2, Math.min(7.2, z + backZ * 1.6)),
  };
}
