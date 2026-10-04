import { Client, Room } from "colyseus.js";
import { REGULAR_CAP, ROOM_CODES, type Look, type ModerationNotice } from "@klase/shared";

function envText(value: unknown): string {
  return String(value ?? "").trim();
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Mixed content: an https page cannot talk to ws:// or http://. */
function upgradeForHttps(url: string): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    if (url.startsWith("ws://")) return `wss://${url.slice("ws://".length)}`;
    if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  }
  return url;
}

/** Colyseus client wants ws/wss. Vercel is often given https://host by mistake. */
function toWebsocketUrl(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

function toHttpUrl(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
  return url;
}

function resolveWs(): string {
  const raw = envText(import.meta.env.VITE_COLYSEUS_URL);
  if (raw) return stripSlash(upgradeForHttps(toWebsocketUrl(raw)));
  if (import.meta.env.DEV) return "ws://localhost:2567";
  return "";
}

function resolveApi(): string {
  const explicit = envText(import.meta.env.VITE_API_URL);
  if (explicit) return stripSlash(upgradeForHttps(toHttpUrl(explicit)));
  const ws = envText(import.meta.env.VITE_COLYSEUS_URL);
  if (ws) return stripSlash(upgradeForHttps(toHttpUrl(ws)));
  return "";
}

const WS = resolveWs();
const API = resolveApi();

export function apiBase() {
  return API;
}

function apiHost(): string {
  try {
    return new URL(API || window.location.origin, window.location.origin).hostname;
  } catch {
    return "(unknown)";
  }
}

function logJoinFail(kind: string, extra: { status?: number; err?: unknown }) {
  const status = extra.status != null ? extra.status : "";
  const msg = extra.err instanceof Error ? extra.err.message : extra.err != null ? String(extra.err) : "";
  console.error(`[klase] ${kind} api=${apiHost()}${status !== "" ? ` status=${status}` : ""}${msg ? ` ${msg}` : ""}`);
}

function sleep(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
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

export type PickRoomError = {
  error: string;
  notice?: ModerationNotice;
  status?: number;
};

function findRoomUrl() {
  return `${API}/api/find-room`.replace(/^(?!https?:)\/\//, "/");
}

function healthUrl() {
  return `${API}/health`.replace(/^(?!https?:)\/\//, "/");
}

async function wakeServer(onWake: (() => void) | undefined): Promise<boolean> {
  onWake?.();
  const deadline = Date.now() + 60_000;
  let delay = 2000;
  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetch(healthUrl(), { method: "GET" });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) return false;
    } catch {
      /* still sleeping or unreachable */
    }
    delay = Math.min(Math.round(delay * 1.5), 8000);
  }
  return false;
}

function usableToken(raw?: string): string | undefined {
  const token = String(raw ?? "").trim();
  if (!token || token.split(".").length < 3) return undefined;
  return token;
}

async function postFindRoom(name: string, accessToken?: string, roomKey?: string): Promise<Response> {
  const token = usableToken(accessToken);
  return fetch(findRoomUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      ...(token ? { accessToken: token } : {}),
      ...(roomKey ? { roomKey } : {}),
    }),
  });
}

export type RoomListItem = {
  roomKey: string;
  label: string;
  regulars: number;
  present: number;
  cap: number;
  full: boolean;
};

export type RoomListError = {
  error: "UNREACHABLE" | "NOT_CONFIGURED" | "SERVER_ERROR" | "TIMEOUT";
  detail?: string;
};

function emptyRoomList(): RoomListItem[] {
  return ROOM_CODES.map((roomKey) => ({
    roomKey,
    label: roomKey.replace("klase-", "Classroom "),
    regulars: 0,
    present: 0,
    cap: REGULAR_CAP,
    full: false,
  }));
}

