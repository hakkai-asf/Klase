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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

export function ownerUserId() {
  return (process.env.KLASE_OWNER_USER_ID ?? "").trim();
}

export function ownerEmail() {
  return (process.env.KLASE_OWNER_EMAIL ?? "").trim().toLowerCase();
}

export function roleForAccount(user: User, profile: Profile | null): Role {
  if (ownerUserId() && user.id === ownerUserId()) return "owner";
  if (ownerEmail() && (user.email ?? "").toLowerCase() === ownerEmail()) return "owner";
  return profile?.role ?? "user";
}
