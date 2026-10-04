import "./styles.css";
import { ROOM_CODES, hasLink, normalizeLook, randomLook, type Look } from "@klase/shared";
import { World } from "./game/world";
import { preloadAvatars } from "./game/avatar";
import { preloadClassroom } from "./game/classroom";
import { joinClassroom, pickRoom, type RemotePlayer } from "./net";
import { addChat, disposeLandingPreviews, renderGameShell, renderJoining, renderLanding, renderOnboarding, renderStaffBar, setChatOpen, setFreeCamButton, setGameHudVisible, setMicButton, setMuteAllButton, setViewButton, setZoomHud, showCustomize, showPlayers, type ChatLine } from "./ui";
import { parseHeld, renderModerationNotice } from "./moderation";
import { bindJoystick, isTouchUi } from "./joystick";
import { AUTH_CALLBACK_PATH, completeOAuthCallback, currentSession, loadSavedLook, loadStaffIdentity, signIn, signInWithGoogle, signUp } from "./auth";
import { VoiceMesh } from "./voice";
import type { Room } from "colyseus.js";

const app = document.getElementById("app")!;
// Create a dedicated overlay container so we can layer UI over the live game canvas
const overlayRoot = document.createElement("div");
overlayRoot.style.position = "absolute";
overlayRoot.style.inset = "0";
overlayRoot.style.zIndex = "100";
let joining = false;
let globalRoom: Room | null = null;
let globalWorld: World | null = null;
let globalVoice: VoiceMesh | null = null;
let globalUi: ReturnType<typeof renderGameShell> | null = null;

function showOnboarding() {
  joining = false;
  renderOnboarding(overlayRoot, () => {
    startLanding("", "play");
  });
}

function startLanding(err = "", startAt?: "menu" | "play" | "account", retry?: () => void) {
  joining = false;
  // If there's an active game world, show the landing over it; otherwise replace the full app
  const landingRoot = globalWorld ? overlayRoot : app;
  overlayRoot.style.display = globalWorld ? "block" : "none";
  if (globalWorld && !overlayRoot.parentElement) app.append(overlayRoot);
  renderLanding(
    landingRoot,
    (payload) => void finalizeJoin(payload.name, payload.look),
    (mode, email, password, name) => void accountJoin(mode, email, password, name),
    err,
    startAt ?? "play",
    () => {
      showOnboarding();
    },
    () => signInWithGoogle("/"),
    retry,
  );
}

async function accountJoin(mode: "in" | "up", email: string, password: string, name: string) {
  try {
    if (mode === "up") await signUp(email, password, name);
    else await signIn(email, password);
    await joinWithSession(name);
  } catch (e) {
    startLanding(e instanceof Error ? e.message : "Could not sign in.");
  }
}

/** Join the game as the currently signed-in account (email sign-in and Google both end up here). */
async function joinWithSession(fallbackName: string) {
  try {
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
    await finalizeJoin(saved?.name || fallbackName, look);
  } catch (e) {
    startLanding(e instanceof Error ? e.message : "Could not sign in.");
  }
}

async function finalizeJoin(name: string, look: Look) {
  if (joining) return;
  const session = await currentSession();
  await bootWorld(name, look, session?.access_token, false);
}

type StaffJoin = { roomKey: string; mode: "owner" | "admin" | "observe" };

function staffRoomUrl(roomKey: string, mode: string) {
  return `/room/${roomKey}?mode=${mode}`;
}

function showHeld(notice: import("@klase/shared").ModerationNotice) {
  joining = false;
  renderModerationNotice(app, notice, () => startLanding("", "play"));
}

/**
 * `staff`: dashboard or /room/... join. Observe is the silent invisible camera.
 * Enter-room is a normal playable body. The server still checks the token for role.
 */
