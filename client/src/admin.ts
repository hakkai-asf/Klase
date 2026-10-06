import { DEFAULT_STAFF_NAME, ROOM_CODES } from "@klase/shared";
import { authEnabled, currentSession, loadStaffIdentity, saveStaffIdentity, signInWithGoogle, signOut } from "./auth";
import { mountLookPicker, type LookPickerHandle } from "./lookPicker";
import { apiBase } from "./net";
import { openModerationModal, renderModerationToolbar, type ModSubmit, type ModTarget } from "./moderation";

/**
 * /admin — renders the admin dashboard.
 * Access control is enforced server-side on every /api/admin/* call.
 * The client UI is cosmetic; a tampered client gets 401/403 and no data.
 */

type Role = "owner" | "admin" | "user";

type LivePlayer = {
  sessionId: string; name: string; role: Role;
  signedIn: boolean; serverMuted: boolean;
  seated: boolean; observer: boolean; noclip?: boolean;
};

type RoomInfo = {
  roomKey: string; roomId: string | null;
  regulars: number; regularCap: number;
  observers: number; players: LivePlayer[];
  locked: boolean; whitelist_mode: boolean;
};

type AccountResult = {
  id: string; display_name: string; role: Role; banned: boolean;
};

type AdminPermissions = {
  user_id: string;
  can_observe: boolean; can_lock_rooms: boolean;
  can_blacklist: boolean; can_announce: boolean;
};

type WhitelistEntry = {
  id: string; room_key: string;
  user_id: string | null; passcode: string | null;
  label: string; single_use: boolean; consumed: boolean;
  expires_at: string | null; added_by: string | null; created_at: string;
};

type Me = { name: string; role: Role; permissions?: AdminPermissions | null };

const POLL_MS = 3000;

const ERRORS: Record<string, string> = {
  AUTH:            "Your session expired. Sign in again.",
  BANNED:          "This account is banned.",
  NO_PERMISSION:   "You don't have permission to do that.",
  IMMUNE:          "The owner can't be moderated.",
  ADMIN_VS_ADMIN:  "Admins can't moderate other admins.",
  NOT_FOUND:       "That player already left.",
  AUTH_DISABLED:   "Accounts are not configured on the server.",
  BAD_REQUEST:     "Bad request.",
  SERVER:          "Server error.",
  ROOM_LOCKED:     "This room is currently locked.",
  PASSCODE_CONSUMED: "This passcode has already been used.",
  PASSCODE_EXPIRED:  "This passcode has expired.",
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function divider() { return el("hr", "admin-room-divider"); }

function sublabel(text: string) { return el("p", "admin-room-sublabel", text); }

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: { retryAfterSec?: number; attemptsLeft?: number } = {},
  ) { super(code); }
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
  } catch { throw new ApiError(0, "NETWORK"); }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; retryAfterSec?: number; attemptsLeft?: number }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "SERVER", {
    retryAfterSec: data?.retryAfterSec, attemptsLeft: data?.attemptsLeft,
  });
  return data as T;
}

async function apiDelete<T>(path: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch { throw new ApiError(0, "NETWORK"); }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; retryAfterSec?: number; attemptsLeft?: number }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "SERVER", {
    retryAfterSec: data?.retryAfterSec, attemptsLeft: data?.attemptsLeft,
  });
  return data as T;
}

// ---------------------------------------------------------------------------
// Auth screens
// ---------------------------------------------------------------------------
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
  const h = el("h2", "", "Klase Admin");
  card.append(h, el("p", "", "Restricted access — staff only."));
  if (message) card.append(el("div", "error-banner", message));
  const btn = el("button", "clay-btn primary google-btn", "Sign in with Google") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    signInWithGoogle("/admin").catch((e) => {
      btn.disabled = false;
      renderSignIn(root, e instanceof Error ? e.message : "Could not start Google sign-in.");
    });
  });
  const back = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  back.href = "/";
  const row = el("div", "admin-actions");
  row.append(btn, back);
  card.append(row);
}

