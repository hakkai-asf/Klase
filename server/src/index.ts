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

const port = Number(process.env.PORT ?? 2567);
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
registerAdminRoutes(app);

app.post("/api/find-room", async (req, res) => {
  try {
    const ident = await resolveIdentity({
      name: req.body?.name,
      accessToken: req.body?.accessToken,
    });
    const role = ident.role;

    const listed = await matchMaker.query({ name: "classroom" });
    for (const roomKey of ROOM_CODES) {
      const room = listed.find((r) => r.metadata?.roomKey === roomKey);
      if (!room) {
        res.json({ roomKey });
        return;
      }
      const regulars = (room.metadata?.regulars as number | undefined) ?? room.clients;
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
    const msg = e instanceof Error ? e.message : "SERVER";
    if (msg.startsWith("{")) {
      try {
        const parsed = JSON.parse(msg) as { error?: string; notice?: unknown };
        if (parsed.error === "HELD") {
          res.status(403).json(parsed);
          return;
        }
      } catch {
        /* not json */
      }
    }
    if (e instanceof ServerError) {
      const status =
        typeof e.code === "number"
          ? e.code
          : msg === "BANNED" || msg.startsWith("KICKED:")
            ? 403
            : msg === "NAME_RESERVED" || msg === "BAD_NAME"
              ? 422
              : msg === "AUTH"
                ? 401
                : 400;
      res.status(status).json({ error: msg });
      return;
    }
    console.error("[find-room]", e);
    res.status(500).json({ error: "SERVER" });
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
