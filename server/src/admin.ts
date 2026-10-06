import type { Express, NextFunction, Request, Response } from "express";
import { ServerError } from "@colyseus/core";
import { REGULAR_CAP, ROOM_CODES, type Role } from "@klase/shared";
import { ClassroomRoom } from "./ClassroomRoom.js";
import { AdminDeniedError, AdminLockedError, resolveStaff } from "./roles.js";
import {
  loadAdminPermissions,
  loadAllAdminPermissions,
  upsertAdminPermissions,
  ensureAdminPermissionsRow,
  loadAllRoomConfigs,
  setRoomLocked,
  loadWhitelistForRoom,
  addWhitelistEntry,
  removeWhitelistEntry,
  searchAccounts,
  setRole,
  setBanned,
  loadProfile,
  ownerUserId,
  ownerEmail,
  type AdminPermissions,
} from "./supabase.js";
import crypto from "crypto";

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
    if (!token) {
      console.warn("[admin] rejected: missing bearer token");
      throw new ServerError(401, "AUTH");
    }
    res.locals.staff = await resolveStaff(token);
    next();
  } catch (e) {
    sendError(res, e);
  }
}

/** Reject non-owner staff with 403. */
function requireOwner(req: Request, res: Response, next: NextFunction) {
  const staff = res.locals.staff as Staff | undefined;
  if (!staff || staff.role !== "owner") {
    res.status(403).json({ error: "NO_PERMISSION" });
    return;
  }
  next();
}

/** Read the current admin_permissions row for the requesting admin. Falls through for owner (no row needed). */
async function loadCallerPerms(staff: Staff): Promise<AdminPermissions | null> {
  if (staff.role === "owner") return null; // owner bypasses all permission checks
  return loadAdminPermissions(staff.userId);
}

/** Returns true if the target is the env-configured owner (immune). */
function isOwnerAccount(userId: string): boolean {
  const byId = ownerUserId();
  if (byId && userId === byId) return true;
  return false;
}

/** Generate a cryptographically secure 20-char alphanumeric passcode. */
function generatePasscode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) {
    out += chars[bytes[i]! % chars.length];
  }
  return out;
}

