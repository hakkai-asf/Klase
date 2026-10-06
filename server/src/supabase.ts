import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { Look, Role } from "@klase/shared";

export type Profile = {
  id: string;
  display_name: string;
  role: Role;
  hat: string;
  top: string;
  accessory: string;
  body?: string;
  banned: boolean;
};

let admin: SupabaseClient | null | undefined;

/** Env vars are set. Does not construct a client (guest join must not touch Supabase). */
export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/** True when accounts are configured. Safe for guest paths — no client is created. */
export function supabaseEnabled() {
  return supabaseConfigured();
}

/**
 * Lazy service-role client. Node 20 has no global WebSocket; supabase-js realtime
 * requires one at construct time (@supabase/realtime-js WebSocketFactory).
 * Guests never call this.
 */
export function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  if (!supabaseConfigured()) {
    admin = null;
    return null;
  }
  let url = process.env.SUPABASE_URL?.trim();
  try {
    if (url) url = new URL(url).origin;
  } catch {
    url = undefined;
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    admin = null;
    return null;
  }
  try {
    const g = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
    if (typeof g.WebSocket === "undefined") g.WebSocket = WebSocket as unknown as typeof g.WebSocket;
    admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
    });
  } catch (e) {
    console.error("[supabase] createClient failed:", e instanceof Error ? e.message : e);
    admin = null;
  }
  return admin;
}

