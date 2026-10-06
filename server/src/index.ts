import "./loadEnv.js";
import http from "http";
import express from "express";
import cors from "cors";
import { Server, ServerError, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { REGULAR_CAP, ROOM_CODES } from "@klase/shared";
import { ClassroomRoom } from "./ClassroomRoom.js";
import { resolveIdentity } from "./roles.js";
import { registerAdminRoutes } from "./admin.js";
import { loadAllRoomConfigs } from "./supabase.js";

const port = Number(process.env.PORT ?? 2567);
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/rooms", async (_req, res) => {
  try {
    const configs = await loadAllRoomConfigs();
    const configMap = Object.fromEntries(configs.map((c) => [c.room_key, c]));
    const rooms = ROOM_CODES.map((roomKey) => {
      const { players } = ClassroomRoom.snapshot(roomKey);
      const visible = players.filter((p) => !p.observer);
      const regulars = visible.filter((p) => p.role === "user").length;
      const cfg = configMap[roomKey];
      return {
        roomKey,
        label: roomKey.replace("klase-", "Classroom "),
        regulars,
        present: visible.length,
        cap: REGULAR_CAP,
        full: regulars >= REGULAR_CAP,
        locked: cfg?.locked ?? false,
      };
    });
    res.json({ rooms });
  } catch (e) {
    console.error("[rooms] list failed:", e instanceof Error ? e.message : e);
    res.status(500).json({
      error: "SERVER",
      rooms: ROOM_CODES.map((roomKey) => ({
        roomKey,
        label: roomKey.replace("klase-", "Classroom "),
        regulars: 0,
        present: 0,
        cap: REGULAR_CAP,
        full: false,
        locked: false,
      })),
    });
  }
});

registerAdminRoutes(app);

const KNOWN = new Set([
  "AUTH",
  "BANNED",
  "BAD_NAME",
  "NAME_RESERVED",
  "NO_PERMISSION",
  "ROOM_FULL",
  "ROOM_LOCKED",
  "AUTH_DISABLED",
]);

function httpStatusFor(code: string, fallback: number) {
  if (code === "AUTH") return 401;
  if (code === "BANNED" || code.startsWith("KICKED:") || code === "NO_PERMISSION" || code === "ROOM_LOCKED") return 403;
  if (code === "NAME_RESERVED" || code === "BAD_NAME") return 422;
  if (code === "ROOM_FULL") return 409;
  if (code === "AUTH_DISABLED") return 503;
  return fallback;
}

function describeError(e: unknown): { status: number; error: string; detail?: string } {
  const msg = e instanceof Error ? e.message : "SERVER";
  if (msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg) as { error?: string };
      if (parsed.error === "HELD") return { status: 403, error: msg };
    } catch {
      /* not json */
    }
  }
  if (e instanceof ServerError) {
    const code = typeof e.code === "number" ? e.code : httpStatusFor(msg, 400);
    return { status: code, error: msg };
  }
  if (KNOWN.has(msg) || msg.startsWith("KICKED:")) {
    return { status: httpStatusFor(msg, 400), error: msg };
  }
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { status: 500, error: "SERVER", detail };
}

app.post("/api/find-room", async (req, res) => {
  try {
    const token = typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
    let ident;
    try {
      ident = await resolveIdentity({
        name: req.body?.name,
        accessToken: token || undefined,
      });
    } catch (e) {
      const mapped = describeError(e);
      if (mapped.status >= 500) console.error("[find-room] identity failed:", mapped.detail ?? mapped.error);
      else console.warn("[find-room] identity rejected:", mapped.error);
      if (mapped.error.startsWith("{")) {
        try {
          res.status(mapped.status).json(JSON.parse(mapped.error));
          return;
        } catch {
          /* fall through */
        }
      }
      res.status(mapped.status).json({ error: mapped.error });
      return;
    }

    let listed: { metadata?: { roomKey?: string; regulars?: number }; clients?: number }[] = [];
    try {
      listed = (await matchMaker.query({ name: "classroom" })) as typeof listed;
    } catch (e) {
      console.error("[find-room] matchMaker.query threw:", e instanceof Error ? e.message : e);
      listed = [];
    }

    const role = ident.role;
    const wanted = (ROOM_CODES as readonly string[]).includes(String(req.body?.roomKey ?? ""))
      ? String(req.body.roomKey)
      : "";
    if (wanted) {
      const room = listed.find((r) => r.metadata?.roomKey === wanted);
      const regulars = (room?.metadata?.regulars as number | undefined) ?? room?.clients ?? 0;
      if (role === "user" && room && regulars >= REGULAR_CAP) {
        res.status(409).json({ error: "ROOM_FULL" });
        return;
      }
      res.json({ roomKey: wanted });
      return;
    }
    for (const roomKey of ROOM_CODES) {
      const room = listed.find((r) => r.metadata?.roomKey === roomKey);
      if (!room) {
        res.json({ roomKey });
        return;
      }
      const regulars = (room.metadata?.regulars as number | undefined) ?? room.clients ?? 0;
      if (role === "user" && regulars >= REGULAR_CAP) continue;
      res.json({ roomKey });
      return;
    }

    if (role === "owner" || role === "admin") {
      res.json({ roomKey: ROOM_CODES[0] });
      return;
    }
    res.status(409).json({ error: "ROOM_FULL" });
  } catch (e) {
    const mapped = describeError(e);
    console.error("[find-room]", mapped.detail ?? mapped.error, e);
    res.status(mapped.status).json({ error: mapped.error });
  }
});

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("classroom", ClassroomRoom).filterBy(["roomKey"]);

httpServer.listen(port, () => {
  console.log(`Klase server on :${port}`);
});
