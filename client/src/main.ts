import "./styles.css";
import { hasLink, normalizeLook, randomLook, type Look } from "@klase/shared";
import { World } from "./game/world";
import { preloadAvatars } from "./game/avatar";
import { preloadClassroom } from "./game/classroom";
import { joinClassroom, pickRoom, type RemotePlayer } from "./net";
import { addChat, disposeLandingPreviews, renderGameShell, renderLanding, setChatOpen, setMicButton, setMuteAllButton, setViewButton, showCustomize, showPlayers, type ChatLine } from "./ui";
import { bindJoystick, isTouchUi } from "./joystick";
import { currentSession, loadSavedLook, signIn, signUp } from "./auth";
import { VoiceMesh } from "./voice";
import type { Room } from "colyseus.js";

const app = document.getElementById("app")!;
let joining = false;

function startLanding(err = "") {
  joining = false;
  renderLanding(
    app,
    (payload) => void enterWorld(payload.name, payload.look, payload.accessToken),
    (mode, email, password, name) => void accountJoin(mode, email, password, name),
    err,
  );
}

async function accountJoin(mode: "in" | "up", email: string, password: string, name: string) {
  try {
    if (mode === "up") await signUp(email, password, name);
    else await signIn(email, password);
    const session = await currentSession();
    const saved = await loadSavedLook();
    const stored = (() => {
      try {
        return normalizeLook(JSON.parse(localStorage.getItem("klase-look") ?? "null"));
      } catch {
        return normalizeLook(null);
      }
    })();
    const look = normalizeLook(saved?.look ?? stored);
    look.body = stored.body;
    await enterWorld(saved?.name || name, look, session?.access_token);
  } catch (e) {
    startLanding(e instanceof Error ? e.message : "Could not sign in.");
  }
}

