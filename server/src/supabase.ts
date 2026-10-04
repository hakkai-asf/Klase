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
