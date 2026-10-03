import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Look, Role } from "@klase/shared";

export type Profile = {
  id: string;
  display_name: string;
  role: Role;
  hat: string;
  top: string;
  accessory: string;
  banned: boolean;
};

let admin: SupabaseClient | null | undefined;

export function supabaseEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  let url = process.env.SUPABASE_URL?.trim();
  try {
    // Accept a pasted ".../rest/v1/" by reducing to the project root.
    if (url) url = new URL(url).origin;
  } catch {
    url = undefined;
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  admin = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return admin;
}

export async function userFromToken(accessToken: string): Promise<User | null> {
  const sb = getAdmin();
  if (!sb || !accessToken) return null;
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user;
}

export async function loadProfile(userId: string): Promise<Profile | null> {
  const sb = getAdmin();
  if (!sb) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error || !data) return null;
  return data as Profile;
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
  const { data, error } = await sb
    .from("profiles")
    .select("id, display_name, role")
    .in("role", ["owner", "admin"]);
  if (error || !data) return [];
  const rows = data as { id: string; display_name: string }[];
  const envOwner = ownerUserId();
  if (envOwner && !rows.some((r) => r.id === envOwner)) {
    const p = await loadProfile(envOwner);
    if (p) rows.push({ id: p.id, display_name: p.display_name });
  }
  return rows;
}

export function ownerUserId() {
  return (process.env.KLASE_OWNER_USER_ID ?? "").trim();
}

export function ownerEmail() {
  return (process.env.KLASE_OWNER_EMAIL ?? "").trim().toLowerCase();
}

export function roleForAccount(user: User, profile: Profile | null): Role {
  if (ownerUserId() && user.id === ownerUserId()) return "owner";
  // Only trust the email when the provider verified it (Google always does).
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
