import { Room, Client, ServerError } from "@colyseus/core";
import { CHAT_LOG_MAX, CHAT_RADIUS, CLASSROOM, IDLE_MS, REGULAR_CAP, SEAT_REACH, SPAWN, WEARABLES, classroomSeats, clampClassroom, normalizeLook, resolvePlayerMove } from "@klase/shared";
import { ClassroomState, Player } from "./schema.js";
import { filterChat } from "./chatFilter.js";
import { assertCanModerate, banName, ownerName, resolveIdentity } from "./roles.js";
import { saveLook, setBanned, setRole, supabaseEnabled } from "./supabase.js";

function allowed(list: readonly string[], value: string) {
  return (list as readonly string[]).includes(value) ? value : "";
}

function dist(a: Player, b: Player) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

type ChatLine = { from: string; name: string; text: string; kind: string };

export class ClassroomRoom extends Room<ClassroomState> {
  maxClients = 48;
  private chatLog: ChatLine[] = [];
  private lastActive = new Map<string, number>();

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
    this.setState(new ClassroomState());
    this.state.roomKey = String(options.roomKey ?? "klase-1");
    this.syncMeta();

    this.onMessage("move", (client, data: { x: number; z: number; rotY: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.seatId) return;
      if (typeof data.x !== "number" || typeof data.z !== "number") return;
      const clamped = clampClassroom(data.x, data.z);
      // Filter out self, then map to just x,z coordinates for collision checking
      const others = [...this.state.players.values()]
        .filter((o) => o.sessionId !== p.sessionId)
        .map((o) => ({ x: o.x, z: o.z }));
      const sep = resolvePlayerMove(p.x, p.z, clamped.x, clamped.z, others);
      p.x = sep.x;
      p.z = sep.z;
      p.rotY = Number(data.rotY) || 0;
      this.touch(client.sessionId);
    });

    const seats = classroomSeats();
    this.onMessage("sit", (client, data: { seatId?: string }) => {
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
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.seatId = "";
      this.touch(client.sessionId);
    });

    this.onMessage("poke", (client) => {
      if (this.state.players.has(client.sessionId)) this.touch(client.sessionId);
    });

    this.onMessage("need-history", (client) => {
      if (!this.state.players.has(client.sessionId)) return;
      // Send a non-destructive copy of the chat history
      client.send("chat-history", this.chatLog.slice());
    });

    this.onMessage("chat", (client, data: { text?: string }) => {
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
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof data?.name === "string") {
        const rawName = data.name.trim().slice(0, 24);
        if (rawName) p.name = rawName;
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
      const from = this.state.players.get(client.sessionId);
      if (!from) return;
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
      if (!this.state.players.has(client.sessionId)) return;
      const level = Math.max(0, Math.min(1, Number(data?.level) || 0));
      this.broadcast("voice-level", { from: client.sessionId, level }, { except: client });
    });

    this.onMessage(
      "moderate",
      (client, data: { action?: string; targetId?: string }) => {
        const actor = this.state.players.get(client.sessionId);
        if (!actor) return;
        const target = this.state.players.get(String(data?.targetId ?? ""));
        if (!target) return;
        const action = String(data?.action ?? "");
        assertCanModerate(actor.role as never, target.role as never, action);

        if (action === "mute") target.serverMuted = true;
        if (action === "unmute") target.serverMuted = false;
        if (action === "kick") {
          // Look up target WebSocket client by sessionId
          const tClient = this.clients.find((c) => c.sessionId === target.sessionId);
          tClient?.leave(4000);
        }
        if (action === "ban") {
          banName(target.name);
          if (target.userId) void setBanned(target.userId, true);
          // Look up target WebSocket client by sessionId
          const tClient = this.clients.find((c) => c.sessionId === target.sessionId);
          tClient?.leave(4001);
        }
        if (action === "promote") {
          target.role = "admin";
          if (target.userId) void setRole(target.userId, "admin");
        }
        if (action === "demote") {
          target.role = "user";
          if (target.userId) void setRole(target.userId, "user");
        }
      },
    );

    this.clock.setInterval(() => {
      const now = Date.now();
      for (const client of [...this.clients]) {
        const t = this.lastActive.get(client.sessionId) ?? now;
        if (now - t < IDLE_MS) continue;
        client.send("dropped", { reason: "idle" });
        client.leave(4002);
      }
    }, 1000);
  }

  async onAuth(
    _client: Client,
    options: { name?: string; hat?: string; top?: string; accessory?: string; body?: string; accessToken?: string },
  ) {
    return resolveIdentity(options);
  }

  onJoin(client: Client) {
    const ident = client.auth as Awaited<ReturnType<typeof resolveIdentity>>;
    // Filter regular users and count length to enforce room capacity
    const regulars = [...this.state.players.values()].filter((p) => p.role === "user").length;
    if (ident.role === "user" && regulars >= REGULAR_CAP) {
      throw new ServerError(403, "ROOM_FULL");
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
    this.state.players.set(client.sessionId, p);
    this.touch(client.sessionId);
    this.syncMeta();

    const joinLine: ChatLine =
      ident.role === "owner"
        ? {
            from: "system",
            name: "Klase",
            text: `Owner ${supabaseEnabled() ? ident.name : ownerName()} has joined`,
            kind: "join-owner",
          }
        : ident.role === "admin"
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

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    this.lastActive.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.syncMeta();
    if (!p) return;
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

  private syncMeta() {
    // Filter regular users and count length
    const regulars = [...this.state.players.values()].filter((p) => p.role === "user").length;
    this.setMetadata({ roomKey: this.state.roomKey, regulars, clients: this.state.players.size });
  }
}
