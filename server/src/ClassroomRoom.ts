import { Room, Client, ServerError } from "@colyseus/core";
import { CHAT_LOG_MAX, CHAT_RADIUS, CLASSROOM, IDLE_MS, MOD_DURATION_MAX_SEC, MOD_MESSAGE_MAX, REGULAR_CAP, SEAT_REACH, SPAWN, STAFF_IDLE_MS, WEARABLES, classroomSeats, clampClassroom, normalizeLook, resolvePlayerMove, type ModerationNotice, type Role } from "@klase/shared";
import { ClassroomState, Player } from "./schema.js";
import { filterChat, isCleanDisplayName, sanitizeDisplayName } from "./chatFilter.js";
import { assertCanModerate, banName, canUseName, invalidateReservedNames, ownerName, rememberPrivileged, resolveIdentity } from "./roles.js";
import { putHold } from "./moderationHold.js";
import { saveLook, setBanned, setRole, supabaseEnabled } from "./supabase.js";

function allowed(list: readonly string[], value: string) {
  return (list as readonly string[]).includes(value) ? value : "";
}

function dist(a: Player, b: Player) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

type ChatLine = { from: string; name: string; text: string; kind: string; role?: string };

function formatRoomLabel(key: string) {
  if (key === "klase-1") return "Classroom 1";
  if (key === "klase-2") return "Classroom 2";
  if (key === "klase-3") return "Classroom 3";
  return key;
}

/** Hard ceiling for regulars. Owner/admin and observers skip it. */
const ROOM_CEILING = 48;

export type ModerationExtras = {
  actorName?: string;
  reason?: string;
  message?: string;
  cooldownSec?: number;
  permanent?: boolean;
  targetIds?: string[];
};

export type LivePlayer = {
  sessionId: string;
  name: string;
  role: string;
  signedIn: boolean;
  serverMuted: boolean;
  seated: boolean;
  observer: boolean;
  noclip: boolean;
};

export class ClassroomRoom extends Room<ClassroomState> {
  // No Colyseus-level cap: it would lock the room and reject god-mode joiners before onAuth
  // runs. The ceiling is enforced in onJoin instead, where god mode can bypass it.
  maxClients = Infinity;
  private static activeRooms = new Set<ClassroomRoom>();

  /** Live state of every room instance, keyed by roomKey (read straight from room state). */
  static snapshot(roomKey: string): { roomId: string | null; players: LivePlayer[] } {
    const players: LivePlayer[] = [];
    let roomId: string | null = null;
    for (const room of ClassroomRoom.activeRooms) {
      if (room.state.roomKey !== roomKey) continue;
      roomId = room.roomId;
      room.state.players.forEach((p) => {
        players.push({
          sessionId: p.sessionId,
          name: p.name,
          role: p.role,
          signedIn: Boolean(p.userId),
          serverMuted: p.serverMuted,
          seated: Boolean(p.seatId),
          observer: p.observer,
          noclip: p.noclip,
        });
      });
    }
    return { roomId, players };
  }

  /** Apply a moderation action from outside a room (admin dashboard). Returns false if target not found. */
  static moderateFromAdmin(
    actorRole: Role,
    roomKey: string,
    targetId: string,
    action: string,
    extras: ModerationExtras = {},
  ): boolean {
    for (const room of ClassroomRoom.activeRooms) {
      if (room.state.roomKey !== roomKey) continue;
      if (action === "announce" || action === "message") {
        return room.staffSpeak(actorRole, extras.actorName || "staff", extras.message || extras.reason || "", action === "announce" ? "" : targetId);
      }
      const ids = extras.targetIds?.length ? extras.targetIds : targetId ? [targetId] : [];
      if (action === "kick-all") return room.kickAllRegulars(actorRole, extras);
      let any = false;
      for (const id of ids) {
        if (room.applyModeration(actorRole, id, action, extras)) any = true;
      }
      return any;
    }
    return false;
  }

  private chatLog: ChatLine[] = [];
  private lastActive = new Map<string, number>();
  /** Only sessionIds that have completed the full onJoin flow are in this set.
   *  Every message handler checks this first — no action is taken for connections
   *  that haven't been fully initialized as real players. */
  private joined = new Set<string>();
  /** Session ids whose leave was already announced (kick/ban) — skip the generic leave line. */
  private quietLeave = new Set<string>();

  private touch(sessionId: string) {
    this.lastActive.set(sessionId, Date.now());
  }

  private pushChat(line: ChatLine) {
    // Append new chat line to the circular buffer
    this.chatLog.push(line);
    // Trim oldest entries when buffer exceeds max
    if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
  }

