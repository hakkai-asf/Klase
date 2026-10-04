import { ServerError } from "@colyseus/core";
import { DEFAULT_STAFF_NAME, type Look, type Role } from "@klase/shared";
import { isCleanDisplayName, sanitizeDisplayName } from "./chatFilter.js";
import { recordDeniedAttempt, recordStaffSuccess } from "./adminLockout.js";
import { findHold, findHoldMemory, holdToNotice } from "./moderationHold.js";
import {
  loadPrivilegedProfiles,
  loadProfile,
  ownerEmail,
  ownerUserId,
  roleForAccount,
  supabaseConfigured,
  supabaseEnabled,
  syncOwnerRole,
  userFromToken,
} from "./supabase.js";

const banned = new Set<string>();
const admins = new Set(
  (process.env.KLASE_ADMIN_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function ownerName() {
  return (process.env.KLASE_OWNER_NAME ?? "Hakkai").trim();
}

export function resolveGuestRole(name: string): Role {
  if (supabaseEnabled()) return "user";
  const n = name.trim().toLowerCase();
  if (n === ownerName().toLowerCase()) return "owner";
  if (admins.has(n)) return "admin";
  return "user";
}

export function isBannedGuest(name: string, sessionHint: string) {
  return banned.has(name.trim().toLowerCase()) || banned.has(sessionHint);
}

export function banName(name: string) {
  banned.add(name.trim().toLowerCase());
}


// ---------------------------------------------------------------------------
// Reserved names: an owner's / admin's real (display) name cannot be used by
// anyone without that role. Comparison is case-insensitive and ignores
// whitespace / zero-width / control characters ("Hak kai", "hakkai\u200b").
// Only enforced when Supabase is configured; in guest-dev mode the owner *is*
// whoever types KLASE_OWNER_NAME.
// ---------------------------------------------------------------------------
export function canonicalName(name: string) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, "")
    .toLowerCase();
}

