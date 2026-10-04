import { DEFAULT_STAFF_NAME, ROOM_CODES } from "@klase/shared";
import { authEnabled, currentSession, loadStaffIdentity, saveStaffIdentity, signInWithGoogle, signOut } from "./auth";
import { mountLookPicker, type LookPickerHandle } from "./lookPicker";
import { apiBase } from "./net";
import { openModerationModal, renderModerationToolbar, type ModSubmit, type ModTarget } from "./moderation";

/**
 * /admin. This file only renders. Access control is enforced by the Colyseus server:
 * every /api/admin/* call re-verifies the Supabase token and re-reads profiles.role there,
 * so a tampered client gets 401/403 and no data, whatever it shows.
 */

type Role = "owner" | "admin" | "user";
type LivePlayer = {
  sessionId: string;
  name: string;
  role: Role;
  signedIn: boolean;
  serverMuted: boolean;
  seated: boolean;
  observer: boolean;
  noclip?: boolean;
};
type RoomInfo = {
  roomKey: string;
  roomId: string | null;
  regulars: number;
  regularCap: number;
  observers: number;
  players: LivePlayer[];
};

const POLL_MS = 3000;

const ERRORS: Record<string, string> = {
  AUTH: "Your session expired. Sign in again.",
  BANNED: "This account is banned.",
  NO_PERMISSION: "You don't have permission to do that.",
  IMMUNE: "The owner can't be moderated.",
  ADMIN_VS_ADMIN: "Admins can't moderate other admins.",
  NOT_FOUND: "That player already left.",
  AUTH_DISABLED: "Accounts are not configured on the server.",
  BAD_REQUEST: "Bad request.",
  SERVER: "Server error.",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: { retryAfterSec?: number; attemptsLeft?: number } = {},
  ) {
    super(code);
  }
}

async function api<T>(path: string, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; retryAfterSec?: number; attemptsLeft?: number })
    | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? "SERVER", {
      retryAfterSec: data?.retryAfterSec,
      attemptsLeft: data?.attemptsLeft,
    });
  }
  return data as T;
}

function screen(root: HTMLElement) {
  root.innerHTML = "";
  const wrap = el("div", "landing");
  const card = el("div", "clay admin-card");
  wrap.append(card);
  root.append(wrap);
  return card;
}

function renderSignIn(root: HTMLElement, message = "") {
  const card = screen(root);
  card.append(el("h2", "", "Klase admin"), el("p", "", "THIS IS A RESTRICTED ACCESS AREA. ONLY FOR ADMINS AND OWNER."));
  if (message) card.append(el("div", "error-banner", message));
  const btn = el("button", "clay-btn primary", "Sign in with Google") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    signInWithGoogle("/admin").catch((e) => {
      btn.disabled = false;
      renderSignIn(root, e instanceof Error ? e.message : "Could not start Google sign-in.");
    });
  });
  const back = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  back.href = "/";
  card.append(el("div", "admin-actions"));
  card.lastElementChild!.append(btn, back);
}

function renderDenied(root: HTMLElement, attemptsLeft?: number) {
  const card = screen(root);
  card.append(el("h2", "", "Access denied"), el("p", "", "This account doesn't have access to the admin dashboard."));
  const actions = el("div", "admin-actions");
  // The switch button only exists while strikes remain. The server already counted this denial;
  // signing in as someone else doesn't undo it, and the 3rd strike goes to the lock screen instead.
  if (attemptsLeft === undefined || attemptsLeft > 0) {
    if (attemptsLeft !== undefined) {
      card.append(
        el("p", "admin-who", `${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before a 30 minute lockout.`),
      );
    }
    const swap = el("button", "clay-btn primary", "Sign out & try another account") as HTMLButtonElement;
    swap.addEventListener("click", async () => {
      swap.disabled = true;
      try {
        await signOut();
        await signInWithGoogle("/admin"); // Google account chooser (prompt=select_account)
      } catch (e) {
        renderSignIn(root, e instanceof Error ? e.message : "Could not start Google sign-in.");
      }
    });
    actions.append(swap);
  }
  const back = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  back.href = "/";
  actions.append(back);
  card.append(actions);
}

/** Server-enforced lockout (admin_attempts). The countdown is cosmetic; the server decides. */
function renderLocked(root: HTMLElement, retryAfterSec: number) {
  const card = screen(root);
  const msg = el("p", "");
  const retry = el("button", "clay-btn primary", "Try again") as HTMLButtonElement;
  retry.hidden = true;
  retry.addEventListener("click", () => void renderAdmin(root));
  const back = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  back.href = "/";
  card.append(el("h2", "", "Too many failed attempts"), msg);
  const actions = el("div", "admin-actions");
  actions.append(retry, back);
  card.append(actions);
  const until = Date.now() + retryAfterSec * 1000;
  const tick = () => {
    if (!msg.isConnected) return;
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      msg.textContent = "The lockout has ended.";
      retry.hidden = false;
      return;
    }
    const m = Math.floor(left / 60);
    const s = left % 60;
    msg.textContent = `Try again in ${m > 0 ? `${m} minute${m === 1 ? "" : "s"} ` : ""}${s} second${s === 1 ? "" : "s"}.`;
    window.setTimeout(tick, 1000);
  };
  tick();
}

