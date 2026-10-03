import { DEFAULT_STAFF_NAME, normalizeLook, type Look } from "@klase/shared";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

/** Project root only. A pasted ".../rest/v1/" would send OAuth to PostgREST ("No API key found"). */
function projectOrigin(raw: string | undefined) {
  try {
    return raw ? new URL(raw.trim()).origin : undefined;
  } catch {
    return undefined;
  }
}

/** True for service_role JWTs and sb_secret_ keys, which must never ship in a browser bundle. */
function isSecretKey(key: string) {
  if (key.startsWith("sb_secret_")) return true;
  try {
    const part = key.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return (JSON.parse(json) as { role?: string }).role === "service_role";
  } catch {
    return false;
  }
}

const url = projectOrigin(import.meta.env.VITE_SUPABASE_URL as string | undefined);
const rawAnon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
const anon = rawAnon && !isSecretKey(rawAnon) ? rawAnon : undefined;
if (rawAnon && !anon) {
  console.error(
    "VITE_SUPABASE_ANON_KEY is a service_role/secret key. Refusing to use it in the browser; paste the anon/publishable key instead.",
  );
}

/** Where Supabase sends the browser back to after Google. Must be in the Supabase redirect allow-list. */
export const AUTH_CALLBACK_PATH = "/auth/callback";
const NEXT_KEY = "klase-post-auth";

let client: SupabaseClient | null = null;

export function authEnabled() {
  return Boolean(url && anon);
}

export function supabase() {
  if (!authEnabled()) return null;
  if (!client) {
    client = createClient(url!, anon!, {
      auth: {
        // PKCE: the redirect carries a one-time ?code= instead of tokens in the URL fragment.
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
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

/**
 * Start the Google OAuth redirect. `next` is where to land once the session exists
 * ("/" joins the game, "/admin" opens the dashboard). Only same-site paths are accepted.
 */
export async function signInWithGoogle(next = "/") {
  const sb = supabase();
  if (!sb) throw new Error("Auth is not configured");
  sessionStorage.setItem(NEXT_KEY, safeNext(next));
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}`,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) {
    sessionStorage.removeItem(NEXT_KEY);
    throw error;
  }
}

function safeNext(next: string) {
  // Same-origin absolute paths only; blocks "//evil.com" and "https://…" open redirects.
  return /^\/(?!\/)/.test(next) ? next : "/";
}

/**
 * Runs on /auth/callback. supabase-js (detectSessionInUrl) exchanges the ?code= for a session
 * during client init; we wait for that, surface any provider error, then clean the URL.
 */
export async function completeOAuthCallback(): Promise<{ next: string; error: string }> {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const providerError =
    params.get("error_description") || hash.get("error_description") || params.get("error") || hash.get("error") || "";

  const next = safeNext(sessionStorage.getItem(NEXT_KEY) ?? "/");
  sessionStorage.removeItem(NEXT_KEY);

  let error = providerError;
  if (!error) {
    const sb = supabase();
    if (!sb) {
      error = "Auth is not configured";
    } else {
      // getSession() awaits the client's initialisation, which includes the code exchange.
      const { data, error: sessionError } = await sb.auth.getSession();
      if (sessionError) error = sessionError.message;
      else if (!data.session) error = "Google sign-in did not complete. Please try again.";
    }
  }
  window.history.replaceState({}, "", next);
  return { next, error };
}

export async function signOut() {
  const sb = supabase();
  // Local scope: end this browser's session only, not the account's sessions on other devices.
  if (sb) await sb.auth.signOut({ scope: "local" });
}

export async function loadSavedLook(): Promise<{ name: string; look: Look } | null> {
  const sb = supabase();
  const session = await currentSession();
  if (!sb || !session) return null;
  const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (!data) {
    return {
      name:
        (session.user.user_metadata?.display_name as string) ||
        (session.user.user_metadata?.full_name as string) ||
        session.user.email ||
        "Student",
      look: { hat: "", top: "", accessory: "", body: "x" },
    };
  }
  return {
    name: data.display_name || "Student",
    look: { hat: data.hat ?? "", top: data.top ?? "", accessory: data.accessory ?? "", body: "x" },
  };
}

const STAFF_IDENTITY_KEY = "klase-staff-identity";

export type StaffIdentity = { name: string; look: Look };

function parseStaffIdentity(raw: string | null): StaffIdentity | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { name?: string; look?: Partial<Look> };
    const name = String(o?.name ?? "").trim();
    return { name: name || DEFAULT_STAFF_NAME, look: normalizeLook(o?.look) };
  } catch {
    return null;
  }
}

/** Owner/admin "Enter as" identity. Default name is always Hakkai until something is saved. */
export async function loadStaffIdentity(): Promise<StaffIdentity> {
  const local = parseStaffIdentity(localStorage.getItem(STAFF_IDENTITY_KEY));
  if (local) return local;
  const saved = await loadSavedLook();
  return { name: DEFAULT_STAFF_NAME, look: normalizeLook(saved?.look ?? null) };
}

export async function saveStaffIdentity(name: string, look: Look): Promise<StaffIdentity> {
  const identity: StaffIdentity = {
    name: String(name ?? "").trim().slice(0, 24) || DEFAULT_STAFF_NAME,
    look: normalizeLook(look),
  };
  localStorage.setItem(STAFF_IDENTITY_KEY, JSON.stringify(identity));
  const sb = supabase();
  const session = await currentSession();
  if (sb && session) {
    const { error } = await sb
      .from("profiles")
      .update({
        display_name: identity.name,
        hat: identity.look.hat,
        top: identity.look.top,
        accessory: identity.look.accessory,
      })
      .eq("id", session.user.id);
    if (error) console.warn("Could not save staff identity to profile", error.message);
  }
  return identity;
}
