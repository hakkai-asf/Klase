import type { Express, NextFunction, Request, Response } from "express";
import { ServerError } from "@colyseus/core";
import { REGULAR_CAP, ROOM_CODES, type Role } from "@klase/shared";
import { ClassroomRoom } from "./ClassroomRoom.js";
import { AdminDeniedError, AdminLockedError, resolveStaff } from "./roles.js";

const ACTIONS = new Set(["kick", "ban", "mute", "unmute", "promote", "demote", "kick-all", "message", "announce"]);

type Staff = { userId: string; name: string; role: Role };

function sendError(res: Response, e: unknown) {
  if (e instanceof AdminLockedError) {
    res.set("Retry-After", String(e.retryAfterSec));
    res.status(429).json({ error: e.message, retryAfterSec: e.retryAfterSec });
    return;
  }
  if (e instanceof AdminDeniedError) {
    res.status(403).json({ error: e.message, attemptsLeft: e.attemptsLeft });
    return;
  }
  if (e instanceof ServerError) {
    res.status(typeof e.code === "number" ? e.code : 500).json({ error: e.message });
    return;
  }
  console.error("[admin]", e);
  res.status(500).json({ error: "SERVER" });
}

/**
 * Every /api/admin/* request re-verifies the Supabase token and re-reads the role from the
 * database. Nothing the browser says about who it is gets trusted.
 */
async function requireStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new ServerError(401, "AUTH");
    res.locals.staff = await resolveStaff(token);
    next();
  } catch (e) {
    sendError(res, e);
  }
}

export function registerAdminRoutes(app: Express) {
  app.get("/api/admin/me", requireStaff, (_req, res) => {
    const staff = res.locals.staff as Staff;
    res.json({ name: staff.name, role: staff.role });
  });

  // Live players in all three classrooms, read directly from Colyseus room state.
  app.get("/api/admin/rooms", requireStaff, (_req, res) => {
    const rooms = ROOM_CODES.map((roomKey) => {
      const { roomId, players } = ClassroomRoom.snapshot(roomKey);
      const visible = players.filter((p) => !p.observer);
      return {
        roomKey,
        roomId,
        regulars: players.filter((p) => p.role === "user").length,
        regularCap: REGULAR_CAP,
        observers: players.length - visible.length,
        players,
      };
    });
    res.json({ rooms });
  });

  // Kick / ban / mute / promote / demote. Permission rules live only in assertCanModerate.
  app.post("/api/admin/moderate", requireStaff, (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      const roomKey = String(req.body?.roomKey ?? "");
      const targetId = String(req.body?.targetId ?? "");
      const action = String(req.body?.action ?? "");
      if (!(ROOM_CODES as readonly string[]).includes(roomKey) || !ACTIONS.has(action)) {
        throw new ServerError(400, "BAD_REQUEST");
      }
      const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds.map(String) : [];
      if (action !== "kick-all" && action !== "announce" && !targetId && !targetIds.length) {
        throw new ServerError(400, "BAD_REQUEST");
      }
      const found = ClassroomRoom.moderateFromAdmin(staff.role, roomKey, targetId, action, {
        actorName: staff.name,
        reason: req.body?.reason,
        message: req.body?.message,
        cooldownSec: req.body?.cooldownSec,
        permanent: req.body?.permanent,
        targetIds,
      });
      if (!found) throw new ServerError(404, "NOT_FOUND");
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });
}