  onCreate(options: { roomKey?: string }) {
    ClassroomRoom.activeRooms.add(this);
    this.setState(new ClassroomState());
    this.state.roomKey = String(options.roomKey ?? "klase-1");
    this.syncMeta();

    this.onMessage("move", (client, data: { x: number; z: number; rotY: number }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const p = this.state.players.get(client.sessionId);
      if (!p || p.seatId) return;
      if (typeof data.x !== "number" || typeof data.z !== "number") return;
      p.rotY = Number(data.rotY) || 0;
      if (p.observer || p.noclip) {
        p.x = data.x;
        p.z = data.z;
        this.touch(client.sessionId);
        return;
      }
      const clamped = clampClassroom(data.x, data.z);
      // Filter out self, then map to just x,z coordinates for collision checking
      const others = [...this.state.players.values()]
        .filter((o) => o.sessionId !== p.sessionId && !o.observer && !o.noclip)
        .map((o) => ({ x: o.x, z: o.z }));
      const sep = resolvePlayerMove(p.x, p.z, clamped.x, clamped.z, others);
      p.x = sep.x;
      p.z = sep.z;
      this.touch(client.sessionId);
    });

    const seats = classroomSeats();
    this.onMessage("sit", (client, data: { seatId?: string }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // Locate the requested seat by ID
      const seat = seats.find((s) => s.id === String(data?.seatId ?? ""));
      if (!seat) return;
      // Check if any other player is currently occupying this seat
      const taken = [...this.state.players.values()].some(
        (o) => o.sessionId !== p.sessionId && o.seatId === seat.id,
      );
      if (taken) return;
      if (Math.hypot(p.x - seat.x, p.z - seat.z) > SEAT_REACH + 0.4) return;
      p.seatId = seat.id;
      p.x = seat.x;
      p.z = seat.z;
      p.rotY = seat.rotY;
      this.touch(client.sessionId);
    });

    this.onMessage("stand", (client) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.seatId = "";
      this.touch(client.sessionId);
    });

