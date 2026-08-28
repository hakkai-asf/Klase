import type { Look } from "@klase/shared";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

export function authEnabled() {
  return Boolean(url && anon);
}

export function supabase() {
  if (!authEnabled()) return null;
  if (!client) client = createClient(url!, anon!);
  return client;
}

export async function currentSession(): Promise<Session | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string) {
  const sb = supabase();
  if (!sb) throw new Error("Auth is not configured");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string, displayName: string) {
  const sb = supabase();
  if (!sb) throw new Error("Auth is not configured");
  const { error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
}

export async function loadSavedLook(): Promise<{ name: string; look: Look } | null> {
  const sb = supabase();
  const session = await currentSession();
  if (!sb || !session) return null;
  const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (!data) {
    return {
      name: (session.user.user_metadata?.display_name as string) || session.user.email || "Student",
      look: { hat: "", top: "", accessory: "", body: "x" },
    };
  }
  return {
    name: data.display_name || "Student",
    look: { hat: data.hat ?? "", top: data.top ?? "", accessory: data.accessory ?? "", body: "x" },
  };
}
