import { Client, Room } from "colyseus.js";
import type { Look, ModerationNotice } from "@klase/shared";

const WS = import.meta.env.VITE_COLYSEUS_URL ?? "ws://localhost:2567";
const API = (
  import.meta.env.VITE_API_URL ??
  (import.meta.env.VITE_COLYSEUS_URL ? String(import.meta.env.VITE_COLYSEUS_URL).replace(/^ws/i, "http") : "")
).replace(/\/$/, "");

export function apiBase() {
  return API;
}

export type RemotePlayer = {
  sessionId: string;
  name: string;
  role: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  hat: string;
  top: string;
  accessory: string;
  body: string;
  serverMuted: boolean;
  userId?: string;
  seatId: string;
  observer?: boolean;
  noclip?: boolean;
};

export async function pickRoom(
  name: string,
  accessToken?: string,
): Promise<{ roomKey: string } | { error: string; notice?: ModerationNotice }> {
  if (import.meta.env.PROD && !API) return { error: "SERVER" };
  try {
    const res = await fetch(`${API}/api/find-room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, accessToken }),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      roomKey?: string;
      notice?: ModerationNotice;
    } | null;
    if (!res.ok) {
      const code = data?.error;
      if (code === "HELD" && data?.notice) return { error: "HELD", notice: data.notice };
      if (code?.startsWith("KICKED:") || code === "BANNED" || code === "AUTH" || code === "NAME_RESERVED" || code === "BAD_NAME") {
        return { error: code ?? "AUTH" };
      }
      if (res.status === 409 || code === "ROOM_FULL") return { error: "ROOM_FULL" };
      return { error: "SERVER" };
    }
    if (!data?.roomKey) return { error: "SERVER" };
    return { roomKey: data.roomKey };
  } catch {
    return { error: "SERVER" };
  }
}

/**
 * `god` asks the server for owner god mode (skip capacity checks, silent + invisible).
 * It is only a request: the server verifies the token and rejects anyone who isn't the owner.
 */
export async function joinClassroom(
  roomKey: string,
  name: string,
  look: Look,
  accessToken?: string,
  god = false,
  staffJoin = false,
) {
  const client = new Client(WS);
  const room = await client.joinOrCreate("classroom", {
    roomKey,
    name,
    hat: look.hat,
    top: look.top,
    accessory: look.accessory,
    body: look.body,
    accessToken,
    god,
    staffJoin,
  });
  return room;
}