export function registerAdminRoutes(app: Express) {
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------
  app.get("/api/admin/me", requireStaff, async (req, res) => {
    const staff = res.locals.staff as Staff;
    let permissions: AdminPermissions | null = null;
    if (staff.role === "admin") {
      permissions = await loadAdminPermissions(staff.userId);
    }
    res.json({ name: staff.name, role: staff.role, permissions });
  });

  // ---------------------------------------------------------------------------
  // Rooms (live snapshot + config)
  // ---------------------------------------------------------------------------
  app.get("/api/admin/rooms", requireStaff, async (_req, res) => {
    const [roomConfigs] = await Promise.all([loadAllRoomConfigs()]);
    const configMap = Object.fromEntries(roomConfigs.map((c) => [c.room_key, c]));
    const rooms = ROOM_CODES.map((roomKey) => {
      const { roomId, players } = ClassroomRoom.snapshot(roomKey);
      const visible = players.filter((p) => !p.observer);
      const cfg = configMap[roomKey] ?? { locked: false, whitelist_mode: false };
      return {
        roomKey,
        roomId,
        regulars: players.filter((p) => p.role === "user").length,
        regularCap: REGULAR_CAP,
        observers: players.length - visible.length,
        players,
        locked: cfg.locked,
        whitelist_mode: cfg.whitelist_mode,
      };
    });
    res.json({ rooms });
  });

  // ---------------------------------------------------------------------------
  // Moderation (kick / ban / mute / promote / demote etc.)
  // ---------------------------------------------------------------------------
  app.post("/api/admin/moderate", requireStaff, async (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      const roomKey = String(req.body?.roomKey ?? "");
      const targetId = String(req.body?.targetId ?? "");
      const action = String(req.body?.action ?? "");
      if (!(ROOM_CODES as readonly string[]).includes(roomKey) || !ACTIONS.has(action)) {
        throw new ServerError(400, "BAD_REQUEST");
      }

      // Per-admin permission checks for announce
      if (action === "announce" && staff.role === "admin") {
        const perms = await loadAdminPermissions(staff.userId);
        if (!perms.can_announce) throw new ServerError(403, "NO_PERMISSION");
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

  // ---------------------------------------------------------------------------
  // Room lock / unlock
  // ---------------------------------------------------------------------------
  app.post("/api/admin/room-config", requireStaff, async (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      const roomKey = String(req.body?.roomKey ?? "");
      if (!(ROOM_CODES as readonly string[]).includes(roomKey)) {
        throw new ServerError(404, "NOT_FOUND");
      }
      // Admin needs can_lock_rooms
      if (staff.role === "admin") {
        const perms = await loadAdminPermissions(staff.userId);
        if (!perms.can_lock_rooms) throw new ServerError(403, "NO_PERMISSION");
      }
      const locked = Boolean(req.body?.locked);
      await setRoomLocked(roomKey, locked);
      res.json({ ok: true, roomKey, locked });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---------------------------------------------------------------------------
  // Whitelist management
  // ---------------------------------------------------------------------------
  app.get("/api/admin/whitelist/:roomKey", requireStaff, async (req, res) => {
    try {
      const roomKey = req.params.roomKey ?? "";
      if (!(ROOM_CODES as readonly string[]).includes(roomKey)) {
        throw new ServerError(404, "NOT_FOUND");
      }
      const entries = await loadWhitelistForRoom(roomKey);
      // Never expose raw passcodes to non-owner admins
      const staff = res.locals.staff as Staff;
      const safe = entries.map((e) => ({
        ...e,
        passcode: staff.role === "owner" ? e.passcode : e.passcode ? "••••••••••••••••••••" : null,
      }));
      res.json({ entries: safe });
    } catch (e) {
      sendError(res, e);
    }
  });

  // Search accounts by display_name or email for whitelist addition
  app.get("/api/admin/whitelist-search", requireStaff, async (req, res) => {
    try {
      const q = String(req.query?.q ?? "").trim();
      if (!q) { res.json({ accounts: [] }); return; }
      const accounts = await searchAccounts(q, 10);
      res.json({ accounts });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post("/api/admin/whitelist/:roomKey/add", requireStaff, async (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      const roomKey = req.params.roomKey ?? "";
      if (!(ROOM_CODES as readonly string[]).includes(roomKey)) {
        throw new ServerError(404, "NOT_FOUND");
      }
      if (staff.role === "admin") {
        const perms = await loadAdminPermissions(staff.userId);
        if (!perms.can_lock_rooms) throw new ServerError(403, "NO_PERMISSION");
      }
      const type = String(req.body?.type ?? "");
      const label = String(req.body?.label ?? "").trim().slice(0, 80);
      const singleUse = Boolean(req.body?.single_use);
      const expiresAt = req.body?.expires_at ? String(req.body.expires_at) : null;

      if (type === "user") {
        const userId = String(req.body?.user_id ?? "").trim();
        if (!userId) throw new ServerError(400, "BAD_REQUEST");
        const entry = await addWhitelistEntry({
          room_key: roomKey,
          user_id: userId,
          passcode: null,
          label,
          single_use: singleUse,
          expires_at: expiresAt,
          added_by: staff.userId,
        });
        if (!entry) throw new ServerError(500, "SERVER");
        res.json({ entry });
      } else if (type === "passcode") {
        const passcode = generatePasscode();
        const entry = await addWhitelistEntry({
          room_key: roomKey,
          user_id: null,
          passcode,
          label: label || "Passcode",
          single_use: singleUse,
          expires_at: expiresAt,
          added_by: staff.userId,
        });
        if (!entry) throw new ServerError(500, "SERVER");
        res.json({ entry }); // passcode revealed once on creation
      } else {
        throw new ServerError(400, "BAD_REQUEST");
      }
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete("/api/admin/whitelist/entry/:id", requireStaff, async (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      if (staff.role === "admin") {
        const perms = await loadAdminPermissions(staff.userId);
        if (!perms.can_lock_rooms) throw new ServerError(403, "NO_PERMISSION");
      }
      const id = req.params.id ?? "";
      if (!id) throw new ServerError(400, "BAD_REQUEST");
      const deleted = await removeWhitelistEntry(id);
      if (!deleted) throw new ServerError(404, "NOT_FOUND");
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---------------------------------------------------------------------------
  // Account management (owner only)
  // ---------------------------------------------------------------------------
  app.get("/api/admin/accounts", requireStaff, requireOwner, async (req, res) => {
    try {
      const q = String(req.query?.q ?? "").trim();
      const accounts = await searchAccounts(q, 20);
      res.json({ accounts });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post("/api/admin/accounts/set-role", requireStaff, requireOwner, async (req, res) => {
    try {
      const targetId = String(req.body?.userId ?? "").trim();
      const newRole = String(req.body?.role ?? "");
      if (!targetId) throw new ServerError(400, "BAD_REQUEST");
      if (newRole !== "admin" && newRole !== "user") throw new ServerError(400, "BAD_REQUEST");

      // Immune: cannot target the env-configured owner
      if (isOwnerAccount(targetId)) throw new ServerError(403, "IMMUNE");

      const profile = await loadProfile(targetId);
      if (!profile) throw new ServerError(404, "NOT_FOUND");

      // Reject no-op
      if (profile.role === newRole) throw new ServerError(400, "BAD_REQUEST");
      // Cannot demote owner via this route
      if (profile.role === "owner") throw new ServerError(403, "IMMUNE");

      await setRole(targetId, newRole as Role);
      if (newRole === "admin") {
        await ensureAdminPermissionsRow(targetId);
      }
      res.json({ ok: true, userId: targetId, role: newRole });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post("/api/admin/accounts/set-banned", requireStaff, async (req, res) => {
    try {
      const staff = res.locals.staff as Staff;
      const targetId = String(req.body?.userId ?? "").trim();
      const banned = Boolean(req.body?.banned);

      if (!targetId) throw new ServerError(400, "BAD_REQUEST");
      if (isOwnerAccount(targetId)) throw new ServerError(403, "IMMUNE");

      const profile = await loadProfile(targetId);
      if (!profile) throw new ServerError(404, "NOT_FOUND");
      if (profile.role === "owner") throw new ServerError(403, "IMMUNE");

      // Admin needs can_blacklist
      if (staff.role === "admin") {
        const perms = await loadAdminPermissions(staff.userId);
        if (!perms.can_blacklist) throw new ServerError(403, "NO_PERMISSION");
      }

      // Admins cannot blacklist other admins (mirrors assertCanModerate)
      if (staff.role === "admin" && profile.role === "admin") {
        throw new ServerError(403, "ADMIN_VS_ADMIN");
      }

      await setBanned(targetId, banned);
      res.json({ ok: true, userId: targetId, banned });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---------------------------------------------------------------------------
  // Admin permissions (owner only)
  // ---------------------------------------------------------------------------
  app.get("/api/admin/permissions", requireStaff, requireOwner, async (_req, res) => {
    try {
      const perms = await loadAllAdminPermissions();
      res.json({ permissions: perms });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post("/api/admin/permissions/:userId", requireStaff, requireOwner, async (req, res) => {
    try {
      const targetId = req.params.userId ?? "";
      if (!targetId) throw new ServerError(400, "BAD_REQUEST");
      if (isOwnerAccount(targetId)) throw new ServerError(403, "IMMUNE");

      const profile = await loadProfile(targetId);
      if (!profile) throw new ServerError(404, "NOT_FOUND");
      if (profile.role === "owner") throw new ServerError(403, "IMMUNE");

      const allowed = ["can_observe", "can_lock_rooms", "can_blacklist", "can_announce"] as const;
      const patch: Partial<Omit<AdminPermissions, "user_id">> = {};
      for (const key of allowed) {
        if (key in req.body) patch[key] = Boolean(req.body[key]);
      }
      await upsertAdminPermissions(targetId, patch);
      const updated = await loadAdminPermissions(targetId);
      res.json({ ok: true, permissions: updated });
    } catch (e) {
      sendError(res, e);
    }
  });
}