export async function userFromToken(accessToken: string): Promise<User | null> {
  const sb = getAdmin();
  if (!sb || !accessToken) return null;
  try {
    const { data, error } = await sb.auth.getUser(accessToken);
    if (error || !data.user) return null;
    return data.user;
  } catch (e) {
    console.error("[auth] getUser threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function loadProfile(userId: string): Promise<Profile | null> {
  const sb = getAdmin();
  if (!sb || !userId) return null;
  try {
    const res = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (res.error || !res.data) return null;
    return res.data as Profile;
  } catch (e) {
    console.error("[profiles] load threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function saveLook(userId: string, look: Look, displayName?: string) {
  const sb = getAdmin();
  if (!sb) return;
  await sb
    .from("profiles")
    .update({
      hat: look.hat,
      top: look.top,
      accessory: look.accessory,
      body: look.body,
      ...(displayName ? { display_name: displayName } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
}

export async function setBanned(userId: string, banned: boolean) {
  const sb = getAdmin();
  if (!sb || !userId) return;
  await sb.from("profiles").update({ banned, updated_at: new Date().toISOString() }).eq("id", userId);
}

export async function setRole(userId: string, role: Role) {
  const sb = getAdmin();
  if (!sb || !userId) return;
  await sb.from("profiles").update({ role, updated_at: new Date().toISOString() }).eq("id", userId);
}

/** Display names of every owner/admin account (plus the env-configured owner id). */
export async function loadPrivilegedProfiles(): Promise<{ id: string; display_name: string }[]> {
  const sb = getAdmin();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("profiles")
      .select("id, display_name, role")
      .in("role", ["owner", "admin"]);
    if (error || !data) {
      if (error) console.error("[profiles] privileged list failed:", error.message);
      return [];
    }
    const rows = (data as { id: string; display_name?: string }[])
      .filter((r) => r?.id)
      .map((r) => ({ id: r.id, display_name: String(r.display_name ?? "") }));
    const envOwner = ownerUserId();
    if (envOwner && !rows.some((r) => r.id === envOwner)) {
      const p = await loadProfile(envOwner);
      if (p) rows.push({ id: p.id, display_name: String(p.display_name ?? "") });
    }
    return rows;
  } catch (e) {
    console.error("[profiles] privileged list threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

export function ownerUserId() {
  return (process.env.KLASE_OWNER_USER_ID ?? "").trim();
}

export function ownerEmail() {
  return (process.env.KLASE_OWNER_EMAIL ?? "").trim().toLowerCase();
}

export function roleForAccount(user: User, profile: Profile | null): Role {
  if (ownerUserId() && user.id === ownerUserId()) return "owner";
  if (ownerEmail() && user.email_confirmed_at && (user.email ?? "").toLowerCase() === ownerEmail()) {
    return "owner";
  }
  return profile?.role ?? "user";
}

/**
 * RLS decides "owner" from profiles.role, but the env vars are the source of truth on the
 * server. Keep the two in agreement so the owner's RLS policies actually apply.
 */
export function syncOwnerRole(userId: string, role: Role, profile: Profile | null) {
  if (role === "owner" && profile && profile.role !== "owner") void setRole(userId, "owner");
}

// ---------------------------------------------------------------------------
// Admin permissions
// ---------------------------------------------------------------------------

export type AdminPermissions = {
  user_id: string;
  can_observe: boolean;
  can_lock_rooms: boolean;
  can_blacklist: boolean;
  can_announce: boolean;
};

const DEFAULT_PERMS: Omit<AdminPermissions, "user_id"> = {
  can_observe: false,
  can_lock_rooms: false,
  can_blacklist: false,
  can_announce: false,
};

export async function loadAdminPermissions(userId: string): Promise<AdminPermissions> {
  const sb = getAdmin();
  if (!sb || !userId) return { user_id: userId, ...DEFAULT_PERMS };
  try {
    const { data, error } = await sb.from("admin_permissions").select("*").eq("user_id", userId).maybeSingle();
    if (error || !data) return { user_id: userId, ...DEFAULT_PERMS };
    const r = data as AdminPermissions;
    return {
      user_id: userId,
      can_observe: Boolean(r.can_observe),
      can_lock_rooms: Boolean(r.can_lock_rooms),
      can_blacklist: Boolean(r.can_blacklist),
      can_announce: Boolean(r.can_announce),
    };
  } catch (e) {
    console.error("[admin-permissions] load threw:", e instanceof Error ? e.message : e);
    // Fail closed: deny all on error
    return { user_id: userId, ...DEFAULT_PERMS };
  }
}

export async function loadAllAdminPermissions(): Promise<AdminPermissions[]> {
  const sb = getAdmin();
  if (!sb) return [];
  try {
    const { data, error } = await sb.from("admin_permissions").select("*");
    if (error || !data) return [];
    return (data as AdminPermissions[]).map((r) => ({
      user_id: r.user_id,
      can_observe: Boolean(r.can_observe),
      can_lock_rooms: Boolean(r.can_lock_rooms),
      can_blacklist: Boolean(r.can_blacklist),
      can_announce: Boolean(r.can_announce),
    }));
  } catch (e) {
    console.error("[admin-permissions] loadAll threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function upsertAdminPermissions(userId: string, perms: Partial<Omit<AdminPermissions, "user_id">>): Promise<void> {
  const sb = getAdmin();
  if (!sb || !userId) return;
  await sb.from("admin_permissions").upsert({
    user_id: userId,
    ...perms,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
}

export async function ensureAdminPermissionsRow(userId: string): Promise<void> {
  const sb = getAdmin();
  if (!sb || !userId) return;
  await sb.from("admin_permissions").upsert(
    { user_id: userId, ...DEFAULT_PERMS, updated_at: new Date().toISOString() },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
}

// ---------------------------------------------------------------------------
// Room config
// ---------------------------------------------------------------------------

export type RoomConfig = {
  room_key: string;
  locked: boolean;
  whitelist_mode: boolean;
};

export async function loadRoomConfig(roomKey: string): Promise<RoomConfig> {
  const sb = getAdmin();
  if (!sb) return { room_key: roomKey, locked: false, whitelist_mode: false };
  try {
    const { data, error } = await sb.from("room_config").select("*").eq("room_key", roomKey).maybeSingle();
    if (error || !data) return { room_key: roomKey, locked: false, whitelist_mode: false };
    const r = data as RoomConfig;
    return { room_key: roomKey, locked: Boolean(r.locked), whitelist_mode: Boolean(r.whitelist_mode) };
  } catch (e) {
    console.error("[room-config] load threw:", e instanceof Error ? e.message : e);
    return { room_key: roomKey, locked: false, whitelist_mode: false };
  }
}

export async function loadAllRoomConfigs(): Promise<RoomConfig[]> {
  const sb = getAdmin();
  if (!sb) return [];
  try {
    const { data, error } = await sb.from("room_config").select("*");
    if (error || !data) return [];
    return (data as RoomConfig[]).map((r) => ({
      room_key: r.room_key,
      locked: Boolean(r.locked),
      whitelist_mode: Boolean(r.whitelist_mode),
    }));
  } catch (e) {
    console.error("[room-config] loadAll threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function setRoomLocked(roomKey: string, locked: boolean): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  await sb.from("room_config").upsert(
    { room_key: roomKey, locked, updated_at: new Date().toISOString() },
    { onConflict: "room_key" },
  );
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

export type WhitelistEntry = {
  id: string;
  room_key: string;
  user_id: string | null;
  passcode: string | null;
  label: string;
  single_use: boolean;
  consumed: boolean;
  expires_at: string | null;
  added_by: string | null;
  created_at: string;
};

export async function loadWhitelistForRoom(roomKey: string): Promise<WhitelistEntry[]> {
  const sb = getAdmin();
  if (!sb) return [];
  try {
    const { data, error } = await sb.from("whitelist").select("*").eq("room_key", roomKey);
    if (error || !data) return [];
    return data as WhitelistEntry[];
  } catch (e) {
    console.error("[whitelist] loadForRoom threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function checkWhitelistEntry(
  roomKey: string,
  userId: string | null,
  passcode: string | null,
): Promise<{ allowed: boolean; consumeId?: string; reason?: "consumed" | "expired" }> {
  const sb = getAdmin();
  // Fail closed: deny on DB unavailability
  if (!sb) return { allowed: false };
  try {
    const now = new Date().toISOString();
    // Check by userId
    if (userId) {
      const { data } = await sb
        .from("whitelist")
        .select("id, single_use, consumed, expires_at")
        .eq("room_key", roomKey)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (data) {
        const row = data as { id: string; single_use: boolean; consumed: boolean; expires_at: string | null };
        if (row.consumed) return { allowed: false, reason: "consumed" };
        if (row.expires_at && row.expires_at <= now) return { allowed: false, reason: "expired" };
        return { allowed: true };
      }
    }
    // Check by passcode
    if (passcode) {
      const { data } = await sb
        .from("whitelist")
        .select("id, single_use, consumed, expires_at")
        .eq("room_key", roomKey)
        .eq("passcode", passcode)
        .limit(1)
        .maybeSingle();
      if (data) {
        const row = data as { id: string; single_use: boolean; consumed: boolean; expires_at: string | null };
        if (row.consumed) return { allowed: false, reason: "consumed" };
        if (row.expires_at && row.expires_at <= now) return { allowed: false, reason: "expired" };
        return { allowed: true, consumeId: row.single_use ? row.id : undefined };
      }
    }
    return { allowed: false };
  } catch (e) {
    console.error("[whitelist] check threw:", e instanceof Error ? e.message : e);
    return { allowed: false };
  }
}

export async function consumeWhitelistEntry(id: string): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  await sb.from("whitelist").update({ consumed: true }).eq("id", id);
}

export async function addWhitelistEntry(entry: Omit<WhitelistEntry, "id" | "created_at" | "consumed">): Promise<WhitelistEntry | null> {
  const sb = getAdmin();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("whitelist")
      .insert({ ...entry, consumed: false })
      .select()
      .single();
    if (error) { console.error("[whitelist] insert failed:", error.message); return null; }
    return data as WhitelistEntry;
  } catch (e) {
    console.error("[whitelist] insert threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function removeWhitelistEntry(id: string): Promise<boolean> {
  const sb = getAdmin();
  if (!sb) return false;
  try {
    const { data, error } = await sb.from("whitelist").delete().eq("id", id).select("id");
    if (error) { console.error("[whitelist] delete failed:", error.message); return false; }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error("[whitelist] delete threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account search (owner only — uses service role, no RLS restrictions)
// ---------------------------------------------------------------------------

export type AccountSearchResult = {
  id: string;
  display_name: string;
  role: Role;
  banned: boolean;
};

export async function searchAccounts(query: string, limit = 20): Promise<AccountSearchResult[]> {
  const sb = getAdmin();
  if (!sb) return [];
  try {
    const q = query.trim();
    let req = sb.from("profiles").select("id, display_name, role, banned").order("display_name").limit(limit);
    if (q) req = req.ilike("display_name", `%${q}%`);
    const { data, error } = await req;
    if (error || !data) return [];
    return (data as AccountSearchResult[]).map((r) => ({
      id: r.id,
      display_name: String(r.display_name ?? ""),
      role: (["owner", "admin", "user"].includes(r.role) ? r.role : "user") as Role,
      banned: Boolean(r.banned),
    }));
  } catch (e) {
    console.error("[accounts] search threw:", e instanceof Error ? e.message : e);
    return [];
  }
}