async function fetchRoomsOnce(url: string, ms: number): Promise<RoomListItem[] | RoomListError> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const data = (await res.json().catch(() => null)) as { rooms?: RoomListItem[]; error?: string } | null;
    if (res.status === 404) {
      console.warn("[rooms] GET /api/rooms is missing on this server; showing empty classrooms so join still works. Deploy the game server that serves /api/rooms.");
      return emptyRoomList();
    }
    if (!res.ok) {
      console.error(`[rooms] list failed api=${apiHost()} status=${res.status} ${data?.error ?? res.statusText}`);
      if (Array.isArray(data?.rooms) && data.rooms.length) return data.rooms;
      return { error: "SERVER_ERROR", detail: `HTTP ${res.status}` };
    }
    if (!Array.isArray(data?.rooms)) {
      console.error(`[rooms] list failed api=${apiHost()} bad-json`);
      return { error: "SERVER_ERROR", detail: "bad-json" };
    }
    return data.rooms;
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    console.error(`[rooms] list failed api=${apiHost()} ${aborted ? "timeout" : e instanceof Error ? e.message : e}`);
    return { error: aborted ? "TIMEOUT" : "UNREACHABLE", detail: aborted ? `timeout ${ms}ms` : "network" };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function listRooms(onWake?: () => void): Promise<RoomListItem[] | RoomListError> {
  if (import.meta.env.PROD && !API) {
    console.error("[rooms] list failed NOT_CONFIGURED (empty VITE_API_URL / VITE_COLYSEUS_URL)");
    return { error: "NOT_CONFIGURED" };
  }
  const url = `${API}/api/rooms`.replace(/^(?!https?:)\/\//, "/");
  const first = await fetchRoomsOnce(url, 10_000);
  if (Array.isArray(first)) return first;
  if (first.error === "NOT_CONFIGURED" || first.error === "SERVER_ERROR") return first;
  const woke = await wakeServer(onWake);
  if (!woke) return first;
  const second = await fetchRoomsOnce(url, 12_000);
  return Array.isArray(second) ? second : first;
}

function parseFindBody(data: { error?: string; roomKey?: string; notice?: ModerationNotice } | null, status: number): PickRoomError {
  if (!data) return { error: "SERVER_ERROR", status };
  if (data.error === "HELD" && data.notice) return { error: "HELD", notice: data.notice };
  const code = data.error;
  if (code?.startsWith("KICKED:") || code === "BANNED" || code === "AUTH" || code === "NAME_RESERVED" || code === "BAD_NAME") {
    return { error: code };
  }
  if (status === 409 || code === "ROOM_FULL") return { error: "ROOM_FULL" };
  return { error: "SERVER_ERROR", status };
}

export async function pickRoom(
  name: string,
  accessToken?: string,
  onWake?: () => void,
  roomKey?: string,
): Promise<{ roomKey: string } | PickRoomError> {
  if (import.meta.env.PROD && !API) {
    logJoinFail("NOT_CONFIGURED", {});
    return { error: "NOT_CONFIGURED" };
  }
  if (!WS && import.meta.env.PROD) {
    logJoinFail("NOT_CONFIGURED", {});
    return { error: "NOT_CONFIGURED" };
  }

  let res: Response;
  try {
    res = await postFindRoom(name, accessToken, roomKey);
  } catch (err) {
    logJoinFail("UNREACHABLE", { err });
    const woke = await wakeServer(onWake);
    if (!woke) {
      logJoinFail("UNREACHABLE", { err: "wake timeout" });
      return { error: "UNREACHABLE" };
    }
    try {
      res = await postFindRoom(name, accessToken, roomKey);
    } catch (err2) {
      logJoinFail("UNREACHABLE", { err: err2 });
      return { error: "UNREACHABLE" };
    }
  }

  const data = (await res.json().catch(() => null)) as {
    error?: string;
    roomKey?: string;
    notice?: ModerationNotice;
  } | null;

  if (!res.ok) {
    const parsed = parseFindBody(data, res.status);
    logJoinFail(parsed.error, { status: res.status, err: data?.error ?? res.statusText });
    if (res.status === 401 && parsed.error === "SERVER_ERROR") return { error: "AUTH", status: 401 };
    return parsed;
  }
  if (!data?.roomKey) {
    logJoinFail("SERVER_ERROR", { status: res.status, err: "missing roomKey" });
    return { error: "SERVER_ERROR", status: res.status };
  }
  return { roomKey: data.roomKey };
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
  if (!WS) throw new Error("NOT_CONFIGURED");
  const token = usableToken(accessToken);
  const client = new Client(WS);
  const room = await client.joinOrCreate("classroom", {
    roomKey,
    name,
    hat: look.hat,
    top: look.top,
    accessory: look.accessory,
    body: look.body,
    ...(token ? { accessToken: token } : {}),
    god,
    staffJoin,
  });
  return room;
}
