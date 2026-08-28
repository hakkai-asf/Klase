import * as THREE from "three";
import { CLASSROOM } from "@klase/shared";

export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

export function buildClassroom(scene: THREE.Scene): AABB[] {
  const colliders: AABB[] = [];
  const { width: w, depth: d, wallHeight: h, wallThickness: t } = CLASSROOM;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0xc4b49a, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xefe6d6, roughness: 0.85 });
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

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(7.5, 2.2, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x3f6b4e, roughness: 0.6 }),
  );
  board.position.set(0, 1.7, -d / 2 + 0.28);
  scene.add(board);

  const deskMat = new THREE.MeshStandardMaterial({ color: 0x8b5a3c, roughness: 0.7 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0xd7c4a3, roughness: 0.55 });
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = -6 + col * 4;
      const z = -3.2 + row * 3.1;
      const group = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.9), topMat);
      top.position.y = 0.78;
      top.castShadow = true;
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.8), deskMat);
      body.position.y = 0.4;
      body.castShadow = true;
      group.add(top, body);
      group.position.set(x, 0, z);
      scene.add(group);
      colliders.push({ minX: x - 0.85, maxX: x + 0.85, minZ: z - 0.5, maxZ: z + 0.5 });
    }
  }

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x6b7a8a, 0.85));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
  sun.position.set(10, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  return colliders;
}

const RADIUS = 0.42;

export function resolveMove(x: number, z: number, dx: number, dz: number, boxes: AABB[]) {
  let nx = x + dx;
  let nz = z + dz;
  const hit = (px: number, pz: number) =>
    boxes.some(
      (b) =>
        px + RADIUS > b.minX &&
        px - RADIUS < b.maxX &&
        pz + RADIUS > b.minZ &&
        pz - RADIUS < b.maxZ,
    );
  if (hit(nx, z)) nx = x;
  if (hit(nx, nz)) nz = z;
  return { x: nx, z: nz };
}
