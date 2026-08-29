import * as THREE from "three";
import { MOVE_SPEED, SEAT_REACH, type Look, type Seat } from "@klase/shared";
import { applyLook, createAvatar, drawMic, drawSpeech, layoutHeadSprites, poseWalk, setLocalFpPresentation } from "./avatar";
import { buildClassroom, findClearStand, resolveMove, type AABB } from "./classroom";

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
const LOOK_SENS = 0.0022;
const PITCH_MAX = 1.15;
const EYE_STAND = 1.55;
const EYE_SIT = 1.15;
const EYE_FWD = 0.12;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly isoCam: THREE.OrthographicCamera;
  readonly fpCam: THREE.PerspectiveCamera;
  firstPerson = false;
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
  private sitBtn: HTMLButtonElement | null = null;
  private touchUi = false;
  private stickX = 0;
  private stickY = 0;
  private sitPrompt: HTMLElement;
  private promptPos = new THREE.Vector3();
  private moveAcc = 0;
  private lookAt = new THREE.Vector3(0, 0.75, 0);
  private camForward = new THREE.Vector3();
  private camRight = new THREE.Vector3();
  private pitch = 0;
  private lookDirty = false;
  private dragging = false;
  private lastPtrX = 0;
  private lastPtrY = 0;
  private fpWalls: THREE.Group;
  private mouseHint: HTMLElement;

  get camera(): THREE.Camera {
    return this.firstPerson ? this.fpCam : this.isoCam;
  }

  constructor(
    canvas: HTMLCanvasElement,
    localId: string,
    localName: string,
    look: Look,
    hud?: { sitBtn?: HTMLButtonElement | null },
  ) {
    this.localId = localId;
    this.isoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
    this.fpCam = new THREE.PerspectiveCamera(70, 1, 0.08, 80);
    this.fpCam.rotation.order = "YXZ";
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0xeeeae3);
    const built = buildClassroom(this.scene);
    this.colliders = built.colliders;
    this.seats = built.seats;
    this.fpWalls = built.fpWalls;
    this.sitBtn = hud?.sitBtn ?? null;
    this.touchUi = Boolean(this.sitBtn);
    this.sitPrompt = document.createElement("div");
    this.sitPrompt.className = "sit-prompt";
    this.sitPrompt.textContent = this.touchUi ? "Sit" : "E";
    this.sitPrompt.hidden = true;
    canvas.parentElement?.append(this.sitPrompt);
    this.mouseHint = document.createElement("div");
    this.mouseHint.className = "fp-mouse-hint";
    this.mouseHint.textContent = "V or Esc — toggle mouse";
    this.mouseHint.hidden = true;
    canvas.parentElement?.append(this.mouseHint);
    this.upsert(localId, localName, look, this.localX, this.localZ, this.localRot, "");
    this.bindLook(canvas);

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const key = e.key.toLowerCase();
      if (!e.repeat) this.justPressed.add(key);
      this.keys.add(key);
      if (key === "e" || key === " ") e.preventDefault();
      if (key === "v" && this.firstPerson && !this.touchUi) {
        e.preventDefault();
        this.togglePointerLock();
      }
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
    this.isoCam.left = -FRUSTUM * aspect;
    this.isoCam.right = FRUSTUM * aspect;
    this.isoCam.top = FRUSTUM;
    this.isoCam.bottom = -FRUSTUM;
    this.isoCam.updateProjectionMatrix();
    this.fpCam.aspect = aspect;
    this.fpCam.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    this.fpWalls.visible = on;
    this.pitch = 0;
    const local = this.avatars.get(this.localId);
    if (local) setLocalFpPresentation(local, on);
    this.poseFp();
    this.mouseHint.hidden = !on || this.touchUi;
    const canvas = this.renderer.domElement;
    if (!on) {
      this.dragging = false;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else if (!this.touchUi) {
      void canvas.requestPointerLock();
    }
  }

  private togglePointerLock() {
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    else void canvas.requestPointerLock();
  }

  private poseFp() {
    const eyeY = this.localSeatId ? this.seatY(this.localSeatId) + EYE_SIT : EYE_STAND;
    const fx = Math.sin(this.localRot) * EYE_FWD;
    const fz = Math.cos(this.localRot) * EYE_FWD;
    this.fpCam.position.set(this.localX + fx, eyeY, this.localZ + fz);
    this.fpCam.rotation.set(this.pitch, this.localRot + Math.PI, 0);
    this.fpCam.updateMatrixWorld();
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
      if (id === this.localId) setLocalFpPresentation(a, this.firstPerson);
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

  setStick(x: number, y: number) {
    this.stickX = x;
    this.stickY = y;
  }

  private bindLook(canvas: HTMLCanvasElement) {
    canvas.addEventListener("click", () => {
      if (!this.firstPerson || this.touchUi) return;
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.firstPerson) return;
      if (document.pointerLockElement !== canvas) return;
      this.applyLookDelta(e.movementX, e.movementY);
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.firstPerson || !this.touchUi) return;
      if (e.pointerType === "mouse") return;
      this.dragging = true;
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.firstPerson || !this.dragging) return;
      this.applyLookDelta(e.clientX - this.lastPtrX, e.clientY - this.lastPtrY);
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
    });
    const endDrag = () => {
      this.dragging = false;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  private applyLookDelta(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.localRot -= dx * LOOK_SENS;
    this.pitch -= dy * LOOK_SENS;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch));
    this.lookDirty = true;
  }

  interact() {
    this.justPressed.add("e");
  }

  applyLocalLook(look: Look) {
    const a = this.avatars.get(this.localId);
    if (!a) return;
    applyLook(a.sockets, look);
    a.look = { ...look };
  }

  showSpeech(id: string, text: string) {
    const a = this.avatars.get(id);
    if (!a || !text.trim()) return;
    drawSpeech(a.speechCanvas, a.speechTex, text);
    a.speechSprite.visible = true;
    a.speechUntil = performance.now() + 4000;
    layoutHeadSprites(a);
    if (id === this.localId) setLocalFpPresentation(a, this.firstPerson);
  }

  setVoiceLevel(id: string, level: number) {
    const a = this.avatars.get(id);
    if (!a) return;
    const v = Math.max(0, Math.min(1, level));
    if (v >= 0.08) {
      a.voiceUntil = performance.now() + 220;
      a.micSprite.visible = true;
      if (Math.abs(v - a.micFill) >= 0.04) {
        a.micFill = v;
        drawMic(a.micCanvas, a.micTex, v);
      }
    }
    layoutHeadSprites(a);
    if (id === this.localId) setLocalFpPresentation(a, this.firstPerson);
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

  private seatY(seatId: string) {
    return this.seats.find((s) => s.id === seatId)?.y ?? 0;
  }

  private updateSitPrompt(seat: Seat | null) {
    const canSit = Boolean(seat) && !this.localSeatId;
    const seated = Boolean(this.localSeatId);
    if (this.sitBtn) {
      this.sitPrompt.hidden = true;
      this.sitBtn.hidden = !(canSit || seated);
      this.sitBtn.textContent = seated ? "Stand" : "Sit";
      return;
    }
    if (!canSit) {
      this.sitPrompt.hidden = true;
      return;
    }
    this.promptPos.set(seat!.x, 1.05, seat!.z).project(this.camera);
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
    if (this.firstPerson) this.poseFp();
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
        const others = [...this.avatars.entries()]
          .filter(([id]) => id !== this.localId)
          .map(([, a]) => ({ x: a.root.position.x, z: a.root.position.z }));
        const rot = this.localRot;
        const clear = findClearStand(this.localX, this.localZ, rot, this.colliders, others);
        this.localSeatId = "";
        this.localX = clear.x;
        this.localZ = clear.z;
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
      sx += this.stickX;
      sy += this.stickY;

      if (sx || sy) {
        const len = Math.hypot(sx, sy) || 1;
        sx /= len;
        sy /= len;
        const dx = (this.camForward.x * sy + this.camRight.x * sx) * MOVE_SPEED * dt;
        const dz = (this.camForward.z * sy + this.camRight.z * sx) * MOVE_SPEED * dt;
        const others = [...this.avatars.entries()]
          .filter(([id]) => id !== this.localId)
          .map(([, a]) => ({ x: a.root.position.x, z: a.root.position.z }));
        const n = resolveMove(this.localX, this.localZ, dx, dz, this.colliders, others);
        this.localX = n.x;
        this.localZ = n.z;
        if (!this.firstPerson) this.localRot = Math.atan2(dx, dz);
        moved = true;
      }
    }

    const local = this.avatars.get(this.localId);
    if (local) {
      local.root.position.set(this.localX, this.seatY(this.localSeatId), this.localZ);
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
        a.root.position.set(a.target.x, this.seatY(a.seatId), a.target.z);
        a.root.rotation.y = a.targetRot;
      } else {
        a.root.position.lerp(a.target, 1 - Math.pow(0.001, dt));
        a.root.rotation.y += (a.targetRot - a.root.rotation.y) * 0.15;
      }
      const moving = !seated && Math.hypot(a.root.position.x - px, a.root.position.z - pz) > 0.002;
      poseWalk(a, dt, moving, seated);
    }

    const now = performance.now();
    for (const a of this.avatars.values()) {
      if (a.speechSprite.visible && now >= a.speechUntil) a.speechSprite.visible = false;
      if (a.micSprite.visible && now >= a.voiceUntil) {
        a.micSprite.visible = false;
        a.micFill = -1;
      }
      layoutHeadSprites(a);
    }
    const localHud = this.avatars.get(this.localId);
    if (localHud) setLocalFpPresentation(localHud, this.firstPerson);

    const cam = this.camera;
    if (this.firstPerson) {
      this.poseFp();
    } else {
      const player = new THREE.Vector3(this.localX, 0.75, this.localZ);
      this.lookAt.lerp(player, Math.min(1, 6 * dt));
      this.isoCam.position.copy(this.lookAt).add(ISO);
      this.isoCam.lookAt(this.lookAt);
      this.isoCam.updateMatrixWorld();
    }
    this.updateSitPrompt(this.localSeatId ? null : this.nearestSeat());
    this.renderer.render(this.scene, cam);

    if (event) return event;
    this.moveAcc += dt;
    if (moved && this.moveAcc > 0.05) {
      this.moveAcc = 0;
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    if (this.lookDirty) {
      this.lookDirty = false;
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    return null;
  }
}