function renderDenied(root: HTMLElement, attemptsLeft?: number) {
  const card = screen(root);
  card.append(
    el("h2", "", "Access denied"),
    el("p", "", "This account doesn't have access to the admin dashboard."),
  );
  if (attemptsLeft !== undefined) {
    card.append(el("p", "", `${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before a 30-minute lockout.`));
  }
  const actions = el("div", "admin-actions");
  if (attemptsLeft === undefined || attemptsLeft > 0) {
    const swap = el("button", "clay-btn primary", "Sign out & try another account") as HTMLButtonElement;
    swap.addEventListener("click", async () => {
      swap.disabled = true;
      try { await signOut(); await signInWithGoogle("/admin"); }
      catch (e) { renderSignIn(root, e instanceof Error ? e.message : "Could not start Google sign-in."); }
    });
    actions.append(swap);
  }
  const back = el("a", "clay-btn", "Back to Klase") as HTMLAnchorElement;
  back.href = "/";
  actions.append(back);
  card.append(actions);
}

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
    if (left <= 0) { msg.textContent = "The lockout has ended."; retry.hidden = false; return; }
    const m = Math.floor(left / 60), s = left % 60;
    msg.textContent = `Try again in ${m > 0 ? `${m}m ` : ""}${s}s.`;
    window.setTimeout(tick, 1000);
  };
  tick();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function renderAdmin(root: HTMLElement) {
  if (!authEnabled()) { renderSignIn(root, "Accounts are not configured for this site."); return; }
  const session = await currentSession();
  if (!session) { renderSignIn(root); return; }
  const token = session.access_token;

  let me: Me;
  try {
    me = await api<Me>("/api/admin/me", token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      renderLocked(root, e.extra.retryAfterSec ?? 1800);
    } else if (e instanceof ApiError && e.status === 403) {
      renderDenied(root, e.extra.attemptsLeft);
    } else if (e instanceof ApiError && e.status === 401) {
      await signOut(); renderSignIn(root, ERRORS.AUTH);
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

// ---------------------------------------------------------------------------
// Accounts section — promote / demote / blacklist (owner only)
// ---------------------------------------------------------------------------
function renderAccountsSection(
  page: HTMLElement, token: string, _me: Me,
  notify: (msg: string, bad?: boolean) => void,
) {
  const section = el("section", "clay admin-section");

  const secHead = el("div", "admin-section-head");
  secHead.append(el("h2", "", "Accounts"));
  section.append(secHead);
  section.append(el("p", "admin-lede", "Search registered accounts to manage roles or blacklist status."));

  const searchRow = el("div", "admin-search-row");
  const input = el("input", "clay-input") as HTMLInputElement;
  input.placeholder = "Search by display name…";
  input.maxLength = 80;
  const searchBtn = el("button", "clay-btn primary", "Search") as HTMLButtonElement;
  searchRow.append(input, searchBtn);
  section.append(searchRow);

  const results = el("div", "admin-account-results");
  section.append(results);
  page.append(section);

  const runSearch = async () => {
    searchBtn.disabled = true;
    results.innerHTML = "";
    try {
      const { accounts } = await api<{ accounts: AccountResult[] }>(
        `/api/admin/accounts?q=${encodeURIComponent(input.value)}`, token,
      );
      if (!accounts.length) {
        results.append(el("p", "admin-empty", "No accounts found."));
        return;
      }
      for (const acct of accounts) {
        const row = el("div", "player-row");

        // Left: name + badges
        const left = el("div");
        left.append(document.createTextNode(acct.display_name));
        left.append(el("span", `badge ${acct.role}`, acct.role));
        if (acct.banned) left.append(el("span", "badge warn", "banned"));
        row.append(left);

        if (acct.role === "owner") {
          row.append(el("span", "admin-immune", "immune"));
        } else {
          const btns = el("div", "mods");

          const promoteBtn = el("button", "clay-btn", "Promote") as HTMLButtonElement;
          promoteBtn.title = "Promote to admin";
          promoteBtn.disabled = acct.role === "admin";
          promoteBtn.addEventListener("click", async () => {
            promoteBtn.disabled = true;
            try {
              await api("/api/admin/accounts/set-role", token, { userId: acct.id, role: "admin" });
              notify(`${acct.display_name} promoted to admin.`);
              await runSearch();
            } catch (e) {
              notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
              promoteBtn.disabled = acct.role === "admin";
            }
          });

          const demoteBtn = el("button", "clay-btn", "Demote") as HTMLButtonElement;
          demoteBtn.title = "Demote to user";
          demoteBtn.disabled = acct.role === "user";
          demoteBtn.addEventListener("click", async () => {
            demoteBtn.disabled = true;
            try {
              await api("/api/admin/accounts/set-role", token, { userId: acct.id, role: "user" });
              notify(`${acct.display_name} demoted to user.`);
              await runSearch();
            } catch (e) {
              notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
              demoteBtn.disabled = acct.role === "user";
            }
          });

          btns.append(promoteBtn, demoteBtn);

          if (!acct.banned) {
            const blBtn = el("button", "clay-btn warn", "Blacklist") as HTMLButtonElement;
            blBtn.addEventListener("click", async () => {
              blBtn.disabled = true;
              try {
                await api("/api/admin/accounts/set-banned", token, { userId: acct.id, banned: true });
                notify(`${acct.display_name} blacklisted.`);
                await runSearch();
              } catch (e) {
                notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
                blBtn.disabled = false;
              }
            });
            btns.append(blBtn);
          } else {
            const unbanBtn = el("button", "clay-btn", "Unban") as HTMLButtonElement;
            unbanBtn.addEventListener("click", async () => {
              unbanBtn.disabled = true;
              try {
                await api("/api/admin/accounts/set-banned", token, { userId: acct.id, banned: false });
                notify(`${acct.display_name} unbanned.`);
                await runSearch();
              } catch (e) {
                notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
                unbanBtn.disabled = false;
              }
            });
            btns.append(unbanBtn);
          }
          row.append(btns);
        }
        results.append(row);
      }
    } catch (e) {
      notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Search failed.", true);
    } finally {
      searchBtn.disabled = false;
    }
  };

  searchBtn.addEventListener("click", () => void runSearch());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void runSearch(); });
}

// ---------------------------------------------------------------------------
// Admin Permissions section (owner only)
// ---------------------------------------------------------------------------
function renderPermissionsSection(
  page: HTMLElement, token: string, _me: Me,
  notify: (msg: string, bad?: boolean) => void,
) {
  const section = el("section", "clay admin-section");
  const secHead = el("div", "admin-section-head");
  secHead.append(el("h2", "", "Admin Permissions"));
  section.append(secHead);
  section.append(el("p", "admin-lede", "Control what each admin can do. All checks are enforced server-side."));

  const body = el("div", "admin-perms-list");
  section.append(body);
  page.append(section);

  const flags: Array<{ key: keyof Omit<AdminPermissions, "user_id">; label: string }> = [
    { key: "can_observe",    label: "Observe rooms" },
    { key: "can_lock_rooms", label: "Lock rooms" },
    { key: "can_blacklist",  label: "Blacklist" },
    { key: "can_announce",   label: "Announce" },
  ];

  void (async () => {
    body.innerHTML = "";
    try {
      const [{ permissions }, { accounts }] = await Promise.all([
        api<{ permissions: AdminPermissions[] }>("/api/admin/permissions", token),
        api<{ accounts: AccountResult[] }>("/api/admin/accounts?q=", token),
      ]);
      const nameMap = new Map(accounts.map((a) => [a.id, a.display_name]));

      if (!permissions.length) {
        body.append(el("p", "admin-empty", "No admin accounts yet. Promote an account first."));
        return;
      }

      for (const perm of permissions) {
        const displayName = nameMap.get(perm.user_id) ?? perm.user_id.slice(0, 8) + "…";
        const row = el("div", "player-row admin-perm-row");

        const top = el("div", "admin-perm-row-top");
        top.append(document.createTextNode(displayName));
        top.append(el("span", "badge admin", "admin"));
        row.append(top);

        const flagsRow = el("div", "admin-perm-flags");
        const checkboxes: Record<string, HTMLInputElement> = {};

        for (const { key, label } of flags) {
          const lbl = el("label", "admin-perm-flag");
          const cb = el("input", "") as HTMLInputElement;
          cb.type = "checkbox";
          cb.checked = Boolean(perm[key]);
          checkboxes[key] = cb;
          lbl.append(cb, document.createTextNode(label));
          flagsRow.append(lbl);
        }

        const saveBtn = el("button", "clay-btn primary", "Save") as HTMLButtonElement;
        saveBtn.style.marginLeft = "auto";
        saveBtn.addEventListener("click", async () => {
          saveBtn.disabled = true;
          const before: Partial<Omit<AdminPermissions, "user_id">> = {};
          const after: Partial<Omit<AdminPermissions, "user_id">> = {};
          for (const { key } of flags) {
            before[key] = Boolean(perm[key]);
            after[key] = checkboxes[key]!.checked;
          }
          try {
            const { permissions: updated } = await api<{ ok: boolean; permissions: AdminPermissions }>(
              `/api/admin/permissions/${perm.user_id}`, token, after,
            );
            for (const { key } of flags) {
              (perm as Record<string, unknown>)[key] = (updated as Record<string, unknown>)[key];
              checkboxes[key]!.checked = Boolean((updated as Record<string, unknown>)[key]);
            }
            notify(`Permissions saved for ${displayName}.`);
          } catch (e) {
            for (const { key } of flags) checkboxes[key]!.checked = Boolean(before[key]);
            notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Save failed.", true);
          } finally {
            saveBtn.disabled = false;
          }
        });

        flagsRow.append(saveBtn);
        row.append(flagsRow);
        body.append(row);
      }
    } catch (e) {
      body.append(el("p", "admin-empty", "Could not load permissions."));
      notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed to load permissions.", true);
    }
  })();
}

// ---------------------------------------------------------------------------
// Player Tracker modal (owner + admin)
// ---------------------------------------------------------------------------
function openPlayerTrackerModal(
  token: string, me: Me,
  submit: (roomKey: string, payload: ModSubmit) => Promise<void>,
) {
  const overlay = el("div", "admin-tracker-overlay");
  const modal = el("div", "clay admin-tracker-modal");

  const head = el("div", "admin-tracker-head");
  head.append(el("h2", "", "Player Tracker"));
  const closeBtn = el("button", "clay-btn", "✕ Close") as HTMLButtonElement;
  head.append(closeBtn);
  modal.append(head);

  const errBanner = el("div", "error-banner");
  errBanner.hidden = true;
  modal.append(errBanner);

  const body = el("div", "admin-tracker-body");
  modal.append(body);
  overlay.append(modal);
  document.body.append(overlay);

  let intervalId = 0;
  const close = () => { clearInterval(intervalId); overlay.remove(); };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const renderTracker = async () => {
    try {
      const { rooms } = await api<{ rooms: RoomInfo[] }>("/api/admin/rooms", token);
      rooms.sort((a, b) => ROOM_CODES.indexOf(a.roomKey as never) - ROOM_CODES.indexOf(b.roomKey as never));
      errBanner.hidden = true;
      body.innerHTML = "";

      let anyPlayers = false;
      for (const room of rooms) {
        const visible = room.players.filter((p) => !p.observer);
        if (!visible.length) continue;
        anyPlayers = true;

        body.append(el("p", "admin-tracker-section-head", room.roomKey.replace("klase-", "Classroom ")));

        for (const p of visible) {
          const row = el("div", "player-row");
          const left = el("div");
          left.append(document.createTextNode(p.name));
          if (p.role !== "user") left.append(el("span", `badge ${p.role}`, p.role));
          if (p.serverMuted) left.append(el("span", "badge", "muted"));
          if (!p.signedIn && p.role === "user") left.append(el("span", "badge", "guest"));
          row.append(left);

          if (p.role !== "owner") {
            const mods = el("div", "mods");
            const allTargets: ModTarget[] = visible.map((pl) => ({
              id: pl.sessionId, name: pl.name, role: pl.role,
              serverMuted: pl.serverMuted, observer: pl.observer,
            }));
            const addMod = (text: string, action: Parameters<typeof openModerationModal>[0]["action"], warn = false) => {
              const b = el("button", warn ? "clay-btn warn" : "clay-btn", text);
              b.addEventListener("click", () =>
                openModerationModal({
                  action, actorRole: me.role, actorName: me.name,
                  players: allTargets, preselected: [p.sessionId],
                  onSubmit: (payload) => void submit(room.roomKey, payload),
                }),
              );
              mods.append(b);
            };
            addMod(p.serverMuted ? "Unmute" : "Mute", p.serverMuted ? "unmute" : "mute");
            addMod("Kick", "kick", true);
            addMod("Ban", "ban", true);
            addMod("Message", "message");
            row.append(mods);
          }
          body.append(row);
        }
      }
      if (!anyPlayers) body.append(el("p", "admin-empty", "No players online right now."));
    } catch {
      errBanner.textContent = "Could not load player data.";
      errBanner.hidden = false;
      if (!errBanner.querySelector("button")) {
        const retryBtn = el("button", "clay-btn", "Retry") as HTMLButtonElement;
        retryBtn.style.marginLeft = "0.5rem";
        retryBtn.addEventListener("click", () => void renderTracker());
        errBanner.append(retryBtn);
      }
    }
  };

  void renderTracker();
  intervalId = window.setInterval(() => void renderTracker(), POLL_MS);
}

// ---------------------------------------------------------------------------
// Whitelist panel (per room card)
// ---------------------------------------------------------------------------
function renderWhitelistPanel(
  card: HTMLElement, roomKey: string, token: string, me: Me,
  notify: (msg: string, bad?: boolean) => void,
) {
  const canWrite = me.role === "owner" || (me.role === "admin" && me.permissions?.can_lock_rooms === true);

  const panel = el("div", "admin-whitelist-panel");
  panel.append(sublabel("Whitelist"));

  const listEl = el("div", "admin-whitelist-list");
  // Reserve height so the forms below don't jump while the async fetch is in flight
  listEl.style.minHeight = "2rem";
  panel.append(listEl);

  const refreshList = async () => {
    try {
      const { entries } = await api<{ entries: WhitelistEntry[] }>(`/api/admin/whitelist/${roomKey}`, token);
      // Only clear and repaint once we have the response — prevents the jump
      listEl.innerHTML = "";
      if (!entries.length) return;
      for (const entry of entries) {
        const row = el("div", "player-row");
        const info = el("div");
        info.append(document.createTextNode(entry.label || "(no label)"));
        info.append(el("span", "badge", entry.user_id ? "user" : "passcode"));
        if (entry.single_use) info.append(el("span", "badge", "1×"));
        if (entry.consumed)   info.append(el("span", "badge warn", "used"));
        if (entry.expires_at) {
          const exp = new Date(entry.expires_at);
          info.append(el("span", "", ` · exp ${exp.toLocaleDateString()}`));
        }
        if (entry.passcode) {
          const pcSpan = el("span", "admin-passcode");
          pcSpan.textContent = entry.passcode;
          info.append(pcSpan);
        }
        row.append(info);

        if (canWrite) {
          const rm = el("button", "clay-btn warn", "Remove") as HTMLButtonElement;
          rm.addEventListener("click", async () => {
            rm.disabled = true;
            try {
              await apiDelete(`/api/admin/whitelist/entry/${entry.id}`, token);
              notify("Entry removed.");
              await refreshList();
            } catch (e) {
              notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
              rm.disabled = false;
            }
          });
          row.append(rm);
        }
        listEl.append(row);
      }
    } catch (e) {
      notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Could not load whitelist.", true);
    }
  };

  if (canWrite) {
    // ── Add user by account ID ──
    const addUserForm = el("div", "admin-whitelist-form");
    addUserForm.append(el("strong", "", "Add user by account ID"));

    const uidInput = el("input", "clay-input") as HTMLInputElement;
    uidInput.placeholder = "User UUID";
    const uidLabelInput = el("input", "clay-input") as HTMLInputElement;
    uidLabelInput.placeholder = "Label (e.g. Student A)";
    uidLabelInput.maxLength = 80;

    const uidRow = el("div", "admin-whitelist-form-row");
    const suCb = el("input", "") as HTMLInputElement;
    suCb.type = "checkbox";
    const suLbl = el("label", "admin-perm-flag");
    suLbl.append(suCb, document.createTextNode(" Single-use"));
    const expInput = el("input", "clay-input") as HTMLInputElement;
    expInput.type = "datetime-local";
    expInput.title = "Expiry (optional)";
    const addUserBtn = el("button", "clay-btn primary", "+ Add user") as HTMLButtonElement;
    uidRow.append(suLbl, expInput, addUserBtn);

    addUserForm.append(uidInput, uidLabelInput, uidRow);

    addUserBtn.addEventListener("click", async () => {
      const userId = uidInput.value.trim();
      if (!userId) { notify("Enter a user ID.", true); return; }
      addUserBtn.disabled = true;
      try {
        await api(`/api/admin/whitelist/${roomKey}/add`, token, {
          type: "user", user_id: userId,
          label: uidLabelInput.value.trim(),
          single_use: suCb.checked,
          expires_at: expInput.value ? new Date(expInput.value).toISOString() : null,
        });
        notify("User added to whitelist.");
        uidInput.value = ""; uidLabelInput.value = ""; suCb.checked = false; expInput.value = "";
        await refreshList();
      } catch (e) {
        notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
      } finally { addUserBtn.disabled = false; }
    });
    panel.append(addUserForm);

    // ── Generate passcode ──
    const addPcForm = el("div", "admin-whitelist-form");
    addPcForm.append(el("strong", "", "Generate passcode entry"));

    const pcLabelInput = el("input", "clay-input") as HTMLInputElement;
    pcLabelInput.placeholder = "Label (required)";
    pcLabelInput.maxLength = 80;

    const pcRow = el("div", "admin-whitelist-form-row");
    const pcSuCb = el("input", "") as HTMLInputElement;
    pcSuCb.type = "checkbox";
    const pcSuLbl = el("label", "admin-perm-flag");
    pcSuLbl.append(pcSuCb, document.createTextNode(" Single-use"));
    const pcExpInput = el("input", "clay-input") as HTMLInputElement;
    pcExpInput.type = "datetime-local";
    pcExpInput.title = "Expiry (optional)";
    const addPcBtn = el("button", "clay-btn primary", "+ Generate") as HTMLButtonElement;
    pcRow.append(pcSuLbl, pcExpInput, addPcBtn);

    const generatedCode = el("div", "admin-passcode-reveal");
    generatedCode.hidden = true;

    addPcForm.append(pcLabelInput, pcRow, generatedCode);

    addPcBtn.addEventListener("click", async () => {
      const label = pcLabelInput.value.trim();
      if (!label) { notify("Enter a label for the passcode.", true); return; }
      addPcBtn.disabled = true;
      try {
        const { entry } = await api<{ entry: WhitelistEntry }>(`/api/admin/whitelist/${roomKey}/add`, token, {
          type: "passcode", label,
          single_use: pcSuCb.checked,
          expires_at: pcExpInput.value ? new Date(pcExpInput.value).toISOString() : null,
        });
        generatedCode.hidden = false;
        generatedCode.innerHTML = "";
        const codeInput = el("input", "clay-input") as HTMLInputElement;
        codeInput.readOnly = true;
        codeInput.value = entry.passcode ?? "";
        const copyBtn = el("button", "clay-btn", "Copy") as HTMLButtonElement;
        copyBtn.addEventListener("click", () => {
          void navigator.clipboard.writeText(entry.passcode ?? "")
            .then(() => { copyBtn.textContent = "Copied!"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000); });
        });
        generatedCode.append(el("span", "", "Passcode (share once):"), codeInput, copyBtn);
        notify("Passcode created.");
        pcLabelInput.value = ""; pcSuCb.checked = false; pcExpInput.value = "";
        await refreshList();
      } catch (e) {
        notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
      } finally { addPcBtn.disabled = false; }
    });
    panel.append(addPcForm);
  }

  card.append(panel);
  void refreshList();
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
async function mountDashboard(root: HTMLElement, token: string, me: Me) {
  root.innerHTML = "";
  const page = el("div", "admin-page");

  // ── Header ──────────────────────────────────────────────────────────────
  const head = el("div", "admin-head");

  const headLeft = el("div", "admin-head-left");
  headLeft.append(el("h1", "", "Klase Admin"));
  const who = el("p", "admin-who");
  who.append(document.createTextNode(me.name + " "));
  who.append(el("span", `badge ${me.role}`, me.role));
  headLeft.append(who);

  const headActions = el("div", "admin-head-actions");
  const trackerBtn = el("button", "clay-btn", "👥 Player Tracker");
  trackerBtn.addEventListener("click", () => openPlayerTrackerModal(token, me, submit));
  const game = el("a", "clay-btn", "← Back to Klase") as HTMLAnchorElement;
  game.href = "/";
  game.addEventListener("click", (e) => {
    e.preventDefault(); stop();
    document.body.classList.remove("admin-route");
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const signOutBtn = el("button", "clay-btn", "Sign out");
  signOutBtn.addEventListener("click", async () => { stop(); await signOut(); window.location.replace("/admin"); });
  headActions.append(trackerBtn, game, signOutBtn);

  head.append(headLeft, headActions);
  page.append(head);

  // ── Global status ────────────────────────────────────────────────────────
  const status = el("div", "admin-status");
  page.append(status);

  const notify = (msg: string, bad = false) => {
    status.textContent = msg;
    status.className = bad ? "admin-status bad" : "admin-status";
  };

  // ── Enter As ──────────────────────────────────────────────────────────────
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
    enter.append(el("h2", "", "Enter As"));
    enter.append(el("p", "lede", "Your in-room appearance. Role and permissions always come from your account."));

    const nameRow = el("div", "admin-enter-name");
    const nameLab = el("label", "");
    nameLab.append(el("span", "", "Display name"), nameInput);
    nameInput.value = identity.name || DEFAULT_STAFF_NAME;

    const resetBtn = el("button", "clay-btn", "Reset") as HTMLButtonElement;
    resetBtn.type = "button";
    resetBtn.title = `Reset to ${DEFAULT_STAFF_NAME}`;
    resetBtn.addEventListener("click", () => { nameInput.value = DEFAULT_STAFF_NAME; });

    const saveBtn = el("button", "clay-btn primary", "Save") as HTMLButtonElement;
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const saved = await persistIdentity();
        who.replaceChildren(document.createTextNode(saved.name + " "), el("span", `badge ${me.role}`, me.role));
        notify("Identity saved.");
      } catch (e) {
        notify(e instanceof Error ? e.message : "Could not save identity.", true);
      } finally { saveBtn.disabled = false; }
    });

    nameRow.append(nameLab, resetBtn, saveBtn);
    enter.append(nameRow);
    const pickerHost = el("div", "admin-enter-picker neo-picker-frame");
    enter.append(pickerHost);
    picker = mountLookPicker(pickerHost, { look: identity.look, enableWearables: true, persistLook: false });
    page.append(enter);
  }

  // ── Owner-only sections ───────────────────────────────────────────────────
  if (me.role === "owner") {
    renderAccountsSection(page, token, me, notify);
    renderPermissionsSection(page, token, me, notify);
  }

  // ── Room grid ─────────────────────────────────────────────────────────────
  const grid = el("div", "admin-rooms");
  page.append(grid);
  root.append(page);

  // ── Internals ─────────────────────────────────────────────────────────────
  let timer = 0, stopped = false, inFlight = false, pollFailed = false;

  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    picker?.dispose(); picker = null;
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 429) { stop(); renderLocked(root, e.extra.retryAfterSec ?? 1800); return; }
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
      notify(`${payload.action} applied.`);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        notify(ERRORS[e.code] ?? e.code, true); void refresh();
      } else fail(e);
    }
  };

  const targetsOf = (room: RoomInfo): ModTarget[] =>
    room.players
      .filter((p) => !p.observer)
      .map((p) => ({ id: p.sessionId, name: p.name, role: p.role, serverMuted: p.serverMuted, observer: p.observer }));

  const canObserve   = me.role === "owner" || (me.role === "admin" && me.permissions?.can_observe    === true);
  const canLockRooms = me.role === "owner" || (me.role === "admin" && me.permissions?.can_lock_rooms === true);

  const renderRooms = (rooms: RoomInfo[]) => {
    grid.innerHTML = "";
    for (const room of rooms) {
      const card = el("section", "clay admin-room");
      const label = room.roomKey.replace("klase-", "Classroom ");
      const visible = room.players.filter((p) => !p.observer);

      // ── Room header ──
      const roomHeader = el("div", "admin-room-header");
      roomHeader.append(el("h2", "", label));
      if (room.locked) roomHeader.append(el("span", "badge warn", "🔒 locked"));
      card.append(roomHeader);

      // ── Meta row ──
      const meta = el("div", "admin-room-meta");
      meta.append(el("span", "admin-room-count", `${visible.length} online · ${room.regulars}/${room.regularCap} seats`));
      card.append(meta);

      // ── Actions row ──
      const actions = el("div", "admin-room-actions");

      const enterBtn = el("button", "clay-btn primary", "Enter room");
      enterBtn.title = "Join as yourself, visible, skipping capacity";
      enterBtn.addEventListener("click", () => {
        void persistIdentity().then(() => {
          stop();
          window.location.assign(`/room/${room.roomKey}?mode=${me.role === "admin" ? "admin" : "owner"}`);
        });
      });
      actions.append(enterBtn);

      if (canObserve) {
        const obsBtn = el("button", "clay-btn", "👁 Observe");
        obsBtn.title = "Silent invisible spectator";
        obsBtn.addEventListener("click", () => {
          void persistIdentity().then(() => {
            stop();
            window.location.assign(`/room/${room.roomKey}?mode=observe`);
          });
        });
        actions.append(obsBtn);
      }

      if (canLockRooms) {
        const lockBtn = el("button", room.locked ? "clay-btn" : "clay-btn", room.locked ? "🔓 Unlock" : "🔒 Lock") as HTMLButtonElement;
        lockBtn.addEventListener("click", async () => {
          lockBtn.disabled = true;
          try {
            await api("/api/admin/room-config", token, { roomKey: room.roomKey, locked: !room.locked });
            notify(room.locked ? `${label} unlocked.` : `${label} locked.`);
            await refresh();
          } catch (e) {
            notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
            lockBtn.disabled = false;
          }
        });
        actions.append(lockBtn);
      }

      card.append(actions);

      // ── Moderation toolbar ──
      const tools = el("div", "admin-mod-tools");
      renderModerationToolbar(tools, {
        role: me.role, actorName: me.name,
        getPlayers: () => targetsOf(room),
        onSubmit: (payload) => void submit(room.roomKey, payload),
      });
      card.append(tools);

      // ── Whitelist panel ──
      card.append(divider());
      renderWhitelistPanel(card, room.roomKey, token, me, notify);

      // ── Players list ──
      card.append(divider());
      card.append(sublabel("Players"));
      const playersList = el("div", "admin-players-list");

      if (!visible.length) {
        playersList.append(el("p", "admin-empty", "Nobody here."));
      } else {
        for (const p of room.players) {
          const row = el("div", "player-row");
          const left = el("div");
          left.append(document.createTextNode(p.name));
          if (p.role !== "user") left.append(el("span", `badge ${p.role}`, p.role));
          if (p.serverMuted) left.append(el("span", "badge", "muted"));
          if (p.observer)    left.append(el("span", "badge", "observe"));
          if (p.noclip)      left.append(el("span", "badge", "noclip"));
          if (!p.signedIn && p.role === "user") left.append(el("span", "badge", "guest"));
          row.append(left);

          if (p.role !== "owner") {
            const mods = el("div", "mods");
            const add = (text: string, action: Parameters<typeof openModerationModal>[0]["action"], warn = false) => {
              const b = el("button", warn ? "clay-btn warn" : "clay-btn", text);
              b.addEventListener("click", () =>
                openModerationModal({
                  action, actorRole: me.role, actorName: me.name,
                  players: targetsOf(room), preselected: [p.sessionId],
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
          playersList.append(row);
        }
      }
      card.append(playersList);
      grid.append(card);
    }
  };

  async function refresh() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const { rooms } = await api<{ rooms: RoomInfo[] }>("/api/admin/rooms", token);
      rooms.sort((a, b) => ROOM_CODES.indexOf(a.roomKey as never) - ROOM_CODES.indexOf(b.roomKey as never));
      if (!stopped) {
        renderRooms(rooms);
        if (pollFailed) { pollFailed = false; notify(""); }
      }
    } catch (e) {
      pollFailed = true; fail(e);
    } finally { inFlight = false; }
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
  void refresh().then(() => { if (status.textContent === "Loading…") notify(""); });
  schedule();
}