async function bootWorld(name: string, look: Look, accessToken?: string, isPregame = false, staff?: StaffJoin) {
  if (joining) return;
  joining = true;
  disposeLandingPreviews();
  look = normalizeLook(look);
  
  // Use overlayRoot for joining UI if it's not pregame
  const loader = renderJoining(isPregame ? app : overlayRoot);
  if (!isPregame && !overlayRoot.parentElement) app.append(overlayRoot);
  const fail = (err: string, retryable = false) => {
    loader.dispose();
    if (staff) {
      window.alert(err);
      window.location.replace("/admin");
      return;
    }
    startLanding(err, "play", retryable ? () => void bootWorld(name, look, accessToken, false) : undefined);
  };
  loader.setStage("find");
  const picked = staff
    ? { roomKey: staff.roomKey }
    : await pickRoom(name, accessToken, () => loader.setStage("wake"));
  if ("error" in picked) {
    if (picked.error === "HELD" && picked.notice) {
      loader.dispose();
      showHeld(picked.notice);
      return;
    }
    const err =
      picked.error === "BANNED"
        ? "This account is banned."
        : picked.error === "NAME_RESERVED"
          ? "That name belongs to a Klase admin. Pick a different name."
          : picked.error === "BAD_NAME"
          ? "That name isn't allowed."
          : picked.error === "ROOM_FULL"
          ? "All classrooms are full. Try again in a bit."
          : picked.error === "AUTH"
            ? "Sign-in expired. Try again."
            : picked.error === "NOT_CONFIGURED"
              ? "Game server is not configured. Host Colyseus (Railway, Render, or Fly), set VITE_COLYSEUS_URL on Vercel, then redeploy."
              : picked.error === "UNREACHABLE"
                ? "The classroom server could not be reached. It may be waking up — try again in a moment."
                : picked.error === "SERVER_ERROR"
                  ? `The classroom server hit an unexpected error${picked.status ? ` (${picked.status})` : ""}. Check the server logs for [find-room].`
            : "Could not join right now. Try again.";
    fail(err, picked.error === "UNREACHABLE" || picked.error === "SERVER_ERROR");
    return;
  }

  let room: Room;
  try {
    loader.setStage("join");
    room = await joinClassroom(picked.roomKey, name, look, accessToken, staff?.mode === "observe", Boolean(staff));
  } catch (e) {
    const msg = String(e);
    if (msg.includes("ROOM_FULL")) fail("All classrooms are full. Try again in a bit.");
    else if (msg.includes("BANNED")) fail("This name or account is banned.");
    else if (msg.includes("HELD") || msg.includes("\"notice\"")) {
      const n = parseHeld(msg);
      if (n) {
        loader.dispose();
        showHeld(n);
        return;
      }
      fail("You cannot rejoin yet.");
    }
    else if (msg.includes("NAME_RESERVED")) fail("That name belongs to a Klase admin. Pick a different name.");
    else if (msg.includes("BAD_NAME")) fail("That name isn't allowed.");
    else if (msg.includes("NO_PERMISSION")) fail("You don't have permission to do that.");
    else if (msg.includes("NOT_CONFIGURED")) {
      fail("Game server is not configured. Host Colyseus (Railway, Render, or Fly), set VITE_COLYSEUS_URL on Vercel, then redeploy.");
    } else {
      fail(
        import.meta.env.PROD
          ? "Could not join the game server. It may be waking up — try again in a moment."
          : "Could not join. Is the Klase server running?",
        true,
      );
    }
    return;
  }

  const selfId = room.sessionId;
  const muted = new Set<string>();
  let world: World | undefined;
  let voice: VoiceMesh | undefined;
  let leaveReason = "";
  let pendingNotice: import("@klase/shared").ModerationNotice | null = null;
  let left = false;
  const CHAT_IDLE_MS = 5000;
  let chatIdle = 0;
  let lastPoke = 0;
  const bumpActivity = () => {
    if (document.visibilityState !== "visible") return;
    const t = Date.now();
    if (t - lastPoke < 4000) return;
    lastPoke = t;
    room.send("poke");
  };
  room.onLeave((code) => {
    left = true;
    loader.dispose();
    window.clearTimeout(chatIdle);
    window.removeEventListener("mousemove", bumpActivity);
    window.removeEventListener("keydown", bumpActivity);
    window.removeEventListener("pointerdown", bumpActivity);
    voice?.dispose();
    if (pendingNotice) {
      showHeld(pendingNotice);
      return;
    }
    if (staff) {
      window.location.replace("/admin");
      return;
    }
    if (leaveReason === "idle" || code === 4002) {
      startLanding("You were disconnected for being idle.");
    } else if (code === 4000) {
      startLanding(leaveReason || "You were removed from the classroom.");
    } else if (code === 4001) {
      startLanding("This account is banned.");
    } else {
      startLanding("You left the classroom.");
    }
  });

  loader.setStage("load");
  const results = await Promise.allSettled([preloadAvatars(), preloadClassroom()]);
  for (const r of results) {
    if (r.status === "rejected") console.warn("Asset preload failed", r.reason);
  }
  if (left) return;
  loader.setStage("ready");
  await new Promise((r) => window.setTimeout(r, 280));
  if (left) return;
  loader.dispose();

  const ui = renderGameShell(app);
  setGameHudVisible(ui, !isPregame);
  if (isPregame) {
    app.append(overlayRoot);
  } else {
    overlayRoot.style.display = "none";
  }
  
  globalUi = ui;
  globalRoom = room;
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
  room.onMessage("moderation-notice", (data: import("@klase/shared").ModerationNotice) => {
    if (data?.kind) pendingNotice = data;
  });
  window.addEventListener("mousemove", bumpActivity);
  window.addEventListener("keydown", bumpActivity);
  window.addEventListener("pointerdown", bumpActivity);
  if (left) return;
  let iAmOwner = false;
  let iAmStaff = false;
  let observeCamApplied = false;
  let staffBar: ReturnType<typeof renderStaffBar> | null = null;
  const showHudFreeCam = () => (iAmOwner || iAmStaff) && staff?.mode !== "observe";
  world = new World(ui.canvas, selfId, name, look, {
    sitBtn: isTouchUi() ? ui.sitBtn : null,
    onFirstPersonChange: (on) => {
      setViewButton(ui.viewBtn, on, isTouchUi());
      setZoomHud(ui.zoomWrap, ui.zoomPanel, ui.zoomBtn, !on);
    },
    onFreeCamChange: (on) => {
      setFreeCamButton(ui.freeCamBtn, on, showHudFreeCam());
    },
  });
  voice = new VoiceMesh(room, selfId);
  voice.localMuted = muted;
  globalVoice = voice;
  
  const scene = world;
  const mesh = voice;
  globalWorld = world;

  const leaveToAdmin = () => {
    try {
      room.leave();
    } catch {
      /* already closed */
    }
    window.location.assign("/admin");
  };

  const mountStaffBar = (role: string) => {
    if (staffBar) return;
    const observe = staff?.mode === "observe";
    if (observe) {
      world.setGodMode(true);
      ui.viewBtn.hidden = true;
    }
    staffBar = renderStaffBar(app, {
      roomLabel: String(room.state.roomKey || staff?.roomKey || "").replace("klase-", "Classroom "),
      role,
      observe,
      actorName: name,
      onBack: leaveToAdmin,
      listPlayers: () => snapshot(),
      selfId,
      onSubmit: (payload) => room.send("moderate", payload),
      onNoclip: () => {
        const next = !scene.noclip;
        scene.setNoclip(next);
        room.send("noclip", { on: next });
        staffBar?.setNoclip(next);
      },
    });
  };
  
  if (isPregame) {
    world.setSpectatorMode(true);
    mesh.muteAll = true; // Mute until joined
  }
  
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
      // Observe mode has no body. Noclip stays in state so proximity voice still has a position.
      if (p.observer && id !== selfId) return;
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
        observer: p.observer,
        noclip: p.noclip,
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
        p.role ?? "",
        Boolean(p.noclip),
      );
      if (p.serverMuted) mutedIds.push(p.sessionId);
    }
    mesh.setServerMuted(mutedIds);
    for (const id of scene.ids()) {
      if (!seen.has(id) && id !== selfId) scene.remove(id);
    }
    const me = snapshot().find((p) => p.sessionId === selfId);
    const n = snapshot().length;
    iAmOwner = me?.role === "owner";
    iAmStaff = me?.role === "owner" || me?.role === "admin";
    ui.roomChip.textContent = staff?.mode === "observe"
      ? `${room.state.roomKey} · ${Math.max(0, n - 1)} players · observing`
      : `${room.state.roomKey} · ${n} in room`;
    scene.setOwnerTools(iAmStaff);
    if (iAmStaff) {
      mountStaffBar(me?.role || "admin");
      const mode = staff?.mode === "observe" ? "observe" : me?.role === "owner" ? "owner" : "admin";
      const next = staffRoomUrl(String(room.state.roomKey), mode);
      if (`${window.location.pathname}${window.location.search}` !== next) {
        window.history.replaceState({}, "", next);
      }
    }
    if (staff?.mode === "observe" && iAmOwner && !observeCamApplied) {
      observeCamApplied = true;
      scene.setFreeCam(true);
    }
    setFreeCamButton(ui.freeCamBtn, scene.freeCam, showHudFreeCam());
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
    if (scene.freeCam) scene.setFreeCam(false);
    else scene.setFirstPerson(!scene.firstPerson);
    setViewButton(ui.viewBtn, scene.firstPerson, isTouchUi());
  });
  ui.freeCamBtn.addEventListener("click", () => {
    scene.setFreeCam(!scene.freeCam);
  });
  const applyIsoZoom = () => {
    const raw = 1 - Number(ui.zoomSlider.value) / 100;
    const t = Math.abs(raw - 0.5) <= 0.06 ? 0.5 : raw;
    if (t === 0.5) ui.zoomSlider.value = "50";
    scene.setIsoZoom(t);
  };
  ui.zoomBtn.addEventListener("click", () => {
    if (scene.firstPerson) return;
    const open = ui.zoomPanel.hidden;
    ui.zoomPanel.hidden = !open;
    ui.zoomBtn.setAttribute("aria-expanded", open ? "true" : "false");
    ui.zoomBtn.classList.toggle("primary", open);
  });
  ui.zoomSlider.addEventListener("input", applyIsoZoom);
  ui.zoomSlider.addEventListener("change", applyIsoZoom);

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
  
  if (isPregame) {
    joining = false;
    showOnboarding();
  }
}

