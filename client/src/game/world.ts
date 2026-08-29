import * as THREE from "three";
import { MOVE_SPEED, SEAT_REACH, type Look, type Seat } from "@klase/shared";
import { applyLook, createAvatar, poseWalk } from "./avatar";
import { buildClassroom, resolveMove, type AABB } from "./classroom";

type AvatarHandle = ReturnType<typeof createAvatar> & {
  target: THREE.Vector3;
  targetRot: number;
  seatId: string;
};

export type WorldEvent =
  | { type: "move"; x: number; z: number; rotY: number }
  | { type: "sit"; seatId: string }
  | { type: "stand" };

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
  private seats: Seat[] = [];
  private avatars = new Map<string, AvatarHandle>();
  private keys = new Set<string>();
  private justPressed = new Set<string>();
  private localSeatId = "";
  private sitPrompt: HTMLElement;
  private promptPos = new THREE.Vector3();
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
    const built = buildClassroom(this.scene);
    this.colliders = built.colliders;
    this.seats = built.seats;
    this.sitPrompt = document.createElement("div");
    this.sitPrompt.className = "sit-prompt";
    this.sitPrompt.textContent = "E";
    this.sitPrompt.hidden = true;
    canvas.parentElement?.append(this.sitPrompt);
    this.upsert(localId, localName, look, this.localX, this.localZ, this.localRot, "");

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const key = e.key.toLowerCase();
      if (!e.repeat) this.justPressed.add(key);
      this.keys.add(key);
      if (key === "e" || key === " ") e.preventDefault();
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

  upsert(id: string, name: string, look: Look, x: number, z: number, rotY: number, seatId = "") {
    let a = this.avatars.get(id);
    if (a && a.look.body !== look.body) {
      this.scene.remove(a.root);
      this.avatars.delete(id);
      a = undefined;
    }
    if (!a) {
      a = {
        ...createAvatar(look, name),
        target: new THREE.Vector3(x, 0, z),
        targetRot: rotY,
        seatId,
      };
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
    a.seatId = seatId;
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

  private occupiedSeats() {
    const taken = new Set<string>();
    for (const [id, a] of this.avatars) {
      if (id === this.localId) continue;
      if (a.seatId) taken.add(a.seatId);
    }
    return taken;
  }

  private nearestSeat() {
    const taken = this.occupiedSeats();
    let best: Seat | null = null;
    let bestD = SEAT_REACH;
    for (const seat of this.seats) {
      if (taken.has(seat.id)) continue;
      const d = Math.hypot(this.localX - seat.x, this.localZ - seat.z);
      if (d < bestD) {
        bestD = d;
        best = seat;
      }
    }
    return best;
  }

  private updateSitPrompt(seat: Seat | null) {
    if (!seat || this.localSeatId) {
      this.sitPrompt.hidden = true;
      return;
    }
    this.promptPos.set(seat.x, 1.05, seat.z).project(this.camera);
    if (this.promptPos.z > 1) {
      this.sitPrompt.hidden = true;
      return;
    }
    const wrap = this.renderer.domElement.parentElement!;
    const x = (this.promptPos.x * 0.5 + 0.5) * wrap.clientWidth;
    const y = (-this.promptPos.y * 0.5 + 0.5) * wrap.clientHeight;
    this.sitPrompt.hidden = false;
    this.sitPrompt.style.left = `${x}px`;
    this.sitPrompt.style.top = `${y}px`;
  }

  step(dt: number): WorldEvent | null {
    this.camera.getWorldDirection(this.camForward);
    this.camForward.y = 0;
    if (this.camForward.lengthSq() > 0.0001) this.camForward.normalize();
    this.camRight.set(-this.camForward.z, 0, this.camForward.x);

    const pressedE = this.justPressed.has("e");
    const pressedSpace = this.justPressed.has(" ");
    this.justPressed.clear();

    let event: WorldEvent | null = null;
    if (this.localSeatId) {
      if (pressedE || pressedSpace) {
        this.localSeatId = "";
        this.localZ += 0.4;
        const local = this.avatars.get(this.localId);
        if (local) local.seatId = "";
        event = { type: "stand" };
      }
    } else {
      const near = this.nearestSeat();
      if (pressedE && near) {
        this.localSeatId = near.id;
        this.localX = near.x;
        this.localZ = near.z;
        this.localRot = near.rotY;
        const local = this.avatars.get(this.localId);
        if (local) local.seatId = near.id;
        event = { type: "sit", seatId: near.id };
      }
    }

    let moved = false;
    if (!this.localSeatId) {
      let sx = 0;
      let sy = 0;
      if (this.keys.has("w") || this.keys.has("arrowup")) sy += 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) sy -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) sx += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) sx -= 1;

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
    }

    const local = this.avatars.get(this.localId);
    if (local) {
      local.root.position.set(this.localX, 0, this.localZ);
      local.root.rotation.y = this.localRot;
      poseWalk(local, dt, moved, Boolean(this.localSeatId));
      local.lastX = this.localX;
      local.lastZ = this.localZ;
    }

    for (const [id, a] of this.avatars) {
      if (id === this.localId) continue;
      const seated = Boolean(a.seatId);
      const px = a.root.position.x;
      const pz = a.root.position.z;
      if (seated) {
        a.root.position.set(a.target.x, 0, a.target.z);
        a.root.rotation.y = a.targetRot;
      } else {
        a.root.position.lerp(a.target, 1 - Math.pow(0.001, dt));
        a.root.rotation.y += (a.targetRot - a.root.rotation.y) * 0.15;
      }
      const moving = !seated && Math.hypot(a.root.position.x - px, a.root.position.z - pz) > 0.002;
      poseWalk(a, dt, moving, seated);
    }

    const player = new THREE.Vector3(this.localX, 0.75, this.localZ);
    const desired = player.clone();
    this.lookAt.lerp(desired, Math.min(1, 6 * dt));
    this.camera.position.copy(this.lookAt).add(ISO);
    this.camera.lookAt(this.lookAt);
    this.camera.updateMatrixWorld();
    this.updateSitPrompt(this.localSeatId ? null : this.nearestSeat());
    this.renderer.render(this.scene, this.camera);

    if (event) return event;
    this.moveAcc += dt;
    if (moved && this.moveAcc > 0.05) {
      this.moveAcc = 0;
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    return null;
  }
}
