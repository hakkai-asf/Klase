import * as THREE from "three";
import { MOVE_SPEED, type Look } from "@klase/shared";
import { applyLook, createAvatar, poseWalk } from "./avatar";
import { buildClassroom, preloadClassroom, resolveMove, type AABB } from "./classroom";

type AvatarHandle = ReturnType<typeof createAvatar> & { target: THREE.Vector3; targetRot: number };

const ISO = new THREE.Vector3(12, 15, 12);
const FRUSTUM = 3.85;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly localId: string;
  localX = 0;
  localZ = 5.5;
  localRot = Math.PI;
  private colliders: AABB[] = [];
  private avatars = new Map<string, AvatarHandle>();
  private keys = new Set<string>();
  private moveAcc = 0;
  private lookAt = new THREE.Vector3(0, 0.75, 0);
  private camForward = new THREE.Vector3();
  private camRight = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, localId: string, localName: string, look: Look) {
    this.localId = localId;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0xeeeae3);
    this.colliders = buildClassroom(this.scene);
    this.upsert(localId, localName, look, this.localX, this.localZ, this.localRot);

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    const wrap = this.renderer.domElement.parentElement!;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const aspect = w / Math.max(h, 1);
    this.camera.left = -FRUSTUM * aspect;
    this.camera.right = FRUSTUM * aspect;
    this.camera.top = FRUSTUM;
    this.camera.bottom = -FRUSTUM;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  upsert(id: string, name: string, look: Look, x: number, z: number, rotY: number) {
    let a = this.avatars.get(id);
    if (a && a.look.body !== look.body) {
      this.scene.remove(a.root);
      this.avatars.delete(id);
      a = undefined;
    }
    if (!a) {
      a = { ...createAvatar(look, name), target: new THREE.Vector3(x, 0, z), targetRot: rotY };
      this.scene.add(a.root);
      this.avatars.set(id, a);
    } else if (
      a.look.hat !== look.hat ||
      a.look.top !== look.top ||
      a.look.accessory !== look.accessory
    ) {
      applyLook(a.sockets, look);
      a.look = { ...look };
    }
    if (id !== this.localId) {
      a.target.set(x, 0, z);
      a.targetRot = rotY;
    }
  }

  remove(id: string) {
    const a = this.avatars.get(id);
    if (!a) return;
    this.scene.remove(a.root);
    this.avatars.delete(id);
  }

  ids() {
    return [...this.avatars.keys()];
  }

  positions() {
    const out = new Map<string, { x: number; z: number }>();
    for (const [id, a] of this.avatars) {
      out.set(id, { x: a.root.position.x, z: a.root.position.z });
    }
    return out;
  }

  applyLocalLook(look: Look) {
    const a = this.avatars.get(this.localId);
    if (!a) return;
    applyLook(a.sockets, look);
    a.look = { ...look };
  }

  step(dt: number): { x: number; z: number; rotY: number } | null {
    this.camera.getWorldDirection(this.camForward);
    this.camForward.y = 0;
    if (this.camForward.lengthSq() > 0.0001) this.camForward.normalize();
    this.camRight.set(-this.camForward.z, 0, this.camForward.x);

    let sx = 0;
    let sy = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) sy += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) sy -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) sx += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) sx -= 1;

    let moved = false;
    if (sx || sy) {
      const len = Math.hypot(sx, sy) || 1;
      sx /= len;
      sy /= len;
      const dx = (this.camForward.x * sy + this.camRight.x * sx) * MOVE_SPEED * dt;
      const dz = (this.camForward.z * sy + this.camRight.z * sx) * MOVE_SPEED * dt;
      const n = resolveMove(this.localX, this.localZ, dx, dz, this.colliders);
      this.localX = n.x;
      this.localZ = n.z;
      this.localRot = Math.atan2(dx, dz);
      moved = true;
    }

    const local = this.avatars.get(this.localId);
    if (local) {
      local.root.position.set(this.localX, 0, this.localZ);
      local.root.rotation.y = this.localRot;
      poseWalk(local, dt, moved);
      local.lastX = this.localX;
      local.lastZ = this.localZ;
    }

    for (const [id, a] of this.avatars) {
      if (id === this.localId) continue;
      const px = a.root.position.x;
      const pz = a.root.position.z;
      a.root.position.lerp(a.target, 1 - Math.pow(0.001, dt));
      a.root.rotation.y += (a.targetRot - a.root.rotation.y) * 0.15;
      const moving = Math.hypot(a.root.position.x - px, a.root.position.z - pz) > 0.002;
      poseWalk(a, dt, moving);
    }

    const player = new THREE.Vector3(this.localX, 0.75, this.localZ);
    const desired = player.clone();
    this.lookAt.lerp(desired, Math.min(1, 6 * dt));
    this.camera.position.copy(this.lookAt).add(ISO);
    this.camera.lookAt(this.lookAt);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);

    this.moveAcc += dt;
    if (moved && this.moveAcc > 0.05) {
      this.moveAcc = 0;
      return { x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    return null;
  }
}
