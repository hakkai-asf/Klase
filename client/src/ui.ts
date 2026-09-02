import { BODY_LABELS, BODIES, CHAT_LOG_MAX, WEARABLE_LABELS, WEARABLES, normalizeLook, type BodyId, type Look, type WearableSlot } from "@klase/shared";
import type { RemotePlayer } from "./net";
import { authEnabled } from "./auth";
import { paintBodyPortrait, preloadAvatars } from "./game/avatar";
import { isTouchUi } from "./joystick";

export type ChatLine = {
  from: string;
  name: string;
  text: string;
  kind: string;
};

export type JoinPayload = { name: string; look: Look; accessToken?: string };
export type JoinStage = "find" | "join" | "load" | "ready";

const JOIN_STAGE: Record<JoinStage, { cap: number; tau: number; copy: string[] }> = {
  find: {
    cap: 0.4,
    tau: 14,
    copy: [
      "Connecting you to a classroom…",
      "Waking the server — first join can take a minute.",
      "Finding you a room…",
    ],
  },
  join: {
    cap: 0.65,
    tau: 5,
    copy: ["Joining your classroom…", "Almost there…"],
  },
  load: {
    cap: 0.95,
    tau: 8,
    copy: ["Loading the classroom…", "Setting up desks and characters…"],
  },
  ready: {
    cap: 1,
    tau: 0.35,
    copy: ["You're in."],
  },
};

