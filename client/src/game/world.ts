import * as THREE from "three";
import { CLASSROOM, MOVE_SPEED, SEAT_REACH, SPAWN, clampClassroom, type Look, type Seat } from "@klase/shared";
import { applyLook, createAvatar, disposeAvatar, hasCharacterRig, drawMic, drawName, drawSpeech, layoutHeadSprites, poseWalk, setGlobalAnisotropy, setLocalFpPresentation } from "./avatar";
import { buildClassroom, findClearStand, nearExitDoor, nearestExitDoor, resolveMove, type AABB } from "./classroom";

type AvatarHandle = ReturnType<typeof createAvatar> & {
  target: THREE.Vector3;
  targetRot: number;
  seatId: string;
};

export type WorldEvent =
  | { type: "move"; x: number; z: number; rotY: number }
  | { type: "sit"; seatId: string }
  | { type: "stand" }
  | { type: "exit" };

const ISO = new THREE.Vector3(12, 15, 12);
const ISO_FRUSTUM = 3.85;
const ISO_FRUSTUM_TOUCH = 4.8;
const ISO_ZOOM_IN = 0.65;
const ISO_ZOOM_OUT = 1.45;
const LOOK_SENS = 0.0022;
const LOOK_SENS_TOUCH = 0.0038;
const PITCH_MAX = 1.15;
const EYE_STAND = 1.55;
const EYE_SIT = 1.38;
const EYE_FWD = 0.12;
const FP_FAR = 80;
const FREE_FAR = 200;
const FREE_SPEED = 6.5;
const FREE_SPRINT = 14;
const SPEECH_HOLD = 4000;
const SPEECH_FADE_IN = 0.12;
const SPEECH_FADE_OUT = 0.25;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly isoCam: THREE.OrthographicCamera;
  readonly fpCam: THREE.PerspectiveCamera;
  firstPerson = false;
  freeCam = false;
  aerialCamMode = false;
  private spectator = false;
  private spectatorAvatarsVisible = false;
  private inputLocked = false;
  private disposed = false;
  readonly localId: string;
  localX = SPAWN.x;
  localZ = SPAWN.z;
  localRot = SPAWN.rotY;
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
  private isoWalls: THREE.Group;
  private hintWrap: HTMLElement;
  private viewHint: HTMLElement;
  private mouseHint: HTMLElement;
  private onFirstPersonChange?: (on: boolean) => void;
  private onFreeCamChange?: (on: boolean) => void;
  private isoZoomT = 0.5;
  private ownerTools = false;
  private freeReturnFp = false;
  private readonly freeLook = new THREE.Vector3();
  private readonly freeRight = new THREE.Vector3();
  private readonly freeMove = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private lookUnbinds: Array<() => void> = [];

  get isDisposed() {
    return this.disposed;
  }

  get camera(): THREE.Camera {
    return this.firstPerson || this.freeCam ? this.fpCam : this.isoCam;
  }

  constructor(
    canvas: HTMLCanvasElement,
    localId: string,
    localName: string,
    look: Look,
    hud?: {
      sitBtn?: HTMLButtonElement | null;
      onFirstPersonChange?: (on: boolean) => void;
      onFreeCamChange?: (on: boolean) => void;
    },
  ) {
    this.localId = localId;
    this.isoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
    this.fpCam = new THREE.PerspectiveCamera(70, 1, 0.08, FP_FAR);
    this.fpCam.rotation.order = "YXZ";
    this.isoCam.layers.enable(1);
    this.fpCam.layers.enable(1);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (devicePixelRatio || 1) <= 1,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.15));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    // Push max anisotropy into sprite textures so nametags/speech/mic are crisp
    setGlobalAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.background = new THREE.Color(0xe4e8f4);
    const built = buildClassroom(this.scene);
    this.colliders = built.colliders;
    this.seats = built.seats;
    this.fpWalls = built.fpWalls;
    this.isoWalls = built.isoWalls;
    this.sitBtn = hud?.sitBtn ?? null;
    this.touchUi = Boolean(this.sitBtn);
    this.onFirstPersonChange = hud?.onFirstPersonChange;
    this.onFreeCamChange = hud?.onFreeCamChange;
    this.sitPrompt = document.createElement("div");
    this.sitPrompt.className = "sit-prompt";
    this.sitPrompt.textContent = this.touchUi ? "Sit" : "E";
    this.sitPrompt.hidden = true;
    canvas.parentElement?.append(this.sitPrompt);
    this.hintWrap = document.createElement("div");
    this.hintWrap.className = "fp-hints";
    this.hintWrap.hidden = this.touchUi;
    this.viewHint = document.createElement("div");
    this.viewHint.className = "fp-hint";
    this.viewHint.textContent = "V — first person";
    this.mouseHint = document.createElement("div");
    this.mouseHint.className = "fp-hint";
    this.mouseHint.textContent = "Esc — toggle mouse";
    this.mouseHint.hidden = true;
    this.hintWrap.append(this.viewHint, this.mouseHint);
    canvas.parentElement?.append(this.hintWrap);
    if (localId) {
      this.upsert(localId, localName, look, this.localX, this.localZ, this.localRot, "");
    }
    this.bindLook(canvas);

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.disposed || this.spectator || this.inputLocked) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const key = e.key.toLowerCase();
    if (!e.repeat) this.justPressed.add(key);
    this.keys.add(key);
    if (key === "e" || key === " ") e.preventDefault();
    if (this.touchUi) return;
    if (key === "v") {
      e.preventDefault();
      if (this.freeCam) this.setFreeCam(false);
      else this.setFirstPerson(!this.firstPerson);
      return;
    }
    if (key === "c" && this.ownerTools) {
      e.preventDefault();
      this.setFreeCam(!this.freeCam);
      return;
    }
    if (!this.firstPerson && !this.freeCam) return;
    if (key === "escape" && document.pointerLockElement !== this.renderer.domElement) {
      e.preventDefault();
      void this.renderer.domElement.requestPointerLock();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onResize = () => {
    if (!this.disposed) this.resize();
  };

  setInputLocked(on: boolean) {
    this.inputLocked = on;
    this.keys.clear();
    this.justPressed.clear();
    this.stickX = 0;
    this.stickY = 0;
    if (on && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  atExitDoor() {
    return !this.localSeatId && !this.freeCam && !this.aerialCamMode && nearExitDoor(this.localX, this.localZ);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.inputLocked = true;
    this.keys.clear();
    this.justPressed.clear();
    this.stickX = 0;
    this.stickY = 0;
    this.dragging = false;
    try {
      this.unbindLook();
    } catch {
      /* */
    }
    try {
      if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    } catch {
      /* */
    }
    try {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("resize", this.onResize);
    } catch {
      /* */
    }
    try {
      this.sitPrompt.remove();
    } catch {
      /* */
    }
    try {
      this.hintWrap.remove();
    } catch {
      /* */
    }
    for (const a of this.avatars.values()) {
      try {
        disposeAvatar(a);
      } catch {
        /* */
      }
    }
    this.avatars.clear();
    try {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    } catch {
      /* already torn down */
    }
    try {
      this.scene.clear();
    } catch {
      /* */
    }
  }

  resize() {
    const wrap = this.renderer.domElement.parentElement!;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const aspect = w / Math.max(h, 1);
    const frustum = this.isoFrustum();
    this.isoCam.left = -frustum * aspect;
    this.isoCam.right = frustum * aspect;
    this.isoCam.top = frustum;
    this.isoCam.bottom = -frustum;
    this.isoCam.updateProjectionMatrix();
    this.fpCam.aspect = aspect;
    this.fpCam.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /** 0 = zoomed in, 0.5 = default, 1 = zoomed out. Iso camera only. */
  setIsoZoom(t: number) {
    this.isoZoomT = Math.max(0, Math.min(1, t));
    this.resize();
  }

  private isoFrustum() {
    const base = this.touchUi ? ISO_FRUSTUM_TOUCH : ISO_FRUSTUM;
    if (this.spectator) return base * 1.55;
    const t = this.isoZoomT;
    const mul =
      t <= 0.5 ? ISO_ZOOM_IN + (t / 0.5) * (1 - ISO_ZOOM_IN) : 1 + ((t - 0.5) / 0.5) * (ISO_ZOOM_OUT - 1);
    return base * mul;
  }

  setFirstPerson(on: boolean) {
    if (this.freeCam) this.endFreeCam();
    this.firstPerson = on;
    this.fpWalls.visible = on;
    this.isoWalls.visible = !on;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, on ? 1 : 1.15));
    this.resize();
    this.scene.background = new THREE.Color(on ? 0xe3e0db : 0xe4e8f4);
    this.pitch = 0;
    const local = this.avatars.get(this.localId);
    if (local) setLocalFpPresentation(local, on, Boolean(this.localSeatId));
    this.poseFp();
    this.viewHint.textContent = on ? "V — classroom view" : "V — first person";
    this.mouseHint.hidden = !on || this.touchUi;
    const canvas = this.renderer.domElement;
    if (!on) {
      this.dragging = false;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else if (!this.touchUi) {
      void canvas.requestPointerLock();
    }
    this.onFirstPersonChange?.(on);
  }

  setOwnerTools(on: boolean) {
    this.ownerTools = on;
    if (!on && this.freeCam) this.setFreeCam(false);
  }

  /** Observe mode from the dashboard: no body, silent, locked free camera. */
  private godMode = false;
  /** Staff noclip: invisible, ignore walls; position follows movement / free cam. */
  noclip = false;

  setGodMode(on: boolean) {
    this.godMode = on;
    const local = this.avatars.get(this.localId);
    if (on && local) local.root.visible = false;
  }

  setNoclip(on: boolean) {
    this.noclip = on;
    if (on) this.localSeatId = "";
    else {
      const c = clampClassroom(this.localX, this.localZ);
      this.localX = c.x;
      this.localZ = c.z;
    }
    const local = this.avatars.get(this.localId);
    if (local) local.root.visible = !on && !this.godMode;
  }

  setFreeCam(on: boolean) {
    if (on && !this.ownerTools) return;
    if (!on && this.godMode) return; // observe mode stays in free cam
    if (on === this.freeCam) return;
    if (on) this.startFreeCam();
    else {
      const backToFp = this.freeReturnFp;
      this.endFreeCam();
      this.setFirstPerson(backToFp);
    }
  }

  private startFreeCam() {
    this.freeReturnFp = this.firstPerson;
    if (!this.firstPerson) this.poseFp();
    this.freeCam = true;
    this.firstPerson = false;
    this.fpCam.far = FREE_FAR;
    this.fpCam.updateProjectionMatrix();
    this.fpWalls.visible = true;
    this.isoWalls.visible = false;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1));
    this.scene.background = new THREE.Color(0xe3e0db);
    this.viewHint.textContent = "C — exit free cam";
    this.mouseHint.hidden = this.touchUi;
    const local = this.avatars.get(this.localId);
    if (local) setLocalFpPresentation(local, false, Boolean(this.localSeatId));
    if (!this.touchUi) void this.renderer.domElement.requestPointerLock();
    this.onFirstPersonChange?.(true);
    this.onFreeCamChange?.(true);
  }

  private endFreeCam() {
    if (!this.freeCam) return;
    this.freeCam = false;
    this.fpCam.far = FP_FAR;
    this.fpCam.updateProjectionMatrix();
    this.onFreeCamChange?.(false);
  }

  setSpectatorAvatars(visible: boolean) {
    this.spectatorAvatarsVisible = visible;
    for (const [id, a] of this.avatars) {
      if (id === this.localId) {
        a.root.visible = !this.spectator;
      } else {
        a.root.visible = visible || !this.spectator;
      }
    }
  }

  setLocalId(localId: string, name: string, look: Look, role = "") {
    (this as any).localId = localId;
    this.upsert(localId, name, look, this.localX, this.localZ, this.localRot, "", role);
  }

  setSpectatorMode(on: boolean) {
    this.spectator = on;
    if (on) {
      // Clear all active input state so no stale keys/drag carry over
      this.keys.clear();
      this.justPressed.clear();
      this.dragging = false;
      this.firstPerson = false;
      this.freeCam = false;
      this.noclip = false;
      this.godMode = false;
      this.localSeatId = "";
      this.localX = SPAWN.x;
      this.localZ = SPAWN.z;
      this.localRot = SPAWN.rotY;
      this.lookAt.set(0, 0.75, 0);
      this.isoCam.position.copy(this.lookAt).add(ISO);
      this.isoCam.lookAt(this.lookAt);
      // Release pointer lock if held
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
    }
    if (this.hintWrap) this.hintWrap.style.display = on ? "none" : "";
    if (this.sitPrompt) this.sitPrompt.style.display = on ? "none" : "";
    for (const a of this.avatars.values()) {
      a.root.visible = !on;
    }
    this.resize();
  }

  setAerial(on: boolean) {
    this.setSpectatorMode(on);
    this.scene.background = new THREE.Color(on ? 0xe4e8f4 : (this.firstPerson || this.freeCam ? 0xe3e0db : 0xe4e8f4));
  }

  private poseFp() {
    const eyeY = this.localSeatId ? EYE_SIT : EYE_STAND;
    const fx = Math.sin(this.localRot) * EYE_FWD;
    const fz = Math.cos(this.localRot) * EYE_FWD;
    this.fpCam.position.set(this.localX + fx, eyeY, this.localZ + fz);
    this.fpCam.rotation.set(this.pitch, this.localRot + Math.PI, 0);
    this.fpCam.updateMatrixWorld();
  }

  upsert(id: string, name: string, look: Look, x: number, z: number, rotY: number, seatId = "", role = "", hidden = false) {
    let a = this.avatars.get(id);
    if (a && (a.look.body !== look.body || (a.pending && hasCharacterRig(look.body)))) {
      disposeAvatar(a);
      this.scene.remove(a.root);
      this.avatars.delete(id);
      a = undefined;
    }
    if (!a) {
      a = {
        ...createAvatar(look, name, role),
        target: new THREE.Vector3(x, 0, z),
        targetRot: rotY,
        seatId,
        role,
      };
      this.scene.add(a.root);
      this.avatars.set(id, a);
      if (this.spectator) {
        a.root.visible = false;
      } else if (id === this.localId) {
        setLocalFpPresentation(a, this.firstPerson, Boolean(this.localSeatId));
        if (this.godMode || this.noclip) a.root.visible = false;
      }
    } else {
      if (
        a.look.hat !== look.hat ||
        a.look.top !== look.top ||
        a.look.accessory !== look.accessory
      ) {
        applyLook(a.sockets, look);
        a.look = { ...look };
      }
      if (a.role !== role) {
        a.role = role;
        drawName(a.canvas, a.tex, name, role);
      }
    }
    a.seatId = seatId;
    if (id !== this.localId) {
      a.target.set(x, 0, z);
      a.targetRot = rotY;
      a.root.visible = !hidden;
    }
  }

  remove(id: string) {
    const a = this.avatars.get(id);
    if (!a) return;
    disposeAvatar(a);
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
    const onClick = () => {
      if (this.disposed || this.spectator) return;
      if ((!this.firstPerson && !this.freeCam) || this.touchUi) return;
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (this.disposed || this.spectator) return;
      if (!this.firstPerson && !this.freeCam) return;
      if (document.pointerLockElement !== canvas) return;
      this.applyLookDelta(e.movementX, e.movementY);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (this.disposed || this.spectator) return;
      if ((!this.firstPerson && !this.freeCam) || !this.touchUi) return;
      if (e.pointerType === "mouse") return;
      this.dragging = true;
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.disposed || this.spectator) return;
      if ((!this.firstPerson && !this.freeCam) || !this.dragging) return;
      this.applyLookDelta(e.clientX - this.lastPtrX, e.clientY - this.lastPtrY);
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
    };
    const endDrag = () => {
      this.dragging = false;
    };
    canvas.addEventListener("click", onClick);
    document.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    this.lookUnbinds.push(
      () => canvas.removeEventListener("click", onClick),
      () => document.removeEventListener("mousemove", onMouseMove),
      () => canvas.removeEventListener("pointerdown", onPointerDown),
      () => canvas.removeEventListener("pointermove", onPointerMove),
      () => canvas.removeEventListener("pointerup", endDrag),
      () => canvas.removeEventListener("pointercancel", endDrag),
    );
  }

  private unbindLook() {
    for (const fn of this.lookUnbinds.splice(0)) {
      try {
        fn();
      } catch {
        /* */
      }
    }
  }

  private applyLookDelta(dx: number, dy: number) {
    if (!dx && !dy) return;
    const sens = this.touchUi ? LOOK_SENS_TOUCH : LOOK_SENS;
    if (this.freeCam) {
      this.fpCam.rotation.y -= dx * sens;
      this.fpCam.rotation.x = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.fpCam.rotation.x - dy * sens));
      this.fpCam.updateMatrixWorld();
      return;
    }
    this.localRot -= dx * sens;
    this.pitch -= dy * sens;
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
    a.speechUntil = performance.now() + SPEECH_HOLD;
    a.speechSprite.visible = true;
    layoutHeadSprites(a, this.firstPerson ? this.fpCam : this.camera);
    if (id === this.localId) setLocalFpPresentation(a, this.firstPerson, Boolean(this.localSeatId));
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
    layoutHeadSprites(a, this.firstPerson ? this.fpCam : this.camera);
    if (id === this.localId) setLocalFpPresentation(a, this.firstPerson, Boolean(this.localSeatId));
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

  private seatFacing(seatId: string) {
    return this.seats.find((s) => s.id === seatId)?.rotY ?? this.localRot;
  }

  private tickSpeech(a: AvatarHandle, now: number, dt: number) {
    const target = now < a.speechUntil ? 1 : 0;
    const speed = (target > a.speechFade ? dt / SPEECH_FADE_IN : dt / SPEECH_FADE_OUT);
    if (target > a.speechFade) a.speechFade = Math.min(1, a.speechFade + speed);
    else a.speechFade = Math.max(0, a.speechFade - speed);
    const mat = a.speechSprite.material as THREE.SpriteMaterial;
    mat.opacity = a.speechFade;
    a.speechSprite.visible = a.speechFade > 0.01;
  }

  private updateSitPrompt(seat: Seat | null) {
    if (this.freeCam || this.aerialCamMode || this.inputLocked || this.spectator) {
      this.sitPrompt.hidden = true;
      if (this.sitBtn) this.sitBtn.hidden = true;
      return;
    }
    const atDoor = this.atExitDoor();
    const canSit = Boolean(seat) && !this.localSeatId && !atDoor;
    const seated = Boolean(this.localSeatId);
    if (this.sitBtn) {
      this.sitPrompt.hidden = true;
      this.sitBtn.hidden = !(canSit || seated || atDoor);
      this.sitBtn.textContent = seated ? "Stand" : atDoor ? "Exit" : "Sit";
      return;
    }
    if (seated) {
      this.sitPrompt.hidden = false;
      this.sitPrompt.classList.add("stand-hud");
      this.sitPrompt.classList.toggle("above-fp-hint", this.firstPerson);
      this.sitPrompt.textContent = "E or Space — stand up";
      this.sitPrompt.style.left = "";
      this.sitPrompt.style.top = "";
      return;
    }
    this.sitPrompt.classList.remove("stand-hud", "above-fp-hint");
    const worldTarget = atDoor ? nearestExitDoor(this.localX, this.localZ) : seat;
    this.sitPrompt.textContent = atDoor ? "E to Exit" : "E";
    if (!worldTarget || (!canSit && !atDoor)) {
      this.sitPrompt.hidden = true;
      return;
    }
    this.promptPos.set(worldTarget.x, 1.05, worldTarget.z).project(this.camera);
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

  private stepFreeCam(dt: number): WorldEvent | null {
    this.justPressed.clear();
    if (this.godMode || this.noclip) {
      const self = this.avatars.get(this.localId);
      if (self) self.root.visible = false;
      if (this.noclip && !this.godMode) {
        this.localX = this.fpCam.position.x;
        this.localZ = this.fpCam.position.z;
      }
    }
    this.fpCam.getWorldDirection(this.freeLook);
    this.freeRight.crossVectors(this.freeLook, this.worldUp);
    if (this.freeRight.lengthSq() < 1e-8) this.freeRight.set(1, 0, 0);
    else this.freeRight.normalize();

    this.freeMove.set(0, 0, 0);
    if (this.keys.has("w") || this.keys.has("arrowup")) this.freeMove.add(this.freeLook);
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.freeMove.sub(this.freeLook);
    if (this.keys.has("d") || this.keys.has("arrowright")) this.freeMove.add(this.freeRight);
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.freeMove.sub(this.freeRight);
    if (this.keys.has("q") || this.keys.has(" ")) this.freeMove.y += 1;
    if (this.keys.has("e") || this.keys.has("control")) this.freeMove.y -= 1;
    if (this.freeMove.lengthSq() > 0) {
      const speed = this.keys.has("shift") ? FREE_SPRINT : FREE_SPEED;
      this.freeMove.normalize().multiplyScalar(speed * dt);
      this.fpCam.position.add(this.freeMove);
    }
    this.fpCam.updateMatrixWorld();

    const local = this.avatars.get(this.localId);
    if (local) {
      local.root.position.set(this.localX, this.seatY(this.localSeatId), this.localZ);
      local.root.rotation.y = this.localSeatId ? this.seatFacing(this.localSeatId) : this.localRot;
      poseWalk(local, dt, false, Boolean(this.localSeatId));
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
      this.tickSpeech(a, now, dt);
      if (a.micSprite.visible && now >= a.voiceUntil) {
        a.micSprite.visible = false;
        a.micFill = -1;
      }
      layoutHeadSprites(a, this.fpCam);
    }

    this.updateSitPrompt(null);
    this.lookDirty = false;
    this.renderer.render(this.scene, this.fpCam);
    if (this.noclip && !this.godMode) {
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    return null;
  }

  step(dt: number): WorldEvent | null {
    if (this.disposed) return null;
    if (this.inputLocked) {
      this.justPressed.clear();
      this.keys.clear();
      this.updateSitPrompt(null);
      this.renderer.render(this.scene, this.camera);
      return null;
    }
    if (this.freeCam) return this.stepFreeCam(dt);
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
        const rot = this.seatFacing(this.localSeatId);
        const clear = findClearStand(this.localX, this.localZ, rot, this.colliders, others);
        this.localSeatId = "";
        this.localX = clear.x;
        this.localZ = clear.z;
        const local = this.avatars.get(this.localId);
        if (local) local.seatId = "";
        event = { type: "stand" };
      }
    } else if (pressedE && this.atExitDoor()) {
      event = { type: "exit" };
    } else {
      const near = this.nearestSeat();
      if (pressedE && near && !this.aerialCamMode) {
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
    if (!this.localSeatId && !this.aerialCamMode) {
      let sx = 0;
      let sy = 0;
      if (this.keys.has("w") || this.keys.has("arrowup")) sy += 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) sy -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) sx += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) sx -= 1;
      sx += this.stickX;
      sy += this.stickY;
      const others = [...this.avatars.entries()]
        .filter(([id]) => id !== this.localId)
        .map(([, a]) => ({ x: a.root.position.x, z: a.root.position.z }));

      if (sx || sy) {
        const len = Math.hypot(sx, sy) || 1;
        sx /= len;
        sy /= len;
        const dx = (this.camForward.x * sy + this.camRight.x * sx) * MOVE_SPEED * dt;
        const dz = (this.camForward.z * sy + this.camRight.z * sx) * MOVE_SPEED * dt;
        if (this.noclip) {
          this.localX += dx;
          this.localZ += dz;
        } else {
          const n = resolveMove(this.localX, this.localZ, dx, dz, this.colliders, others);
          this.localX = n.x;
          this.localZ = n.z;
        }
        if (!this.firstPerson) this.localRot = Math.atan2(dx, dz);
        moved = true;
      } else {
        const n = resolveMove(this.localX, this.localZ, 0, 0, this.colliders, others);
        if (n.x !== this.localX || n.z !== this.localZ) {
          this.localX = n.x;
          this.localZ = n.z;
          moved = true;
        }
      }
    }

    const local = this.avatars.get(this.localId);
    if (local) {
      local.root.position.set(this.localX, this.seatY(this.localSeatId), this.localZ);
      local.root.rotation.y = this.localSeatId ? this.seatFacing(this.localSeatId) : this.localRot;
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
      this.tickSpeech(a, now, dt);
      if (a.micSprite.visible && now >= a.voiceUntil) {
        a.micSprite.visible = false;
        a.micFill = -1;
      }
      layoutHeadSprites(a, this.firstPerson ? this.fpCam : this.camera);
    }
    if (this.spectator) {
      for (const a of this.avatars.values()) {
        a.root.visible = false;
      }
    }

    const localHud = this.avatars.get(this.localId);
    if (localHud) setLocalFpPresentation(localHud, this.firstPerson, Boolean(this.localSeatId));

    const cam = this.camera;
    if (this.firstPerson) {
      this.poseFp();
    } else {
      const target = this.spectator ? new THREE.Vector3(0, 0.75, 0) : new THREE.Vector3(this.localX, 0.75, this.localZ);
      this.lookAt.lerp(target, Math.min(1, 6 * dt));
      this.isoCam.position.copy(this.lookAt).add(ISO);
      this.isoCam.lookAt(this.lookAt);
      this.isoCam.updateMatrixWorld();
    }
    this.updateSitPrompt(this.spectator ? null : (this.localSeatId ? null : this.nearestSeat()));
    this.renderer.render(this.scene, cam);

    if (this.spectator) return null;
    if (event) return event;
    this.moveAcc += dt;
    if (moved && this.moveAcc > 0.05) {
      this.moveAcc = 0;
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    if (this.lookDirty) {
      this.lookDirty = false;
      if (this.localSeatId) return null;
      return { type: "move", x: this.localX, z: this.localZ, rotY: this.localRot };
    }
    return null;
  }
}