function readToken(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** Reasons only — never email, token, or user id. */
function describeStaffDecision(
  tag: "identity" | "admin",
  detail: string,
  user: { email?: string | null; email_confirmed_at?: string | null; id?: string } | null,
  profileRole: string | undefined,
  role: Role | "none",
) {
  const emailSet = Boolean(ownerEmail());
  const idSet = Boolean(ownerUserId());
  const emailConfirmed = Boolean(user?.email_confirmed_at);
  const emailMatch = Boolean(user) && emailSet && emailConfirmed && (user?.email ?? "").toLowerCase() === ownerEmail();
  const idMatch = Boolean(user?.id) && idSet && user?.id === ownerUserId();
  return `[${tag}] ${detail} role=${role} profile=${profileRole ?? "none"} ownerIdEnv=${idSet} ownerEmailEnv=${emailSet} emailConfirmed=${emailConfirmed} emailMatch=${emailMatch} idMatch=${idMatch}`;
}

type ReservedEntry = { userId: string };
const RESERVED_TTL_MS = 15_000;
let reservedCache: { at: number; map: Map<string, ReservedEntry[]> } | null = null;
/** Owners/admins seen this process lifetime (covers env-only owners with no DB role). */
const seenPrivileged = new Map<string, ReservedEntry[]>();

function addReserved(map: Map<string, ReservedEntry[]>, name: string, userId: string) {
  const key = canonicalName(name);
  if (!key) return;
  const list = map.get(key) ?? [];
  if (!list.some((e) => e.userId === userId)) list.push({ userId });
  map.set(key, list);
}

/** Call when an owner/admin identity is resolved or a user is promoted. */
export function rememberPrivileged(name: string, userId: string) {
  addReserved(seenPrivileged, name, userId);
  reservedCache = null;
}

export function invalidateReservedNames() {
  reservedCache = null;
}

function reservedNamesLocal() {
  const map = new Map<string, ReservedEntry[]>();
  addReserved(map, ownerName(), "");
  for (const a of admins) addReserved(map, a, "");
  for (const [key, list] of seenPrivileged) map.set(key, [...(map.get(key) ?? []), ...list]);
  return map;
}

async function reservedNames() {
  if (reservedCache && Date.now() - reservedCache.at < RESERVED_TTL_MS) return reservedCache.map;
  const map = reservedNamesLocal();
  for (const row of await loadPrivilegedProfiles()) addReserved(map, row.display_name, row.id);
  reservedCache = { at: Date.now(), map };
  return map;
}

function isReservedNameLocal(name: string) {
  return Boolean(reservedNamesLocal().get(canonicalName(name))?.length);
}

/** True if `name` belongs to an owner/admin other than `exceptUserId`. */
export async function isReservedName(name: string, exceptUserId = "") {
  const entries = (await reservedNames()).get(canonicalName(name));
  if (!entries) return false;
  return entries.some((e) => !exceptUserId || e.userId !== exceptUserId);
}

/** Rename check for players already in a room. Owners/admins may use any name. */
export async function canUseName(role: Role, name: string, userId: string) {
  if (!supabaseEnabled() || role !== "user") return true;
  return !(await isReservedName(name, userId));
}

export type Identity = {
  name: string;
  role: Role;
  look: Look;
  userId: string;
  /** Verified owner entering a room in god mode (no capacity checks, silent, invisible). */
  god: boolean;
};

// This function is async because it performs I/O operations (fetching user token & profile)
export async function resolveIdentity(options: {
  name?: string;
  hat?: string;
  top?: string;
  accessory?: string;
  body?: string;
  accessToken?: string;
  god?: boolean;
  /** Dashboard / /room staff join. Regular landing must not set this. */
  staffJoin?: boolean;
}): Promise<Identity> {
  const guestLook: Look = {
    hat: String(options?.hat ?? ""),
    top: String(options?.top ?? ""),
    accessory: String(options?.accessory ?? ""),
    body: options?.body === "y" ? "y" : "x",
  };
  const guestName = sanitizeDisplayName(String(options?.name ?? "")) || "Guest";
  if (!isCleanDisplayName(guestName)) throw new ServerError(400, "BAD_NAME");
  const wantsGod = options?.god === true;
  const staffJoin = options?.staffJoin === true;
  const token = readToken(options?.accessToken);

  if (token && !supabaseConfigured()) {
    if (staffJoin || wantsGod) {
      console.warn("[identity] staff/god rejected: supabase not configured on server");
      throw new ServerError(401, "AUTH");
    }
    console.warn("[identity] access token present but Supabase is not configured; joining as guest");
  }

  if (token && supabaseConfigured()) {
    let user: Awaited<ReturnType<typeof userFromToken>> = null;
    try {
      user = await userFromToken(token);
    } catch (e) {
      console.error("[identity] userFromToken threw:", e instanceof Error ? e.message : e);
    }
    if (!user) {
      if (staffJoin || wantsGod) {
        console.warn("[identity] staff/god rejected: token not verified");
        throw new ServerError(401, "AUTH");
      }
      console.warn("[identity] token not verified; joining as guest");
    } else {
    // Suspends execution while fetching the user's profile
    const profile = await loadProfile(user.id);
    if (profile?.banned) throw new ServerError(403, "BANNED");
    const role = roleForAccount(user, profile);
    syncOwnerRole(user.id, role, profile);
    if (wantsGod && role !== "owner") {
      console.warn(describeStaffDecision("identity", "god rejected", user, profile?.role, role));
      throw new ServerError(403, "NO_PERMISSION");
    }
    if (staffJoin && role !== "owner" && role !== "admin") {
      console.warn(describeStaffDecision("identity", "staffJoin as non-staff", user, profile?.role, role));
    }
    let name: string;
    let look: Look;
    if ((role === "owner" || role === "admin") && staffJoin) {
      // Dashboard "Enter as" name/look. Role still comes from the verified account, never the name.
      const requested = sanitizeDisplayName(String(options?.name ?? ""));
      if (requested && !isCleanDisplayName(requested)) throw new ServerError(400, "BAD_NAME");
      name = requested || DEFAULT_STAFF_NAME;
      look = guestLook;
      rememberPrivileged(name, user.id);
    } else if (role === "owner" || role === "admin") {
      name = sanitizeDisplayName(profile?.display_name || guestName) || DEFAULT_STAFF_NAME;
      if (!isCleanDisplayName(name)) name = DEFAULT_STAFF_NAME;
      look = profile
        ? { hat: profile.hat, top: profile.top, accessory: profile.accessory, body: guestLook.body }
        : guestLook;
      rememberPrivileged(name, user.id);
    } else {
      // Signed-in regulars keep the saved profile name so a second tab cannot become the Google full name.
      name = sanitizeDisplayName(profile?.display_name || guestName) || guestName;
      if (!isCleanDisplayName(name)) name = `Student ${user.id.replace(/-/g, "").slice(0, 4)}`;
      try {
        if (await isReservedName(name, user.id)) {
          name = `Student ${user.id.replace(/-/g, "").slice(0, 4)}`;
        }
      } catch (e) {
        console.error("[identity] reserved-name check threw:", e instanceof Error ? e.message : e);
      }
      look = profile
        ? { hat: profile.hat, top: profile.top, accessory: profile.accessory, body: guestLook.body }
        : guestLook;
    }
    const hold = await findHold(user.id, name);
    if (hold) throw new ServerError(403, JSON.stringify({ error: "HELD", notice: holdToNotice(hold) }));
    return {
      name,
      role,
      look,
      userId: user.id,
      god: wantsGod,
    };
    }
  }

  if (wantsGod) throw new ServerError(403, "NO_PERMISSION");
  if (isBannedGuest(guestName, "")) throw new ServerError(403, "BANNED");
  const guestHold = findHoldMemory("", guestName);
  if (guestHold) throw new ServerError(403, JSON.stringify({ error: "HELD", notice: holdToNotice(guestHold) }));
  if (isReservedNameLocal(guestName)) throw new ServerError(409, "NAME_RESERVED");
  // Fast-path for guests, no await required
  return {
    name: guestName,
    role: resolveGuestRole(guestName),
    look: guestLook,
    userId: "",
    god: false,
  };
}

/**
 * Authenticate an owner/admin from a Supabase access token (used by /api/admin/*).
 * Looks the role up server-side on every call; the client's claim is never trusted.
 */
export async function resolveStaff(accessToken: string): Promise<{ userId: string; name: string; role: Role }> {
  if (!supabaseEnabled()) {
    console.warn("[admin] rejected: AUTH_DISABLED supabaseConfigured=false");
    throw new ServerError(503, "AUTH_DISABLED");
  }
  const user = await userFromToken(accessToken);
  if (!user) {
    console.warn("[admin] rejected: token not verified");
    throw new ServerError(401, "AUTH");
  }
  const profile = await loadProfile(user.id);
  if (profile?.banned) {
    console.warn("[admin] rejected: banned");
    throw new ServerError(403, "BANNED");
  }
  const role = roleForAccount(user, profile);
  syncOwnerRole(user.id, role, profile);
  if (role !== "owner" && role !== "admin") {
    console.warn(describeStaffDecision("admin", "denied", user, profile?.role, role));
    const state = await recordDeniedAttempt(user.id);
    if (state.locked) throw new AdminLockedError(state.retryAfterSec);
    throw new AdminDeniedError(state.attemptsLeft);
  }
  // Recognised staff are never blocked by the guard; this also clears any earlier strikes.
  await recordStaffSuccess(user.id);
  return { userId: user.id, name: profile?.display_name || "Admin", role };
}

export class AdminLockedError extends ServerError {
  constructor(public retryAfterSec: number) {
    super(429, "ADMIN_LOCKED");
  }
}

export class AdminDeniedError extends ServerError {
  constructor(public attemptsLeft: number) {
    super(403, "NO_PERMISSION");
  }
}

export function assertCanModerate(actorRole: Role, targetRole: Role, action: string) {
  if (actorRole === "user") {
    throw new ServerError(403, "NO_PERMISSION");
  }
  if (targetRole === "owner") {
    throw new ServerError(403, "IMMUNE");
  }
  if (actorRole === "admin" && targetRole === "admin") {
    throw new ServerError(403, "ADMIN_VS_ADMIN");
  }
  if (action === "promote" || action === "demote") {
    if (actorRole !== "owner") throw new ServerError(403, "NO_PERMISSION");
  }
}