async function startApp() {
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

  const loader = renderJoining(app);
  loader.setStage("find");
  
  const saved = await loadSavedLook();
  const stored = normalizeLook(JSON.parse(localStorage.getItem("klase-look") ?? "null"));
  const look = normalizeLook(saved?.look ?? stored);
  
  loader.setStage("load");
  await preloadClassroom();
  
  const ui = renderGameShell(app);
  setGameHudVisible(ui, false);
  app.append(overlayRoot);
  
  const world = new World(ui.canvas, "", saved?.name || localStorage.getItem("klase-name") || "Guest", look);
  world.setSpectatorMode(true);
  globalWorld = world;
  globalUi = ui;
  
  let last = performance.now();
  const spectatorLoop = (now: number) => {
    if (globalRoom) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    world.step(dt);
    requestAnimationFrame(spectatorLoop);
  };
  requestAnimationFrame(spectatorLoop);
  
  loader.setStage("ready");
  await new Promise((r) => window.setTimeout(r, 280));
  loader.dispose();
  
  showOnboarding();
}

/**
 * Tiny path router (Vercel rewrites every path to index.html).
 *   /auth/callback  Google OAuth return: finish the session, then continue to `next`
 *   /admin          admin dashboard (the server decides who may use it)
 *   /room/klase-N?mode=owner|admin|observe  staff join
 *   anything else   the game
 */
