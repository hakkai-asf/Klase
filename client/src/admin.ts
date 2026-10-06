import { DEFAULT_STAFF_NAME, ROOM_CODES } from "@klase/shared";
import { authEnabled, currentSession, loadStaffIdentity, saveStaffIdentity, signInWithGoogle, signOut } from "./auth";
import { mountLookPicker, type LookPickerHandle } from "./lookPicker";
import { apiBase } from "./net";
import { openModerationModal, renderModerationToolbar, type ModSubmit, type ModTarget } from "./moderation";

/**
 * /admin — renders the admin dashboard.
 * Access control is enforced server-side on every /api/admin/* call.
 * Client UI is cosmetic only; a tampered client gets 401/403 and no data.
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

const POLL_MS = 4000;

const ERRORS: Record<string, string> = {
  AUTH:              "Your session expired. Sign in again.",
  BANNED:            "This account is banned.",
  NO_PERMISSION:     "You don't have permission to do that.",
  IMMUNE:            "The owner can't be moderated.",
  ADMIN_VS_ADMIN:    "Admins can't moderate other admins.",
  NOT_FOUND:         "That player already left.",
  AUTH_DISABLED:     "Accounts are not configured on the server.",
  BAD_REQUEST:       "Bad request.",
  SERVER:            "Server error.",
  ROOM_LOCKED:       "This room is currently locked.",
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
  wrap.append(card); root.append(wrap);
  return card;
}

function renderSignIn(root: HTMLElement, message = "") {
  const card = screen(root);
  card.append(el("h2", "", "Klase Admin"), el("p", "", "Restricted access — staff only."));
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
  const row = el("div", "admin-actions");
  row.append(btn, back);
  card.append(row);
}

function renderDenied(root: HTMLElement, attemptsLeft?: number) {
  const card = screen(root);
  card.append(el("h2", "", "Access denied"), el("p", "", "This account doesn't have access to the admin dashboard."));
  if (attemptsLeft !== undefined)
    card.append(el("p", "", `${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before a 30-minute lockout.`));
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
    if (e instanceof ApiError && e.status === 429) renderLocked(root, e.extra.retryAfterSec ?? 1800);
    else if (e instanceof ApiError && e.status === 403) renderDenied(root, e.extra.attemptsLeft);
    else if (e instanceof ApiError && e.status === 401) { await signOut(); renderSignIn(root, ERRORS.AUTH); }
    else {
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
// Accounts section (owner only)
// ---------------------------------------------------------------------------
function renderAccountsSection(page: HTMLElement, token: string, notify: (m: string, bad?: boolean) => void) {
  const section = el("section", "clay admin-section");
  section.append(el("h2", "", "Accounts"));
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
      if (!accounts.length) { results.append(el("p", "admin-empty", "No accounts found.")); return; }
      for (const acct of accounts) {
        const row = el("div", "player-row");
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
          promoteBtn.title = "Promote to admin"; promoteBtn.disabled = acct.role === "admin";
          promoteBtn.addEventListener("click", async () => {
            promoteBtn.disabled = true;
            try { await api("/api/admin/accounts/set-role", token, { userId: acct.id, role: "admin" }); notify(`${acct.display_name} promoted.`); await runSearch(); }
            catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); promoteBtn.disabled = acct.role === "admin"; }
          });
          const demoteBtn = el("button", "clay-btn", "Demote") as HTMLButtonElement;
          demoteBtn.title = "Demote to user"; demoteBtn.disabled = acct.role === "user";
          demoteBtn.addEventListener("click", async () => {
            demoteBtn.disabled = true;
            try { await api("/api/admin/accounts/set-role", token, { userId: acct.id, role: "user" }); notify(`${acct.display_name} demoted.`); await runSearch(); }
            catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); demoteBtn.disabled = acct.role === "user"; }
          });
          btns.append(promoteBtn, demoteBtn);
          if (!acct.banned) {
            const blBtn = el("button", "clay-btn warn", "Blacklist") as HTMLButtonElement;
            blBtn.addEventListener("click", async () => {
              blBtn.disabled = true;
              try { await api("/api/admin/accounts/set-banned", token, { userId: acct.id, banned: true }); notify(`${acct.display_name} blacklisted.`); await runSearch(); }
              catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); blBtn.disabled = false; }
            });
            btns.append(blBtn);
          } else {
            const unbanBtn = el("button", "clay-btn", "Unban") as HTMLButtonElement;
            unbanBtn.addEventListener("click", async () => {
              unbanBtn.disabled = true;
              try { await api("/api/admin/accounts/set-banned", token, { userId: acct.id, banned: false }); notify(`${acct.display_name} unbanned.`); await runSearch(); }
              catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); unbanBtn.disabled = false; }
            });
            btns.append(unbanBtn);
          }
          row.append(btns);
        }
        results.append(row);
      }
    } catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Search failed.", true); }
    finally { searchBtn.disabled = false; }
  };

  searchBtn.addEventListener("click", () => void runSearch());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void runSearch(); });
}

// ---------------------------------------------------------------------------
// Admin Permissions section (owner only)
// ---------------------------------------------------------------------------
function renderPermissionsSection(page: HTMLElement, token: string, notify: (m: string, bad?: boolean) => void) {
  const section = el("section", "clay admin-section");
  section.append(el("h2", "", "Admin Permissions"));
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
    try {
      const [{ permissions }, { accounts }] = await Promise.all([
        api<{ permissions: AdminPermissions[] }>("/api/admin/permissions", token),
        api<{ accounts: AccountResult[] }>("/api/admin/accounts?q=", token),
      ]);
      const nameMap = new Map(accounts.map((a) => [a.id, a.display_name]));
      if (!permissions.length) { body.append(el("p", "admin-empty", "No admins yet. Promote an account first.")); return; }

      for (const perm of permissions) {
        const displayName = nameMap.get(perm.user_id) ?? perm.user_id.slice(0, 8) + "…";
        const row = el("div", "player-row admin-perm-row");
        const top = el("div", "admin-perm-row-top");
        top.append(document.createTextNode(displayName), el("span", "badge admin", "admin"));
        row.append(top);

        const flagsRow = el("div", "admin-perm-flags");
        const checkboxes: Record<string, HTMLInputElement> = {};
        for (const { key, label } of flags) {
          const lbl = el("label", "admin-perm-flag");
          const cb = el("input", "") as HTMLInputElement;
          cb.type = "checkbox"; cb.checked = Boolean(perm[key]);
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
          for (const { key } of flags) { before[key] = Boolean(perm[key]); after[key] = checkboxes[key]!.checked; }
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
          } finally { saveBtn.disabled = false; }
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
// Whitelist management modal (separate modal so poll never destroys its inputs)
// ---------------------------------------------------------------------------
function openWhitelistModal(
  roomKey: string, token: string, me: Me,
  notify: (m: string, bad?: boolean) => void,
) {
  const canWrite = me.role === "owner" || (me.role === "admin" && me.permissions?.can_lock_rooms === true);
  const label = roomKey.replace("klase-", "Classroom ");

  const overlay = el("div", "admin-tracker-overlay");
  const modal = el("div", "clay admin-tracker-modal");

  const head = el("div", "admin-tracker-head");
  head.append(el("h2", "", `Whitelist — ${label}`));
  const closeBtn = el("button", "clay-btn", "✕ Close") as HTMLButtonElement;
  head.append(closeBtn);
  modal.append(head);
  overlay.append(modal);
  document.body.append(overlay);

  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // ── Current entries list ──
  const listEl = el("div", "admin-whitelist-list");
  modal.append(listEl);

  const refreshList = async () => {
    try {
      const { entries } = await api<{ entries: WhitelistEntry[] }>(`/api/admin/whitelist/${roomKey}`, token);
      listEl.innerHTML = "";
      if (!entries.length) { listEl.append(el("p", "admin-empty", "No entries yet.")); return; }
      for (const entry of entries) {
        const row = el("div", "player-row");
        const info = el("div");
        info.append(document.createTextNode(entry.label || "(unlabelled)"));
        info.append(el("span", "badge", entry.user_id ? "account" : "passcode"));
        if (entry.single_use) info.append(el("span", "badge", "1×"));
        if (entry.consumed)   info.append(el("span", "badge warn", "used"));
        if (entry.expires_at) {
          const exp = new Date(entry.expires_at);
          info.append(document.createTextNode(` · expires ${exp.toLocaleDateString()}`));
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
            try { await apiDelete(`/api/admin/whitelist/entry/${entry.id}`, token); await refreshList(); }
            catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); rm.disabled = false; }
          });
          row.append(rm);
        }
        listEl.append(row);
      }
    } catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Could not load whitelist.", true); }
  };

  if (canWrite) {
    // ── Add by account (name/email search) ──
    const addAccForm = el("div", "admin-whitelist-form");
    addAccForm.append(el("strong", "", "Add account to whitelist"));
    addAccForm.append(el("p", "admin-lede", "Search by display name or email. The matched account will be whitelisted by ID."));

    const searchInput = el("input", "clay-input") as HTMLInputElement;
    searchInput.placeholder = "Name or email…";
    const searchRow = el("div", "admin-search-row");
    const searchBtn = el("button", "clay-btn", "Search") as HTMLButtonElement;
    searchRow.append(searchInput, searchBtn);

    const searchResults = el("div", "admin-account-results");

    const doSearch = async () => {
      searchBtn.disabled = true;
      searchResults.innerHTML = "";
      try {
        const { accounts } = await api<{ accounts: AccountResult[] }>(
          `/api/admin/whitelist-search?q=${encodeURIComponent(searchInput.value)}`, token,
        );
        if (!accounts.length) { searchResults.append(el("p", "admin-empty", "No accounts found.")); }
        for (const acct of accounts) {
          const row = el("div", "player-row");
          const info = el("div");
          info.append(document.createTextNode(acct.display_name));
          info.append(el("span", `badge ${acct.role}`, acct.role));
          row.append(info);
          const addBtn = el("button", "clay-btn primary", "+ Whitelist") as HTMLButtonElement;
          addBtn.addEventListener("click", async () => {
            addBtn.disabled = true;
            try {
              await api(`/api/admin/whitelist/${roomKey}/add`, token, {
                type: "user", user_id: acct.id, label: acct.display_name,
                single_use: false, expires_at: null,
              });
              notify(`${acct.display_name} added to whitelist.`);
              searchResults.innerHTML = "";
              searchInput.value = "";
              await refreshList();
            } catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); addBtn.disabled = false; }
          });
          row.append(addBtn);
          searchResults.append(row);
        }
      } catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Search failed.", true); }
      finally { searchBtn.disabled = false; }
    };

    searchBtn.addEventListener("click", () => void doSearch());
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void doSearch(); });

    addAccForm.append(searchRow, searchResults);
    modal.append(addAccForm);

    // ── Generate passcode ──
    const addPcForm = el("div", "admin-whitelist-form");
    addPcForm.append(el("strong", "", "Generate a passcode"));
    addPcForm.append(el("p", "admin-lede", "Share this code with specific users. They enter it when the room is locked."));

    const pcLabelInput = el("input", "clay-input") as HTMLInputElement;
    pcLabelInput.placeholder = "Label (e.g. Group A)";
    pcLabelInput.maxLength = 80;
    const pcRow = el("div", "admin-whitelist-form-row");
    const pcSuCb = el("input", "") as HTMLInputElement;
    pcSuCb.type = "checkbox";
    const pcSuLbl = el("label", "admin-perm-flag");
    pcSuLbl.append(pcSuCb, document.createTextNode(" Single-use"));
    const genBtn = el("button", "clay-btn primary", "Generate") as HTMLButtonElement;
    pcRow.append(pcSuLbl, genBtn);
    const generatedCode = el("div", "admin-passcode-reveal");
    generatedCode.hidden = true;

    genBtn.addEventListener("click", async () => {
      const lbl = pcLabelInput.value.trim();
      if (!lbl) { notify("Enter a label first.", true); return; }
      genBtn.disabled = true;
      try {
        const { entry } = await api<{ entry: WhitelistEntry }>(`/api/admin/whitelist/${roomKey}/add`, token, {
          type: "passcode", label: lbl, single_use: pcSuCb.checked, expires_at: null,
        });
        generatedCode.hidden = false;
        generatedCode.innerHTML = "";
        const codeInput = el("input", "clay-input") as HTMLInputElement;
        codeInput.readOnly = true; codeInput.value = entry.passcode ?? "";
        const copyBtn = el("button", "clay-btn", "Copy") as HTMLButtonElement;
        copyBtn.addEventListener("click", () => {
          void navigator.clipboard.writeText(entry.passcode ?? "")
            .then(() => { copyBtn.textContent = "Copied!"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000); });
        });
        generatedCode.append(el("span", "", "Passcode (share once):"), codeInput, copyBtn);
        notify("Passcode created.");
        pcLabelInput.value = ""; pcSuCb.checked = false;
        await refreshList();
      } catch (e) { notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true); }
      finally { genBtn.disabled = false; }
    });

    addPcForm.append(pcLabelInput, pcRow, generatedCode);
    modal.append(addPcForm);
  }

  void refreshList();
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
async function mountDashboard(root: HTMLElement, token: string, me: Me) {
  root.innerHTML = "";
  const page = el("div", "admin-page");

  // ── Header ───────────────────────────────────────────────────────────────
  const head = el("div", "admin-head");
  const headLeft = el("div", "admin-head-left");
  headLeft.append(el("h1", "", "Klase Admin"));
  const who = el("p", "admin-who");
  who.append(document.createTextNode(me.name + " "), el("span", `badge ${me.role}`, me.role));
  headLeft.append(who);

  const headActions = el("div", "admin-head-actions");
  const game = el("a", "clay-btn", "← Back") as HTMLAnchorElement;
  game.href = "/";
  game.addEventListener("click", (e) => {
    e.preventDefault(); stop();
    document.body.classList.remove("admin-route");
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const signOutBtn = el("button", "clay-btn", "Sign out");
  signOutBtn.addEventListener("click", async () => { stop(); await signOut(); window.location.replace("/admin"); });
  headActions.append(game, signOutBtn);
  head.append(headLeft, headActions);
  page.append(head);

  // ── Global status bar ─────────────────────────────────────────────────────
  const status = el("div", "admin-status");
  page.append(status);
  const notify = (msg: string, bad = false) => {
    status.textContent = msg;
    status.className = bad ? "admin-status bad" : "admin-status";
  };

  // ── Enter As ──────────────────────────────────────────────────────────────
  let picker: LookPickerHandle | null = null;
  const nameInput = el("input", "clay-input") as HTMLInputElement;
  nameInput.maxLength = 24; nameInput.placeholder = DEFAULT_STAFF_NAME;
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
    resetBtn.addEventListener("click", () => { nameInput.value = DEFAULT_STAFF_NAME; });
    const saveBtn = el("button", "clay-btn primary", "Save") as HTMLButtonElement;
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const saved = await persistIdentity();
        who.replaceChildren(document.createTextNode(saved.name + " "), el("span", `badge ${me.role}`, me.role));
        notify("Identity saved.");
      } catch (e) { notify(e instanceof Error ? e.message : "Could not save identity.", true); }
      finally { saveBtn.disabled = false; }
    });
    nameRow.append(nameLab, resetBtn, saveBtn);
    enter.append(nameRow);
    const pickerHost = el("div", "admin-enter-picker neo-picker-frame");
    enter.append(pickerHost);
    picker = mountLookPicker(pickerHost, { look: identity.look, enableWearables: true, persistLook: false });
    page.append(enter);
  }

  // ── Owner-only management sections ───────────────────────────────────────
  if (me.role === "owner") {
    renderAccountsSection(page, token, notify);
    renderPermissionsSection(page, token, notify);
  }

  // ── Centralized online players panel (always visible) ────────────────────
  const playersSection = el("section", "clay admin-section");
  playersSection.append(el("h2", "", "Online Players"));
  playersSection.append(el("p", "admin-lede", "All players currently in any room, updated every few seconds."));
  const playersBody = el("div", "admin-players-central");
  playersSection.append(playersBody);
  page.append(playersSection);

  // ── Rooms panel (tab-based, single card) ─────────────────────────────────
  const roomsSection = el("section", "clay admin-section admin-rooms-section");
  roomsSection.append(el("h2", "", "Classrooms"));

  // Tab strip
  const tabStrip = el("div", "admin-room-tabs");
  const tabPanels: HTMLElement[] = [];
  const tabBtns: HTMLButtonElement[] = [];

  for (let i = 0; i < ROOM_CODES.length; i++) {
    const roomKey = ROOM_CODES[i]!;
    const label = roomKey.replace("klase-", "Classroom ");

    const tabBtn = el("button", "admin-room-tab", label) as HTMLButtonElement;
    tabBtns.push(tabBtn);

    const panel = el("div", "admin-room-panel");
    panel.hidden = i !== 0;
    tabPanels.push(panel);

    tabBtn.addEventListener("click", () => {
      tabBtns.forEach((b, j) => { b.classList.toggle("active", j === i); tabPanels[j]!.hidden = j !== i; });
    });
    tabBtn.classList.toggle("active", i === 0);
    tabStrip.append(tabBtn);
  }

  roomsSection.append(tabStrip);
  for (const panel of tabPanels) roomsSection.append(panel);
  page.append(roomsSection);
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
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) notify(ERRORS[e.code] ?? e.code, true);
      else fail(e);
    }
  };

  const canObserve   = me.role === "owner" || (me.role === "admin" && me.permissions?.can_observe    === true);
  const canLockRooms = me.role === "owner" || (me.role === "admin" && me.permissions?.can_lock_rooms === true);

  // Track which room tab buttons need their lock badge updated without full re-render
  const updatePlayers = (rooms: RoomInfo[]) => {
    // ── Centralized players panel ──
    playersBody.innerHTML = "";
    let anyPlayers = false;
    for (const room of rooms) {
      const visible = room.players.filter((p) => !p.observer);
      if (!visible.length) continue;
      anyPlayers = true;
      const rLabel = room.roomKey.replace("klase-", "Classroom ");
      playersBody.append(el("p", "admin-room-sublabel", rLabel));
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
          if (me.role === "owner") addMod(p.role === "admin" ? "Demote" : "Promote", p.role === "admin" ? "demote" : "promote");
          row.append(mods);
        }
        playersBody.append(row);
      }
    }
    if (!anyPlayers) playersBody.append(el("p", "admin-empty", "No players online."));

    // ── Room panels (tab content) — rebuild only when structure changes ──
    rooms.forEach((room, i) => {
      const panel = tabPanels[i];
      const tabBtn = tabBtns[i];
      if (!panel || !tabBtn) return;

      const rLabel = room.roomKey.replace("klase-", "Classroom ");
      const visible = room.players.filter((p) => !p.observer);

      // Update tab button label + lock indicator
      tabBtn.textContent = rLabel + (room.locked ? " 🔒" : "");

      // Avoid full re-render if panel already built — only refresh the player list part
      const existingPanelKey = panel.dataset.roomKey;
      const existingLocked = panel.dataset.locked;
      const existingCount = panel.dataset.playerCount;
      const newCount = String(visible.length);

      if (
        existingPanelKey === room.roomKey &&
        existingLocked === String(room.locked) &&
        existingCount === newCount
      ) return; // nothing changed — don't re-render, inputs stay safe

      panel.dataset.roomKey = room.roomKey;
      panel.dataset.locked = String(room.locked);
      panel.dataset.playerCount = newCount;
      panel.innerHTML = "";

      // ── Room meta ──
      const meta = el("div", "admin-room-meta");
      const lockBadge = room.locked ? el("span", "badge warn", "🔒 locked") : null;
      if (lockBadge) meta.append(lockBadge);
      meta.append(el("span", "admin-room-count", `${visible.length} online · ${room.regulars}/${room.regularCap} seats`));
      panel.append(meta);

      // ── Action buttons ──
      const actions = el("div", "admin-room-actions");
      const enterBtn = el("button", "clay-btn primary", "Enter room");
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
        const lockBtn = el("button", "clay-btn", room.locked ? "🔓 Unlock" : "🔒 Lock") as HTMLButtonElement;
        lockBtn.addEventListener("click", async () => {
          lockBtn.disabled = true;
          try {
            await api("/api/admin/room-config", token, { roomKey: room.roomKey, locked: !room.locked });
            notify(room.locked ? `${rLabel} unlocked.` : `${rLabel} locked.`);
          } catch (e) {
            notify(e instanceof ApiError ? (ERRORS[e.code] ?? e.code) : "Failed.", true);
            lockBtn.disabled = false;
          }
        });
        actions.append(lockBtn);
      }

      if (canLockRooms) {
        const wlBtn = el("button", "clay-btn", "📋 Whitelist");
        wlBtn.addEventListener("click", () => openWhitelistModal(room.roomKey, token, me, notify));
        actions.append(wlBtn);
      }

      panel.append(actions);

      // ── Moderation toolbar ──
      const tools = el("div", "admin-mod-tools");
      const targetsOf = (): ModTarget[] =>
        visible.map((p) => ({ id: p.sessionId, name: p.name, role: p.role, serverMuted: p.serverMuted, observer: p.observer }));
      renderModerationToolbar(tools, {
        role: me.role, actorName: me.name,
        getPlayers: targetsOf,
        onSubmit: (payload) => void submit(room.roomKey, payload),
      });
      panel.append(tools);
    });
  };

  async function refresh() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const { rooms } = await api<{ rooms: RoomInfo[] }>("/api/admin/rooms", token);
      rooms.sort((a, b) => ROOM_CODES.indexOf(a.roomKey as never) - ROOM_CODES.indexOf(b.roomKey as never));
      if (!stopped) {
        updatePlayers(rooms);
        if (pollFailed) { pollFailed = false; notify(""); }
      }
    } catch (e) { pollFailed = true; fail(e); }
    finally { inFlight = false; }
  }

  const schedule = () => {
    window.clearTimeout(timer);
    if (stopped) return;
    timer = window.setTimeout(async () => {
      if (document.visibilityState === "visible") await refresh();
      schedule();
    }, POLL_MS);
  };
  function onVisible() { if (document.visibilityState === "visible") void refresh(); }
  document.addEventListener("visibilitychange", onVisible);

  notify("Loading…");
  void refresh().then(() => { if (status.textContent === "Loading…") notify(""); });
  schedule();
}