export async function renderAdmin(root: HTMLElement) {
  if (!authEnabled()) {
    renderSignIn(root, "Accounts are not configured for this site.");
    return;
  }
  const session = await currentSession();
  if (!session) {
    renderSignIn(root);
    return;
  }
  const token = session.access_token;

  // Server-side gate: nothing below renders unless the server says this user is owner/admin.
  let me: { name: string; role: Role };
  try {
    me = await api("/api/admin/me", token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      renderLocked(root, e.extra.retryAfterSec ?? 1800);
    } else if (e instanceof ApiError && e.status === 403) {
      renderDenied(root, e.extra.attemptsLeft);
    } else if (e instanceof ApiError && e.status === 401) {
      await signOut();
      renderSignIn(root, ERRORS.AUTH);
    } else {
      const card = screen(root);
      card.append(el("h2", "", "Can't reach the server"), el("p", "", "The game server may be waking up. Try again in a moment."));
      const retry = el("button", "clay-btn primary", "Retry");
      retry.addEventListener("click", () => void renderAdmin(root));
      card.append(retry);
    }
    return;
  }

  void mountDashboard(root, token, me);
}

async function mountDashboard(root: HTMLElement, token: string, me: { name: string; role: Role }) {
  root.innerHTML = "";
  const page = el("div", "admin-page");
  const head = el("div", "admin-head");
  const title = el("div");
  title.append(el("h1", "", "Klase admin"));
  const who = el("p", "admin-who");
  who.append(document.createTextNode(`${me.name} `), el("span", `badge ${me.role}`, me.role));
  title.append(who);
  const headBtns = el("div", "admin-actions");
  const game = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  game.href = "/";
  const out = el("button", "clay-btn", "Sign out");
  out.addEventListener("click", async () => {
    stop();
    await signOut();
    window.location.replace("/admin");
  });
  headBtns.append(game, out);
  head.append(title, headBtns);

  const status = el("div", "admin-status");
  const grid = el("div", "admin-rooms");
  page.append(head);
  let picker: LookPickerHandle | null = null;
  const nameInput = el("input", "clay-input") as HTMLInputElement;
  nameInput.maxLength = 24;
  nameInput.placeholder = DEFAULT_STAFF_NAME;
  const persistIdentity = async () => {
    const saved = await saveStaffIdentity(nameInput.value, picker?.getLook() ?? { hat: "", top: "", accessory: "", body: "x" });
    nameInput.value = saved.name;
    return saved;
  };
  if (me.role === "owner" || me.role === "admin") {
    const identity = await loadStaffIdentity();
    const enter = el("section", "clay admin-enter-as");
    enter.append(el("h2", "", "Enter as"));
    enter.append(
      el(
        "p",
        "lede",
        "This is how you appear in a room. Your role and permissions still come from your account, not this name.",
      ),
    );
    const nameRow = el("div", "admin-enter-name");
    const nameLab = el("label", "");
    nameLab.append(el("span", "", "Display name"), nameInput);
    nameInput.value = identity.name || DEFAULT_STAFF_NAME;
    const reset = el("button", "clay-btn", `Reset to ${DEFAULT_STAFF_NAME}`) as HTMLButtonElement;
    reset.type = "button";
    reset.addEventListener("click", () => {
      nameInput.value = DEFAULT_STAFF_NAME;
    });
    const save = el("button", "clay-btn primary", "Save") as HTMLButtonElement;
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const saved = await persistIdentity();
        who.replaceChildren(document.createTextNode(`${saved.name} `), el("span", `badge ${me.role}`, me.role));
        notify("Identity saved.");
      } catch (e) {
        notify(e instanceof Error ? e.message : "Could not save identity.", true);
      } finally {
        save.disabled = false;
      }
    });
    nameRow.append(nameLab, reset, save);
    enter.append(nameRow);
    const pickerHost = el("div", "admin-enter-picker neo-picker-frame");
    enter.append(pickerHost);
    picker = mountLookPicker(pickerHost, { look: identity.look, enableWearables: true, persistLook: false });
    page.append(enter);
  }
  page.append(status, grid);
  root.append(page);

  const notify = (msg: string, bad = false) => {
    status.textContent = msg;
    status.className = bad ? "admin-status bad" : "admin-status";
  };

  let timer = 0;
  let stopped = false;
  let inFlight = false;
  let pollFailed = false;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    picker?.dispose();
    picker = null;
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 429) {
      stop();
      renderLocked(root, e.extra.retryAfterSec ?? 1800);
      return;
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      stop();
      if (e.status === 403) renderDenied(root, e.extra.attemptsLeft);
      else renderSignIn(root, ERRORS[e.code] ?? ERRORS.AUTH);
      return;
    }
    notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Something went wrong.", true);
  };

  const submit = async (roomKey: string, payload: ModSubmit) => {
    try {
      await api("/api/admin/moderate", token, { roomKey, ...payload });
      notify(`${payload.action} × ${payload.targetIds.length || 1}`);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        notify(ERRORS[e.code] ?? e.code, true);
        void refresh();
      } else fail(e);
    }
  };

  const targetsOf = (room: RoomInfo): ModTarget[] =>
    room.players
      .filter((p) => !p.observer)
      .map((p) => ({ id: p.sessionId, name: p.name, role: p.role, serverMuted: p.serverMuted, observer: p.observer }));

  const renderRooms = (rooms: RoomInfo[]) => {
    grid.innerHTML = "";
    for (const room of rooms) {
      const card = el("section", "clay admin-room");
      const h = el("div", "admin-room-head");
      const label = room.roomKey.replace("klase-", "Classroom ");
      const visible = room.players.filter((p) => !p.observer);
      h.append(
        el("h2", "", label),
        el("span", "admin-count", `${visible.length} in room · ${room.regulars}/${room.regularCap} regular`),
      );
      card.append(h);

      const enter = el("div", "admin-actions");
      const play = el("button", "clay-btn primary", "Enter room");
      play.title = "Join as yourself, visible, skipping capacity";
      play.addEventListener("click", () => {
        void persistIdentity().then(() => {
          stop();
          window.location.assign(`/room/${room.roomKey}?mode=${me.role === "admin" ? "admin" : "owner"}`);
        });
      });
      enter.append(play);
      if (me.role === "owner") {
        const obs = el("button", "clay-btn", "Observe");
        obs.title = "Silent invisible spectator (no body)";
        obs.addEventListener("click", () => {
          void persistIdentity().then(() => {
            stop();
            window.location.assign(`/room/${room.roomKey}?mode=observe`);
          });
        });
        enter.append(obs);
      }
      card.append(enter);
      const tools = el("div", "admin-mod-tools");
      renderModerationToolbar(tools, {
        role: me.role,
        actorName: me.name,
        getPlayers: () => targetsOf(room),
        onSubmit: (payload) => void submit(room.roomKey, payload),
      });
      card.append(tools);

      if (!room.players.length) card.append(el("p", "admin-empty", "Nobody here."));
      for (const p of room.players) {
        const row = el("div", "player-row");
        const left = el("div");
        left.append(document.createTextNode(p.name));
        if (p.role !== "user") left.append(el("span", `badge ${p.role}`, p.role));
        if (p.serverMuted) left.append(el("span", "badge", "muted"));
        if (p.observer) left.append(el("span", "badge", "observe"));
        if (p.noclip) left.append(el("span", "badge", "noclip"));
        if (!p.signedIn && p.role === "user") left.append(el("span", "badge", "guest"));
        row.append(left);

        // Buttons are only a convenience; the server decides via assertCanModerate.
        if (p.role !== "owner") {
          const mods = el("div", "mods");
          const add = (text: string, action: Parameters<typeof openModerationModal>[0]["action"], warn = false) => {
            const b = el("button", warn ? "clay-btn warn" : "clay-btn", text);
            b.addEventListener("click", () =>
              openModerationModal({
                action,
                actorRole: me.role,
                actorName: me.name,
                players: targetsOf(room),
                preselected: [p.sessionId],
                onSubmit: (payload) => void submit(room.roomKey, payload),
              }),
            );
            mods.append(b);
          };
          add(p.serverMuted ? "Unmute" : "Mute", p.serverMuted ? "unmute" : "mute");
          add("Kick", "kick", true);
          add("Ban", "ban", true);
          add("Message", "message");
          if (me.role === "owner") add(p.role === "admin" ? "Demote" : "Promote", p.role === "admin" ? "demote" : "promote");
          row.append(mods);
        }
        card.append(row);
      }
      grid.append(card);
    }
  };

  async function refresh() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const { rooms } = await api<{ rooms: RoomInfo[] }>("/api/admin/rooms", token);
      // Keep the three fixed rooms in a stable order.
      rooms.sort((a, b) => ROOM_CODES.indexOf(a.roomKey as never) - ROOM_CODES.indexOf(b.roomKey as never));
      if (!stopped) {
        renderRooms(rooms);
        if (pollFailed) {
          pollFailed = false;
          notify("");
        }
      }
    } catch (e) {
      pollFailed = true;
      fail(e);
    } finally {
      inFlight = false;
    }
  }

  const schedule = () => {
    window.clearTimeout(timer);
    if (stopped) return;
    timer = window.setTimeout(async () => {
      if (document.visibilityState === "visible") await refresh();
      schedule();
    }, POLL_MS);
  };
  function onVisible() {
    if (document.visibilityState === "visible") void refresh();
  }
  document.addEventListener("visibilitychange", onVisible);

  notify("Loading…");
  void refresh().then(() => {
    if (status.textContent === "Loading…") notify("");
  });
  schedule();
}
