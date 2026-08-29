import { Client, Room } from "colyseus.js";
import type { Look } from "@klase/shared";

const WS = import.meta.env.VITE_COLYSEUS_URL ?? "ws://localhost:2567";

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
};

export async function pickRoom(
  name: string,
  accessToken?: string,
): Promise<{ roomKey: string } | { error: string }> {
  try {
    const res = await fetch("/api/find-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, accessToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "ROOM_FULL" };
    if (!data.roomKey) return { error: "SERVER" };
    return { roomKey: data.roomKey };
  } catch {
    return { error: "SERVER" };
  }
}

export async function joinClassroom(roomKey: string, name: string, look: Look, accessToken?: string) {
  const client = new Client(WS);
  const room = await client.joinOrCreate("classroom", {
    roomKey,
    name,
    hat: look.hat,
    top: look.top,
    accessory: look.accessory,
    body: look.body,
    accessToken,
  });
  return room;
}