async function route() {
  let callbackError = "";
  let cameFromOAuth = false;
  if (window.location.pathname.replace(/\/+$/, "") === AUTH_CALLBACK_PATH) {
    const result = await completeOAuthCallback();
    callbackError = result.error;
    cameFromOAuth = !result.error;
  }

  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  if (path === "/admin") {
    document.body.classList.add("admin-route");
    const { renderAdmin } = await import("./admin");
    await renderAdmin(app);
    return;
  }

  const roomMatch = path.match(/^\/room\/(klase-[123])$/);
  const params = new URLSearchParams(window.location.search);
  const legacyGod = params.get("god") ?? "";
  const staffKey = roomMatch?.[1] ?? ((ROOM_CODES as readonly string[]).includes(legacyGod) ? legacyGod : "");
  const staffMode = (params.get("mode") === "observe" || legacyGod
    ? "observe"
    : params.get("mode") === "admin"
      ? "admin"
      : "owner") as StaffJoin["mode"];
  if (staffKey) {
    const session = await currentSession();
    if (!session) {
      window.location.replace("/admin");
      return;
    }
    const identity = await loadStaffIdentity();
    await bootWorld(identity.name, identity.look, session.access_token, false, { roomKey: staffKey, mode: staffMode });
    return;
  }

  if (callbackError) {
    await startApp();
    startLanding(callbackError, "account");
    return;
  }

  // Came back from Google with a session: go straight into the game like email sign-in does.
  if (cameFromOAuth && path === "/") {
    await joinWithSession("Student");
    return;
  }

  await startApp();
}

void route();