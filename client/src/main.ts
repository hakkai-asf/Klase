import "./styles.css";
import { normalizeLook, randomLook, type Look } from "@klase/shared";
import { World } from "./game/world";
import { preloadAvatars } from "./game/avatar";
import { joinClassroom, pickRoom, type RemotePlayer } from "./net";
import { addChat, disposeLandingPreviews, renderGameShell, renderLanding, showCustomize, showPlayers, type ChatLine } from "./ui";
import { currentSession, loadSavedLook, signIn, signUp } from "./auth";
import { VoiceMesh } from "./voice";
import type { Room } from "colyseus.js";

const app = document.getElementById("app")!;

function startLanding(err = "") {
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
              ? "Could not reach the Klase server. Keep npm run dev running, then try again."
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
    else startLanding("Could not join. Is the Klase server running?");
    return;
  }

  const ui = renderGameShell(app);
  const selfId = room.sessionId;
  try {
    await preloadAvatars();
  } catch (e) {
    console.warn("Mixamo GLB preload failed, using primitive avatars", e);
  }
  const world = new World(ui.canvas, selfId, name, look);
  const muted = new Set<string>();
  const voice = new VoiceMesh(room, selfId);
  voice.localMuted = muted;
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
      });
    });
    return list;
  };

  const syncAvatars = () => {
    const seen = new Set<string>();
    const mutedIds: string[] = [];
    for (const p of snapshot()) {
      seen.add(p.sessionId);
      world.upsert(p.sessionId, p.name, { hat: p.hat, top: p.top, accessory: p.accessory, body: p.body === "y" ? "y" : "x" }, p.x, p.z, p.rotY);
      if (p.serverMuted) mutedIds.push(p.sessionId);
    }
    voice.setServerMuted(mutedIds);
    for (const id of world.ids()) {
      if (!seen.has(id) && id !== selfId) world.remove(id);
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

  room.onMessage("chat", (line: ChatLine) => addChat(ui.chat, ui.log, line, selfId, muted));
  room.onLeave(() => {
    voice.dispose();
    startLanding("You left the classroom.");
  });

  const sendChat = () => {
    const text = ui.input.value.trim();
    if (!text) return;
    room.send("chat", { text });
    ui.input.value = "";
  };
  ui.send.addEventListener("click", sendChat);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  ui.input.addEventListener("focus", () => ui.chat.classList.add("composing"));
  ui.input.addEventListener("blur", () => {
    if (!ui.input.value.trim()) ui.chat.classList.remove("composing");
  });
  ui.chatBtn.addEventListener("click", () => {
    ui.chat.classList.toggle("collapsed");
    ui.chatBtn.classList.toggle("primary", !ui.chat.classList.contains("collapsed"));
    if (!ui.chat.classList.contains("collapsed")) {
      ui.chat.classList.add("composing");
      ui.input.focus();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    ui.chat.classList.remove("collapsed");
    ui.chat.classList.add("composing");
    ui.input.focus();
    e.preventDefault();
  });

  ui.micBtn.addEventListener("click", async () => {
    try {
      await voice.setMic(!voice.micOn);
      ui.micBtn.textContent = voice.micOn ? "Mic on" : "Mic off";
      ui.micBtn.classList.toggle("primary", voice.micOn);
    } catch {
      startLanding("Microphone permission was denied.");
    }
  });

  ui.lookBtn.addEventListener("click", () => {
    panelOpen = "look";
    showCustomize(
      ui.layer,
      currentLook,
      (next) => {
        currentLook = next;
        localStorage.setItem("klase-look", JSON.stringify(next));
        world.applyLocalLook(next);
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
    );
  });

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const mv = world.step(dt);
    if (mv) room.send("move", mv);
    const me = snapshot().find((p) => p.sessionId === selfId);
    voice.tick(world.positions(), Boolean(me?.serverMuted));
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
