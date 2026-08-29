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
  const playersBtn = el("button", "clay-btn", "Players");
  const lookBtn = el("button", "clay-btn", "Look");
  const chatBtn = el("button", "clay-btn", "Chat");
  actions.append(micBtn, chatBtn, playersBtn, lookBtn);
  top.append(roomChip, actions);

  const chat = el("div", "chat-dock game-chat empty");
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
    chatBtn,
    chat,
    playersBtn,
    lookBtn,
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

export function syncChatVisibility(chat: HTMLElement, log: HTMLElement) {
  chat.classList.toggle("empty", log.childElementCount === 0);
}

export function addChat(
  chat: HTMLElement,
  log: HTMLElement,
  line: ChatLine,
  selfId: string,
  muted: Set<string>,
) {
  if (line.kind === "chat" && muted.has(line.from)) return;
  const b = el("div", "bubble");
  if (line.from === selfId) b.classList.add("mine");
  if (line.kind === "join-owner" || line.kind === "join" || line.kind === "system") b.classList.add("system");
  if (line.kind === "join-admin") b.classList.add("admin");
  if (line.kind === "chat") {
    const who = el("strong", "", line.name);
    b.append(who, document.createTextNode(line.text));
  } else {
    b.textContent = line.text;
  }
  log.append(b);
  while (log.childElementCount > CHAT_LOG_MAX) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  chat.classList.remove("collapsed");
  syncChatVisibility(chat, log);
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
        showPlayers(layer, players, selfId, role, muted, onMuteLocal, onModerate, onClose);
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
