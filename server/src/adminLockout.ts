import { getAdmin } from "./supabase.js";

/**
 * /admin brute-force guard, keyed by authenticated user id (never IP, never browser state).
 * Source of truth is public.admin_attempts (docs/supabase.sql). If that table/function is
 * missing we fall back to process memory and warn once, so /admin keeps working but the
 * lock then resets on a server restart.
 */
export const MAX_FAILED_ATTEMPTS = 3;
export const LOCKOUT_MINUTES = 30;

export type DenyState =
  | { locked: true; retryAfterSec: number }
  | { locked: false; attemptsLeft: number };

type Row = { failed_count: number; locked_until: string | null };

const memory = new Map<string, { count: number; lockedUntil: number }>();
const cleanUntil = new Map<string, number>(); // staff recently confirmed clean -> skip DB reads
const CLEAN_TTL_MS = 5 * 60_000;
let warned = false;

function warnFallback(why: string) {
  if (warned) return;
  warned = true;
  console.warn(`[admin-lockout] using in-memory fallback (${why}). Run the admin_attempts block in docs/supabase.sql.`);
}

function remainingSec(lockedUntilMs: number) {
  return Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000));
}

function memoryStrike(userId: string): DenyState {
  const m = memory.get(userId) ?? { count: 0, lockedUntil: 0 };
  if (m.lockedUntil > Date.now()) return { locked: true, retryAfterSec: remainingSec(m.lockedUntil) };
  m.count = m.lockedUntil ? 1 : m.count + 1; // an expired lock starts over
  m.lockedUntil = m.count >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MINUTES * 60_000 : 0;
  memory.set(userId, m);
  return m.lockedUntil
    ? { locked: true, retryAfterSec: remainingSec(m.lockedUntil) }
    : { locked: false, attemptsLeft: MAX_FAILED_ATTEMPTS - m.count };
}

async function readRow(userId: string): Promise<Row | null | "unavailable"> {
  const sb = getAdmin();
  if (!sb) return "unavailable";
  const { data, error } = await sb
    .from("admin_attempts")
    .select("failed_count, locked_until")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    warnFallback(error.message);
    return "unavailable";
  }
  return (data as Row | null) ?? null;
}

/** A non-staff account hit /api/admin/*. Counts a strike unless it is already locked. */
export async function recordDeniedAttempt(userId: string): Promise<DenyState> {
  cleanUntil.delete(userId);
  const row = await readRow(userId);

  if (row === "unavailable") return memoryStrike(userId);

  if (row?.locked_until) {
    const until = Date.parse(row.locked_until);
    if (until > Date.now()) return { locked: true, retryAfterSec: remainingSec(until) };
  }

  const sb = getAdmin()!;
  const { data, error } = await sb.rpc("admin_attempt_fail", {
    p_user: userId,
    p_max: MAX_FAILED_ATTEMPTS,
    p_lock_minutes: LOCKOUT_MINUTES,
  });
  const out = (Array.isArray(data) ? data[0] : data) as { out_count: number; out_locked_until: string | null } | undefined;
  if (error || !out) {
    // Never fail open silently: count in memory so a DB hiccup can't grant free retries.
    warnFallback(error?.message ?? "rpc returned nothing");
    return memoryStrike(userId);
  }
  if (out.out_locked_until) {
    const until = Date.parse(out.out_locked_until);
    if (until > Date.now()) return { locked: true, retryAfterSec: remainingSec(until) };
  }
  return { locked: false, attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - out.out_count) };
}

/** Owner/admin recognised: clear any strikes and lock. Cheap for repeat callers (dashboard polls). */
export async function recordStaffSuccess(userId: string) {
  const until = cleanUntil.get(userId) ?? 0;
  if (until > Date.now()) return;
  memory.delete(userId);
  const row = await readRow(userId);
  if (row && row !== "unavailable" && (row.failed_count > 0 || row.locked_until)) {
    await getAdmin()!
      .from("admin_attempts")
      .update({ failed_count: 0, locked_until: null, last_attempt_at: new Date().toISOString() })
      .eq("user_id", userId);
  }
  cleanUntil.set(userId, Date.now() + CLEAN_TTL_MS);
}