async function enterWorld(name: string, look: Look, accessToken?: string) {
  if (joining) return;
  joining = true;
  disposeLandingPreviews();
  look = normalizeLook(look);
  const picked = await pickRoom(name, accessToken);
  if ("error" in picked) {
    const err =
      picked.error === "BANNED"
        ? "This account is banned."
        : picked.error === "ROOM_FULL"
          ? "All classrooms are full. Try again in a bit."
          : picked.error === "AUTH"
            ? "Sign-in expired. Try again."
            : picked.error === "SERVER"
              ? import.meta.env.PROD
                ? "Game server is not configured. Host Colyseus (Railway, Render, or Fly), set VITE_COLYSEUS_URL on Vercel, then redeploy."
                : "Could not reach the Klase server. Keep npm run dev running, then try again."
            : "Could not join right now. Try again.";
    startLanding(err);
    return;
  }

  let room: Room;
  try {
    room = await joinClassroom(picked.roomKey, name, look, accessToken);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("ROOM_FULL")) startLanding("All classrooms are full. Try again in a bit.");
    else if (msg.includes("BANNED")) startLanding("This name or account is banned.");
    else startLanding(
      import.meta.env.PROD
        ? "Could not join the game server. Check VITE_COLYSEUS_URL (wss://…) and that the Colyseus host is running."
        : "Could not join. Is the Klase server running?",
    );
    return;
  }

  const ui = renderGameShell(app);
  const selfId = room.sessionId;
  const muted = new Set<string>();
  let world: World | undefined;
  let voice: VoiceMesh | undefined;
  let leaveReason = "";
  let left = false;
  const CHAT_IDLE_MS = 5000;
  let chatIdle = 0;
  const typing = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
  };
  const chatOpen = () => !ui.chat.classList.contains("collapsed");
  const scheduleChatIdle = () => {
    window.clearTimeout(chatIdle);
    chatIdle = window.setTimeout(() => {
      if (document.activeElement === ui.input || ui.chat.classList.contains("composing")) {
        scheduleChatIdle();
        return;
      }
      setChatOpen(ui.chat, ui.chatBtn, ui.input, false);
    }, CHAT_IDLE_MS);
  };
  const revealChat = (focus = false) => {
    setChatOpen(ui.chat, ui.chatBtn, ui.input, true, focus);
    if (focus) window.clearTimeout(chatIdle);
    else scheduleChatIdle();
  };

  room.onMessage("chat", (line: ChatLine) => {
    const opened = addChat(ui.chat, ui.log, line, selfId, muted);
    if (opened) revealChat();
    if (line.kind === "chat" && !muted.has(line.from)) world?.showSpeech(line.from, line.text);
  });
  room.onMessage("chat-history", (lines: ChatLine[]) => {
    if (!Array.isArray(lines)) return;
    for (const line of lines) addChat(ui.chat, ui.log, line, selfId, muted, { silent: true });
  });
  room.send("need-history");
  room.onMessage("voice-level", (msg: { from?: string; level?: number }) => {
    const from = String(msg?.from ?? "");
    if (!from) return;
    world?.setVoiceLevel(from, Number(msg.level) || 0);
  });
  room.onMessage("dropped", (data: { reason?: string }) => {
    if (data?.reason === "idle") leaveReason = "idle";
  });
  let lastPoke = 0;
  const bumpActivity = () => {
    if (document.visibilityState !== "visible") return;
    const t = Date.now();
    if (t - lastPoke < 4000) return;
    lastPoke = t;
    room.send("poke");
  };
  window.addEventListener("mousemove", bumpActivity);
  window.addEventListener("keydown", bumpActivity);
  window.addEventListener("pointerdown", bumpActivity);
  room.onLeave((code) => {
    left = true;
    window.clearTimeout(chatIdle);
    window.removeEventListener("mousemove", bumpActivity);
    window.removeEventListener("keydown", bumpActivity);
    window.removeEventListener("pointerdown", bumpActivity);
    voice?.dispose();
    if (leaveReason === "idle" || code === 4002) {
      startLanding("You were disconnected for being idle (3 minutes).");
    } else if (code === 4000) {
      startLanding("You were removed from the classroom.");
    } else if (code === 4001) {
      startLanding("This account is banned.");
    } else {
      startLanding("You left the classroom.");
    }
  });

  const results = await Promise.allSettled([preloadAvatars(), preloadClassroom()]);
  for (const r of results) {
    if (r.status === "rejected") console.warn("Asset preload failed", r.reason);
  }
  if (left) return;
  world = new World(ui.canvas, selfId, name, look, {
    sitBtn: isTouchUi() ? ui.sitBtn : null,
    onFirstPersonChange: (on) => setViewButton(ui.viewBtn, on, isTouchUi()),
  });
  voice = new VoiceMesh(room, selfId);
  voice.localMuted = muted;
  const scene = world;
  const mesh = voice;
  const setMuteAll = (on: boolean) => {
    mesh.muteAll = on;
    setMuteAllButton(ui.muteAllBtn, on);
  };
  if (isTouchUi()) {
    bindJoystick(ui.joyBase, ui.joyKnob, (x, y) => scene.setStick(x, y));
    ui.sitBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      scene.interact();
    });
  }
  let currentLook = { ...look };
  let panelOpen: "look" | "players" | null = null;

  const snapshot = () => {
    const list: RemotePlayer[] = [];
    room.state.players.forEach((p: RemotePlayer, id: string) => {
      list.push({
        sessionId: id,
        name: p.name,
        role: p.role,
        x: p.x,
        y: p.y,
        z: p.z,
        rotY: p.rotY,
        hat: p.hat,
        top: p.top,
        accessory: p.accessory,
        body: p.body === "y" ? "y" : "x",
        serverMuted: p.serverMuted,
        seatId: p.seatId ?? "",
      });
    });
    return list;
  };

  const syncAvatars = () => {
    const seen = new Set<string>();
    const mutedIds: string[] = [];
    for (const p of snapshot()) {
      seen.add(p.sessionId);
      scene.upsert(
        p.sessionId,
        p.name,
        { hat: p.hat, top: p.top, accessory: p.accessory, body: p.body === "y" ? "y" : "x" },
        p.x,
        p.z,
        p.rotY,
        p.seatId ?? "",
      );
      if (p.serverMuted) mutedIds.push(p.sessionId);
    }
    mesh.setServerMuted(mutedIds);
    for (const id of scene.ids()) {
      if (!seen.has(id) && id !== selfId) scene.remove(id);
    }
    const me = snapshot().find((p) => p.sessionId === selfId);
    const n = snapshot().length;
    ui.roomChip.textContent = `${room.state.roomKey} · ${n} in room`;
    if (panelOpen === "players" && me) {
      showPlayers(
        ui.layer,
        snapshot(),
        selfId,
        me.role,
        muted,
        (id, mute) => {
          if (mute) muted.add(id);
          else muted.delete(id);
        },
        (action, targetId) => room.send("moderate", { action, targetId }),
        () => {
          panelOpen = null;
        },
        mesh.muteAll,
        setMuteAll,
      );
    }
  };

  room.state.players.onAdd((player: RemotePlayer & { onChange: (cb: () => void) => void }, id: string) => {
    player.onChange(() => syncAvatars());
    syncAvatars();
    void id;
  });
  room.state.players.onRemove(() => syncAvatars());
  room.onStateChange(() => syncAvatars());
  syncAvatars();

  const sendChat = () => {
    const text = ui.input.value.trim();
    if (!text) return;
    if (hasLink(text)) {
      addChat(
        ui.chat,
        ui.log,
        { from: selfId, name: "", text: "Sending links will get you banned.", kind: "system" },
        selfId,
        muted,
      );
      revealChat();
    }
    room.send("chat", { text });
    ui.input.value = "";
  };
  ui.send.addEventListener("click", sendChat);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  ui.input.addEventListener("focus", () => {
    ui.chat.classList.add("composing");
    window.clearTimeout(chatIdle);
  });
  ui.input.addEventListener("blur", () => {
    if (!ui.input.value.trim()) ui.chat.classList.remove("composing");
    if (chatOpen()) scheduleChatIdle();
  });
  ui.chatBtn.addEventListener("click", () => {
    if (chatOpen()) setChatOpen(ui.chat, ui.chatBtn, ui.input, false);
    else revealChat(true);
  });
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (typing(t)) return;
    if (e.key === "Enter") {
      revealChat(true);
      e.preventDefault();
      return;
    }
    if (e.key.toLowerCase() === "m" && !e.repeat) {
      e.preventDefault();
      if (chatOpen()) setChatOpen(ui.chat, ui.chatBtn, ui.input, false);
      else revealChat(true);
    }
  });

  ui.canvas.addEventListener("pointerdown", () => void mesh.unlock());
  ui.micBtn.addEventListener("click", async () => {
    ui.micBtn.setAttribute("disabled", "");
    try {
      await mesh.setMic(!mesh.micOn);
      setMicButton(ui.micBtn, mesh.micOn);
    } catch {
      setMicButton(ui.micBtn, false, "Microphone permission was denied");
    } finally {
      ui.micBtn.removeAttribute("disabled");
    }
  });
  ui.muteAllBtn.addEventListener("click", () => setMuteAll(!mesh.muteAll));
  ui.viewBtn.addEventListener("click", () => {
    scene.setFirstPerson(!scene.firstPerson);
    setViewButton(ui.viewBtn, scene.firstPerson, isTouchUi());
  });

  ui.lookBtn.addEventListener("click", () => {
    panelOpen = "look";
    showCustomize(
      ui.layer,
      currentLook,
      (next) => {
        currentLook = next;
        localStorage.setItem("klase-look", JSON.stringify(next));
        scene.applyLocalLook(next);
        room.send("customize", next);
      },
      () => {
        panelOpen = null;
      },
    );
  });

  ui.playersBtn.addEventListener("click", () => {
    const me = snapshot().find((p) => p.sessionId === selfId);
    panelOpen = "players";
    showPlayers(
      ui.layer,
      snapshot(),
      selfId,
      me?.role ?? "user",
      muted,
      (id, mute) => {
        if (mute) muted.add(id);
        else muted.delete(id);
      },
      (action, targetId) => room.send("moderate", { action, targetId }),
      () => {
        panelOpen = null;
      },
      mesh.muteAll,
      setMuteAll,
    );
  });

  let last = performance.now();
  const loop = (now: number) => {
    if (left) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const ev = scene.step(dt);
    if (ev?.type === "move") room.send("move", { x: ev.x, z: ev.z, rotY: ev.rotY });
    if (ev?.type === "sit") room.send("sit", { seatId: ev.seatId });
    if (ev?.type === "stand") {
      room.send("stand");
      room.send("move", { x: scene.localX, z: scene.localZ, rotY: scene.localRot });
    }
    const me = snapshot().find((p) => p.sessionId === selfId);
    mesh.tick(scene.positions(), Boolean(me?.serverMuted));
    scene.setVoiceLevel(selfId, mesh.localLevel);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if (!localStorage.getItem("klase-look")) {
  localStorage.setItem("klase-look", JSON.stringify(randomLook()));
} else {
  try {
    localStorage.setItem(
      "klase-look",
      JSON.stringify(normalizeLook(JSON.parse(localStorage.getItem("klase-look") ?? "null"))),
    );
  } catch {
    localStorage.setItem("klase-look", JSON.stringify(randomLook()));
  }
}

startLanding();