export function renderJoining(root: HTMLElement) {
  disposeLandingPreviews();
  root.innerHTML = "";
  const wrap = el("div", "landing");
  const card = el("div", "clay landing-card joining-card");
  const title = el("h1", "", "Klase");
  const status = el("p", "lede joining-status", JOIN_STAGE.find.copy[0]!);
  const dots = el("div", "joining-dots");
  dots.innerHTML = "<span></span><span></span><span></span>";
  const track = el("div", "joining-track");
  const fill = el("div", "joining-fill");
  track.append(fill);
  card.append(title, status, dots, track);
  wrap.append(card);
  root.append(wrap);

  let stage: JoinStage = "find";
  let floor = 0;
  let shown = 0;
  let stageAt = performance.now();
  let copyI = 1;
  let alive = true;
  let raf = 0;
  const copyTimer = window.setInterval(() => {
    if (!alive) return;
    const lines = JOIN_STAGE[stage].copy;
    status.textContent = lines[copyI % lines.length]!;
    copyI += 1;
  }, 3200);

  const tick = (now: number) => {
    if (!alive) return;
    const spec = JOIN_STAGE[stage];
    const t = (now - stageAt) / 1000;
    const creep = floor + (spec.cap - floor) * (1 - Math.exp(-t / spec.tau));
    shown = stage === "ready" ? 1 : Math.max(shown, Math.min(spec.cap - 0.004, creep));
    fill.style.width = `${Math.round(shown * 1000) / 10}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    setStage(next: JoinStage) {
      if (!alive) return;
      floor = shown;
      stage = next;
      stageAt = performance.now();
      copyI = 1;
      status.textContent = JOIN_STAGE[next].copy[0]!;
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearInterval(copyTimer);
    },
  };
}

let chooserDispose: (() => void) | null = null;

export function disposeLandingPreviews() {
  chooserDispose?.();
  chooserDispose = null;
}

function storedLook(): Look {
  try {
    return normalizeLook(JSON.parse(localStorage.getItem("klase-look") ?? "null"));
  } catch {
    return normalizeLook(null);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

const MIC_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;
const MIC_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`;

export function setMicButton(btn: HTMLElement, on: boolean, error = "") {
  btn.classList.toggle("primary", on);
  btn.classList.toggle("mic-on", on);
  btn.classList.toggle("warn", Boolean(error));
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = error || (on ? "Microphone on" : "Microphone off");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = on ? MIC_ON : MIC_OFF;
}

const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`;

export function setMuteAllButton(btn: HTMLElement, muted: boolean) {
  btn.classList.toggle("primary", muted);
  btn.classList.toggle("warn", muted);
  btn.setAttribute("aria-pressed", muted ? "true" : "false");
  const label = muted ? "Unmute all" : "Mute all";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = muted ? SPEAKER_OFF : SPEAKER_ON;
}

export function setViewButton(btn: HTMLElement, firstPerson: boolean, compact = false) {
  btn.textContent = firstPerson ? (compact ? "Iso" : "Classroom") : compact ? "1st" : "1st person";
  btn.title = firstPerson ? "Classroom view" : "First person";
  btn.setAttribute("aria-pressed", firstPerson ? "true" : "false");
  btn.classList.toggle("primary", firstPerson);
}

export function renderLanding(
  root: HTMLElement,
  onJoin: (payload: JoinPayload) => void,
  onAccount: (mode: "in" | "up", email: string, password: string, name: string) => void,
  initialError = "",
) {
  disposeLandingPreviews();
  root.innerHTML = "";
  const wrap = el("div", "landing");
  const card = el("div", "clay landing-card");
  card.innerHTML = `
    <h1>Klase</h1>
    <p class="lede">Walk a shared classroom. Chat with people near you.</p>
  `;
  card.append(el("label", "", "Character"));
  const pick = el("div", "char-pick");
  const look = storedLook();
  let body: BodyId = look.body;
  const portraits = new Map<BodyId, HTMLImageElement>();
  for (const id of BODIES) {
    const btn = el("button", `char-card char-${id}${body === id ? " on" : ""}`) as HTMLButtonElement;
    btn.type = "button";
    const frame = el("div", "char-frame");
    const img = el("img") as HTMLImageElement;
    img.alt = BODY_LABELS[id];
    frame.append(img);
    const caption = el("span", "", BODY_LABELS[id]);
    btn.append(frame, caption);
    btn.addEventListener("click", () => {
      body = id;
      look.body = id;
      localStorage.setItem("klase-look", JSON.stringify(look));
      pick.querySelectorAll(".char-card").forEach((n) => n.classList.remove("on"));
      btn.classList.add("on");
    });
    pick.append(btn);
    portraits.set(id, img);
  }
  card.append(pick);
  card.append(el("label", "", "Display name"));
  const name = el("input", "clay-input") as HTMLInputElement;
  name.id = "name";
  name.maxLength = 24;
  name.placeholder = "Guest";
  name.value = localStorage.getItem("klase-name") ?? "";
  const err = el("div", initialError ? "error-banner" : "error-banner hidden", initialError);
  const actions = el("div", "landing-actions");
  const go = el("button", "clay-btn primary", "Join as guest");
  const lockJoin = (btn: HTMLButtonElement) => {
    if (btn.disabled) return false;
    btn.disabled = true;
    return true;
  };
  go.addEventListener("click", () => {
    if (!lockJoin(go)) return;
    card.querySelectorAll("button").forEach((b) => {
      (b as HTMLButtonElement).disabled = true;
    });
    go.textContent = "Joining…";
    const n = name.value.trim() || "Guest";
    localStorage.setItem("klase-name", n);
    const next = { ...storedLook(), body };
    localStorage.setItem("klase-look", JSON.stringify(next));
    onJoin({ name: n, look: next });
  });
  actions.append(go);
  card.append(name, err, actions);

  if (authEnabled()) {
    card.append(el("label", "", "Email"));
    const email = el("input", "clay-input") as HTMLInputElement;
    email.type = "email";
    email.autocomplete = "email";
    card.append(email);
    card.append(el("label", "", "Password"));
    const pass = el("input", "clay-input") as HTMLInputElement;
    pass.type = "password";
    pass.autocomplete = "current-password";
    card.append(pass);
    const acct = el("div", "landing-actions");
    const signIn = el("button", "clay-btn", "Sign in");
    const signUp = el("button", "clay-btn", "Create account");
    signIn.addEventListener("click", () => {
      if (!lockJoin(signIn)) return;
      signIn.textContent = "Joining…";
      signUp.disabled = true;
      go.disabled = true;
      onAccount("in", email.value.trim(), pass.value, name.value.trim() || "Student");
    });
    signUp.addEventListener("click", () => {
      if (!lockJoin(signUp)) return;
      signUp.textContent = "Joining…";
      signIn.disabled = true;
      go.disabled = true;
      onAccount("up", email.value.trim(), pass.value, name.value.trim() || "Student");
    });
    acct.append(signIn, signUp);
    card.append(acct);
  }

  wrap.append(card);
  root.append(wrap);

  void preloadAvatars()
    .then(() => {
      if (!wrap.isConnected) return;
      const stops = BODIES.map((id) => paintBodyPortrait(portraits.get(id)!, id));
      chooserDispose = () => {
        for (const stop of stops) stop();
      };
    })
    .catch((e) => console.warn("Character preview failed", e));
}

export function renderGameShell(root: HTMLElement) {
  root.innerHTML = "";
  const shell = el("div", isTouchUi() ? "game-root touch-ui" : "game-root");
  const canvas = document.createElement("canvas");
  const top = el("div", "hud-top");
  const roomChip = el("div", "hud-chip", "Connecting…");
  const actions = el("div", "hud-actions");
  const micBtn = el("button", "clay-btn mic-btn");
  micBtn.type = "button";
  setMicButton(micBtn, false);
  const muteAllBtn = el("button", "clay-btn icon-btn");
  muteAllBtn.type = "button";
  setMuteAllButton(muteAllBtn, false);
  const viewBtn = el("button", "clay-btn");
  viewBtn.type = "button";
  setViewButton(viewBtn, false, isTouchUi());
  const playersBtn = el("button", "clay-btn", "Players");
  const lookBtn = el("button", "clay-btn", "Look");
  const chatBtn = el("button", "clay-btn", "Chat");
  actions.append(micBtn, muteAllBtn, chatBtn, playersBtn, lookBtn, viewBtn);
  top.append(roomChip, actions);

  const chat = el("div", "chat-dock game-chat empty collapsed");
  const log = el("div", "chat-log");
  const row = el("div", "chat-row");
  const input = el("input", "chat-input") as HTMLInputElement;
  input.placeholder = "Enter to chat";
  const send = el("button", "chat-send", "Send");
  row.append(input, send);
  chat.append(log, row);

  const layer = el("div", "panel-layer hidden");

  const joyWrap = el("div", "joy-wrap");
  const joyBase = el("div", "joy-base");
  const joyKnob = el("div", "joy-knob");
  joyBase.append(joyKnob);
  const sitBtn = el("button", "joy-sit clay-btn", "Sit") as HTMLButtonElement;
  sitBtn.type = "button";
  sitBtn.hidden = true;
  joyWrap.append(joyBase, sitBtn);

  shell.append(canvas, top, chat, joyWrap, layer);
  root.append(shell);
  return {
    canvas,
    roomChip,
    micBtn,
    muteAllBtn,
    chatBtn,
    chat,
    playersBtn,
    lookBtn,
    viewBtn,
    log,
    input,
    send,
    layer,
    joyWrap,
    joyBase,
    joyKnob,
    sitBtn,
  };
}

export function setChatOpen(
  chat: HTMLElement,
  chatBtn: HTMLElement,
  input: HTMLInputElement,
  open: boolean,
  focus = false,
) {
  chat.classList.toggle("collapsed", !open);
  chatBtn.classList.toggle("primary", open);
  if (open) {
    if (focus) {
      chat.classList.add("composing");
      input.focus();
    }
  } else {
    chat.classList.remove("composing");
    input.blur();
  }
}

export function syncChatVisibility(chat: HTMLElement, log: HTMLElement) {
  chat.classList.toggle("empty", log.childElementCount === 0);
}

export function addChat(
  chat: HTMLElement,
  log: HTMLElement,
  line: ChatLine,
  selfId: string,
  muted: Set<string>,
  opts?: { silent?: boolean },
) {
  if (line.kind === "chat" && muted.has(line.from)) return false;
  const b = el("div", "bubble");
  if (line.from === selfId) b.classList.add("mine");
  if (line.kind === "join-owner" || line.kind === "join" || line.kind === "leave" || line.kind === "leave-owner" || line.kind === "system") b.classList.add("system");
  if (line.kind === "join-admin" || line.kind === "leave-admin") b.classList.add("admin");
  if (line.kind === "chat") {
    const who = el("strong", "", line.name);
    b.append(who, document.createTextNode(line.text));
  } else {
    b.textContent = line.text;
  }
  log.append(b);
  while (log.childElementCount > CHAT_LOG_MAX) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  syncChatVisibility(chat, log);
  return !opts?.silent && line.kind === "chat";
}

export function showCustomize(
  layer: HTMLElement,
  look: Look,
  onChange: (next: Look) => void,
  onClose: () => void,
) {
  layer.classList.remove("hidden");
  layer.innerHTML = "";
  const panel = el("div", "clay panel");
  const head = el("div", "panel-head");
  head.append(el("h2", "", "Avatar"), el("button", "clay-btn", "Done"));
  head.querySelector("button")!.addEventListener("click", () => {
    layer.classList.add("hidden");
    onClose();
  });
  panel.append(head, el("p", "lede", "Primitive wearables on a blank body. The 3D preview stays in the classroom."));
  const draft = { ...look };
  (Object.keys(WEARABLES) as WearableSlot[]).forEach((slot) => {
    panel.append(el("label", "", slot));
    const grid = el("div", "wear-grid");
    for (const id of WEARABLES[slot]) {
      const tile = el("button", `clay-btn wear-tile${draft[slot] === id ? " on" : ""}`, WEARABLE_LABELS[id] ?? id);
      tile.addEventListener("click", () => {
        draft[slot] = id;
        onChange({ ...draft });
        showCustomize(layer, draft, onChange, onClose);
      });
      grid.append(tile);
    }
    panel.append(grid);
  });
  layer.append(panel);
}

export function showPlayers(
  layer: HTMLElement,
  players: RemotePlayer[],
  selfId: string,
  role: string,
  muted: Set<string>,
  onMuteLocal: (id: string, mute: boolean) => void,
  onModerate: (action: string, targetId: string) => void,
  onClose: () => void,
  muteAll = false,
  onMuteAll: (on: boolean) => void = () => {},
) {
  layer.classList.remove("hidden");
  layer.innerHTML = "";
  const panel = el("div", "clay panel");
  const head = el("div", "panel-head");
  head.append(el("h2", "", "Players"), el("button", "clay-btn", "Close"));
  head.querySelector("button")!.addEventListener("click", () => {
    layer.classList.add("hidden");
    onClose();
  });
  panel.append(head);
  const allBtn = el("button", muteAll ? "clay-btn warn" : "clay-btn", muteAll ? "Unmute all" : "Mute all");
  allBtn.addEventListener("click", () => {
    onMuteAll(!muteAll);
    showPlayers(layer, players, selfId, role, muted, onMuteLocal, onModerate, onClose, !muteAll, onMuteAll);
  });
  panel.append(allBtn);

  const refresh = () =>
    showPlayers(layer, players, selfId, role, muted, onMuteLocal, onModerate, onClose, muteAll, onMuteAll);

  for (const p of players) {
    const row = el("div", "player-row");
    const left = el("div");
    left.append(document.createTextNode(p.name));
    if (p.role !== "user") {
      left.append(el("span", `badge ${p.role}`, p.role));
    }
    if (p.serverMuted) left.append(el("span", "badge", "muted"));
    const mods = el("div", "mods");
    if (p.sessionId !== selfId) {
      const localMuted = muted.has(p.sessionId);
      const lm = el("button", "clay-btn", localMuted ? "Unmute local" : "Mute local");
      lm.addEventListener("click", () => {
        onMuteLocal(p.sessionId, !localMuted);
        refresh();
      });
      mods.append(lm);
      if (role === "owner" || role === "admin") {
        const add = (label: string, action: string, warn = false) => {
          const b = el("button", warn ? "clay-btn warn" : "clay-btn", label);
          b.addEventListener("click", () => onModerate(action, p.sessionId));
          mods.append(b);
        };
        add(p.serverMuted ? "Unmute" : "Mute", p.serverMuted ? "unmute" : "mute");
        add("Kick", "kick", true);
        add("Ban", "ban", true);
        if (role === "owner" && p.role !== "owner") {
          add(p.role === "admin" ? "Demote" : "Promote", p.role === "admin" ? "demote" : "promote");
        }
      }
    }
    row.append(left, mods);
    panel.append(row);
  }
  layer.append(panel);
}