    this.onMessage("poke", (client) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      if (this.state.players.has(client.sessionId)) this.touch(client.sessionId);
    });

    this.onMessage("need-history", (client) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      if (!this.state.players.has(client.sessionId)) return;
      // Send a non-destructive copy of the chat history
      client.send("chat-history", this.chatLog.slice());
    });

    this.onMessage("chat", (client, data: { text?: string }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const p = this.state.players.get(client.sessionId);
      if (!p || p.serverMuted) return;
      const raw = String(data?.text ?? "").slice(0, 240).trim();
      if (!raw) return;
      const text = filterChat(raw);
      this.touch(client.sessionId);
      const line: ChatLine = {
        from: client.sessionId,
        name: p.name,
        text,
        kind: "chat",
        role: p.role,
      };
      this.pushChat(line);
      for (const other of this.clients) {
        const op = this.state.players.get(other.sessionId);
        if (!op) continue;
        if (other.sessionId === client.sessionId || dist(p, op) <= CHAT_RADIUS) {
          other.send("chat", line);
        }
      }
    });

    this.onMessage("customize", (client, data: { name?: string; hat?: string; top?: string; accessory?: string; body?: string }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof data?.name === "string") {
        const rawName = sanitizeDisplayName(data.name);
        if (rawName && rawName !== p.name) {
          if (!isCleanDisplayName(rawName)) {
            client.send("chat", {
              from: "system",
              name: "Klase",
              text: "That name isn't allowed.",
              kind: "system",
            } satisfies ChatLine);
          } else {
            // Same reserved-name rule as join. Self-customize only — nobody can rename someone else.
            void canUseName(p.role as Role, rawName, p.userId).then((ok) => {
              if (!this.state.players.has(client.sessionId)) return;
              if (ok) {
                p.name = rawName;
                if (p.role === "owner" || p.role === "admin") rememberPrivileged(rawName, p.userId);
                if (p.userId) void saveLook(p.userId, { hat: p.hat, top: p.top, accessory: p.accessory, body: p.body === "y" ? "y" : "x" }, rawName);
              } else {
                client.send("chat", {
                  from: "system",
                  name: "Klase",
                  text: "That name is reserved.",
                  kind: "system",
                } satisfies ChatLine);
              }
            });
          }
        }
      }
      const look = normalizeLook({
        hat: String(data?.hat ?? p.hat),
        top: String(data?.top ?? p.top),
        accessory: String(data?.accessory ?? p.accessory),
        body: data?.body === "y" ? "y" : "x",
      });
      p.hat = allowed(WEARABLES.hat, look.hat);
      p.top = allowed(WEARABLES.top, look.top);
      p.accessory = allowed(WEARABLES.accessory, look.accessory);
      p.body = look.body;
      this.touch(client.sessionId);
      if (p.userId) void saveLook(p.userId, look);
    });

    this.onMessage("voice", (client, data: { to?: string; type?: string; payload?: unknown }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      const from = this.state.players.get(client.sessionId);
      if (!from || from.serverMuted) return;
      const toId = String(data?.to ?? "");
      // Look up target WebSocket client by sessionId
      const target = this.clients.find((c) => c.sessionId === toId);
      if (!target || toId === client.sessionId) return;
      target.send("voice", {
        from: client.sessionId,
        type: String(data?.type ?? ""),
        payload: data?.payload,
      });
    });

    this.onMessage("voice-level", (client, data: { level?: number }) => {
      if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
      if (!this.state.players.has(client.sessionId)) return;
      const level = Math.max(0, Math.min(1, Number(data?.level) || 0));
      this.broadcast("voice-level", { from: client.sessionId, level }, { except: client });
    });

    this.onMessage(
      "moderate",
      (client, data: {
        action?: string;
        targetId?: string;
        targetIds?: string[];
        reason?: string;
        message?: string;
        cooldownSec?: number;
        permanent?: boolean;
      }) => {
        if (!this.joined.has(client.sessionId)) return; // reject pre-join connections
        const actor = this.state.players.get(client.sessionId);
        if (!actor) return;
        const extras: ModerationExtras = {
          actorName: actor.name,
          reason: data?.reason,
          message: data?.message,
          cooldownSec: data?.cooldownSec,
          permanent: data?.permanent,
          targetIds: Array.isArray(data?.targetIds) ? data.targetIds.map(String) : undefined,
        };
        const action = String(data?.action ?? "");
        if (action === "announce") {
          this.staffSpeak(actor.role as Role, actor.name, String(data?.message ?? data?.reason ?? ""), "");
          return;
        }
        if (action === "message") {
          const ids = extras.targetIds?.length ? extras.targetIds : [String(data?.targetId ?? "")];
          for (const id of ids) this.staffSpeak(actor.role as Role, actor.name, String(data?.message ?? ""), id);
          return;
        }
        if (action === "kick-all") this.kickAllRegulars(actor.role as Role, extras);
        else {
          const ids = extras.targetIds?.length ? extras.targetIds : [String(data?.targetId ?? "")];
          for (const id of ids) this.applyModeration(actor.role as Role, id, action, extras);
        }
      },
    );

    this.onMessage("noclip", (client, data: { on?: boolean }) => {
      if (!this.joined.has(client.sessionId)) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.observer) return;
      if (p.role !== "owner" && p.role !== "admin") return;
      p.noclip = Boolean(data?.on);
      p.seatId = "";
      if (!p.noclip) {
        const c = clampClassroom(p.x, p.z);
        p.x = c.x;
        p.z = c.z;
      }
      this.touch(client.sessionId);
    });

    this.onMessage("staff-message", (client, data: { to?: string; text?: string }) => {
      if (!this.joined.has(client.sessionId)) return;
      const actor = this.state.players.get(client.sessionId);
      if (!actor || (actor.role !== "owner" && actor.role !== "admin")) return;
      const raw = String(data?.text ?? "").slice(0, 240).trim();
      if (!raw) return;
      const text = filterChat(raw);
      const toId = String(data?.to ?? "");
      const who = actor.role === "owner" ? "Owner" : "Admin";
      if (toId) {
        const target = this.state.players.get(toId);
        if (!target || target.observer) return;
        const tClient = this.clients.find((c) => c.sessionId === toId);
        if (!tClient) return;
        const line: ChatLine = {
          from: client.sessionId,
          name: actor.name,
          text: `${who} ${actor.name} → ${target.name}: ${text}`,
          kind: "whisper",
          role: actor.role,
        };
        // Not stored in the room log — a whisper shouldn't leak to later joiners.
        client.send("chat", line);
        tClient.send("chat", line);
        return;
      }
      const line: ChatLine = {
        from: client.sessionId,
        name: actor.name,
        text: `${who} ${actor.name}: ${text}`,
        kind: "announce",
        role: actor.role,
      };
      this.pushChat(line);
      this.broadcast("chat", line);
    });

    this.clock.setInterval(() => {
      const now = Date.now();
      for (const client of [...this.clients]) {
        // Only apply idle timeout to fully-joined players
        if (!this.joined.has(client.sessionId)) continue;
        const t = this.lastActive.get(client.sessionId) ?? now;
        const p = this.state.players.get(client.sessionId);
        const limit = p && (p.role === "owner" || p.role === "admin") ? STAFF_IDLE_MS : IDLE_MS;
        if (now - t < limit) continue;
        client.send("dropped", { reason: "idle" });
        client.leave(4002);
      }
    }, 1000);
  }

  /**
   * The single place moderation is executed — used by the in-room "moderate" message and by the
   * admin dashboard. Permission rules live only in assertCanModerate (roles.ts).
   * Returns false when the target is not in this room.
   */
  applyModeration(actorRole: Role, targetId: string, action: string, extras: ModerationExtras = {}): boolean {
    const target = this.state.players.get(targetId);
    if (!target || target.observer) return false;
    assertCanModerate(actorRole, target.role as Role, action);

    const actorName = extras.actorName || "staff";
    const staffRole = actorRole === "admin" ? "admin" : "owner";
    const who = staffRole === "owner" ? "Owner" : "Admin";
    const reason = String(extras.reason ?? "").trim().slice(0, 80);
    const message = filterChat(String(extras.message ?? "").trim().slice(0, MOD_MESSAGE_MAX));
    const permanent = extras.permanent === true && action === "ban";
    let cooldownSec = Math.max(0, Math.min(MOD_DURATION_MAX_SEC, Math.floor(Number(extras.cooldownSec) || 0)));
    if (permanent) cooldownSec = 0;
    let verb = "";

    if (action === "mute") {
      target.serverMuted = true;
      verb = `muted ${target.name}`;
    }
    if (action === "unmute") {
      target.serverMuted = false;
      verb = `unmuted ${target.name}`;
    }
    if (action === "kick") {
      verb = `kicked ${target.name}`;
      if (reason) verb += ` (${reason})`;
      const until = cooldownSec ? Date.now() + cooldownSec * 1000 : Date.now();
      if (cooldownSec) {
        void putHold(target.userId, target.name, {
          kind: "kick",
          until,
          reason,
          message,
          actorName,
          actorRole: staffRole,
        });
      }
      this.quietLeave.add(target.sessionId);
      this.sendNotice(target.sessionId, {
        kind: "kick",
        actorRole: staffRole,
        actorName,
        reason,
        message,
        until: cooldownSec ? until : Date.now(),
      });
      this.clients.find((c) => c.sessionId === target.sessionId)?.leave(4000);
    }
    if (action === "ban") {
      verb = `banned ${target.name}`;
      if (reason) verb += ` (${reason})`;
      banName(target.name);
      const until = permanent ? null : cooldownSec ? Date.now() + cooldownSec * 1000 : null;
      if (permanent && target.userId) void setBanned(target.userId, true);
      void putHold(target.userId, target.name, {
        kind: "ban",
        until,
        reason,
        message,
        actorName,
        actorRole: staffRole,
      });
      this.quietLeave.add(target.sessionId);
      this.sendNotice(target.sessionId, {
        kind: "ban",
        actorRole: staffRole,
        actorName,
        reason,
        message,
        until,
      });
      this.clients.find((c) => c.sessionId === target.sessionId)?.leave(4001);
    }
    if (action === "promote") {
      target.role = "admin";
      if (target.userId) void setRole(target.userId, "admin");
      rememberPrivileged(target.name, target.userId);
      verb = `promoted ${target.name} to admin`;
    }
    if (action === "demote") {
      target.role = "user";
      if (target.userId) void setRole(target.userId, "user");
      invalidateReservedNames();
      verb = `demoted ${target.name}`;
    }

    if (verb) {
      const line: ChatLine = {
        from: "system",
        name: "Klase",
        text: `${who} ${actorName} ${verb}`,
        kind: "system",
      };
      this.pushChat(line);
      this.broadcast("chat", line);
    }
    return true;
  }

  private sendNotice(sessionId: string, notice: ModerationNotice) {
    this.clients.find((c) => c.sessionId === sessionId)?.send("moderation-notice", notice);
  }

  staffSpeak(actorRole: Role, actorName: string, raw: string, toId: string) {
    if (actorRole !== "owner" && actorRole !== "admin") return false;
    const text = filterChat(raw.trim().slice(0, MOD_MESSAGE_MAX));
    if (!text) return false;
    const who = actorRole === "owner" ? "Owner" : "Admin";
    if (toId) {
      const target = this.state.players.get(toId);
      if (!target || target.observer) return false;
      const tClient = this.clients.find((c) => c.sessionId === toId);
      if (!tClient) return false;
      const line: ChatLine = {
        from: "system",
        name: actorName,
        text: `${who} ${actorName} → ${target.name}: ${text}`,
        kind: "whisper",
        role: actorRole,
      };
      tClient.send("chat", line);
      return true;
    }
    const line: ChatLine = {
      from: "system",
      name: actorName,
      text: `${who} ${actorName}: ${text}`,
      kind: "announce",
      role: actorRole,
    };
    this.pushChat(line);
    this.broadcast("chat", line);
    return true;
  }

  kickAllRegulars(actorRole: Role, extras: ModerationExtras = {}): boolean {
    if (actorRole === "user") return false;
    let any = false;
    for (const p of [...this.state.players.values()]) {
      if (p.role !== "user" || p.observer) continue;
      if (this.applyModeration(actorRole, p.sessionId, "kick", extras)) any = true;
    }
    return any;
  }

  async onAuth(
    _client: Client,
    options: { name?: string; hat?: string; top?: string; accessory?: string; body?: string; accessToken?: string; god?: boolean; staffJoin?: boolean },
  ) {
    return resolveIdentity(options);
  }

  onJoin(client: Client) {
    const ident = client.auth as Awaited<ReturnType<typeof resolveIdentity>>;
    // Observe (god) and staff skip capacity. Regulars hit both the 12-user cap and the room ceiling.
    if (!ident.god && ident.role === "user") {
      const regulars = [...this.state.players.values()].filter((p) => p.role === "user").length;
      if (regulars >= REGULAR_CAP || this.state.players.size >= ROOM_CEILING) {
        throw new ServerError(403, "ROOM_FULL");
      }
    }

    const i = this.state.players.size;
    const p = new Player();
    p.sessionId = client.sessionId;
    p.name = ident.name;
    p.role = ident.role;
    p.userId = ident.userId;
    p.x = SPAWN.x + (i % 3) * 0.4;
    p.y = 0;
    p.z = SPAWN.z + Math.floor(i / 3) * 0.4;
    p.rotY = SPAWN.rotY;
    p.hat = allowed(WEARABLES.hat, ident.look.hat);
    p.top = allowed(WEARABLES.top, ident.look.top);
    p.accessory = allowed(WEARABLES.accessory, ident.look.accessory);
    p.body = ident.look.body;
    p.seatId = "";
    p.observer = ident.god;
    this.state.players.set(client.sessionId, p);
    this.touch(client.sessionId);
    // Mark this client as a fully-joined real player — now messages will be processed
    this.joined.add(client.sessionId);
    this.syncMeta();

    // God mode is silent: no join announcement.
    if (ident.god) return;

    if (ident.role === "owner") {
      const roomLabel = formatRoomLabel(this.state.roomKey);
      const ownerNameStr = supabaseEnabled() ? ident.name : ownerName();
      const ownerJoinLine: ChatLine = {
        from: "system",
        name: "Klase",
        text: `Owner ${ownerNameStr} has joined ${roomLabel}`,
        kind: "join-owner",
      };
      // Broadcast owner join to ALL active rooms across the server
      for (const roomInstance of ClassroomRoom.activeRooms) {
        roomInstance.pushChat(ownerJoinLine);
        roomInstance.broadcast("chat", ownerJoinLine);
      }
    } else {
      const joinLine: ChatLine =
        ident.role === "admin"
          ? {
              from: "system",
              name: "Klase",
              text: `Admin ${ident.name} has joined`,
              kind: "join-admin",
            }
          : {
              from: "system",
              name: "Klase",
              text: `${ident.name} has joined`,
              kind: "join",
            };
      this.pushChat(joinLine);
      this.broadcast("chat", joinLine, { except: client });
    }
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    this.lastActive.delete(client.sessionId);
    // Remove from joined set — this session is no longer a real player
    this.joined.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.syncMeta();
    if (!p || p.observer || this.quietLeave.delete(client.sessionId)) return;
    const leaveLine: ChatLine =
      p.role === "owner"
        ? {
            from: "system",
            name: "Klase",
            text: `Owner ${p.name} has left`,
            kind: "leave-owner",
          }
        : p.role === "admin"
          ? {
              from: "system",
              name: "Klase",
              text: `Admin ${p.name} has left`,
              kind: "leave-admin",
            }
          : {
              from: "system",
              name: "Klase",
              text: `${p.name} has left`,
              kind: "leave",
            };
    this.pushChat(leaveLine);
    this.broadcast("chat", leaveLine);
  }

  onDispose() {
    ClassroomRoom.activeRooms.delete(this);
  }

  private syncMeta() {
    // Filter regular users and count length
    const regulars = [...this.state.players.values()].filter((p) => p.role === "user").length;
    this.setMetadata({ roomKey: this.state.roomKey, regulars, clients: this.state.players.size });
  }
}
