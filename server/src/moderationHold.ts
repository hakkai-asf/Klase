import type { ModerationNotice } from "@klase/shared";
import { getAdmin } from "./supabase.js";

function canonicalName(name: string) {
  return name
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, "")
    .toLowerCase();
}

/**
 * Kick/ban holds. Signed-in users are keyed by auth user id (hard to evade).
 * Guests are keyed by canonical display name — changing the name bypasses it.
 */
export type Hold = {
  kind: "kick" | "ban";
  until: number | null;
  reason: string;
  message: string;
  actorName: string;
  actorRole: "owner" | "admin";
};

const memory = new Map<string, Hold>();

function guestKey(name: string) {
  const c = canonicalName(name);
  return c ? `guest:${c}` : "";
}

function keysFor(userId: string, name: string) {
  const keys: string[] = [];
  if (userId) keys.push(`user:${userId}`);
  const g = guestKey(name);
  if (g) keys.push(g);
  return keys;
}

function alive(h: Hold) {
  if (h.until === null) return true;
  return h.until > Date.now();
}

export function holdToNotice(h: Hold): ModerationNotice {
  return {
    kind: h.kind,
    actorRole: h.actorRole,
    actorName: h.actorName,
    reason: h.reason,
    message: h.message,
    until: h.until,
  };
}

export async function putHold(userId: string, name: string, hold: Hold) {
  const keys = keysFor(userId, name);
  for (const k of keys) memory.set(k, hold);
  const sb = getAdmin();
  if (!sb || !keys.length) return;
  const rows = keys.map((hold_key) => ({
    hold_key,
    kind: hold.kind,
    until: hold.until === null ? null : new Date(hold.until).toISOString(),
    reason: hold.reason,
    message: hold.message,
    actor_name: hold.actorName,
    actor_role: hold.actorRole,
  }));
  const { error } = await sb.from("moderation_holds").upsert(rows);
  if (error) console.warn("[moderation-holds]", error.message);
}

export async function findHold(userId: string, name: string): Promise<Hold | null> {
  const keys = keysFor(userId, name);
  for (const k of keys) {
    const h = memory.get(k);
    if (h && alive(h)) return h;
    if (h) memory.delete(k);
  }
  const sb = getAdmin();
  if (!sb || !keys.length) return null;
  const { data, error } = await sb.from("moderation_holds").select("*").in("hold_key", keys);
  if (error || !data?.length) return null;
  for (const row of data) {
    const hold: Hold = {
      kind: row.kind === "ban" ? "ban" : "kick",
      until: row.until == null ? null : Date.parse(String(row.until)),
      reason: String(row.reason ?? ""),
      message: String(row.message ?? ""),
      actorName: String(row.actor_name ?? "staff"),
      actorRole: row.actor_role === "admin" ? "admin" : "owner",
    };
    if (hold.until !== null && Number.isNaN(hold.until)) continue;
    if (!alive(hold)) continue;
    memory.set(String(row.hold_key), hold);
    return hold;
  }
  return null;
}
