import { Room, Client, ServerError } from "@colyseus/core";
import { CHAT_RADIUS, REGULAR_CAP, SEAT_REACH, WEARABLES, classroomSeats, normalizeLook } from "@klase/shared";
import { ClassroomState, Player } from "./schema.js";
import { filterProfanity } from "./chatFilter.js";
import { assertCanModerate, banName, ownerName, resolveIdentity } from "./roles.js";
import { saveLook, setBanned, setRole, supabaseEnabled } from "./supabase.js";

function allowed(list: readonly string[], value: string) {
  return (list as readonly string[]).includes(value) ? value : "";
}

function dist(a: Player, b: Player) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export class ClassroomRoom extends Room<ClassroomState> {
  maxClients = 48;

  onCreate(options: { roomKey?: string }) {
    this.setState(new ClassroomState());
    this.state.roomKey = String(options.roomKey ?? "klase-1");
    this.syncMeta();

    this.onMessage("move", (client, data: { x: number; z: number; rotY: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.seatId) return;
      if (typeof data.x !== "number" || typeof data.z !== "number") return;
      p.x = Math.max(-9.2, Math.min(9.2, data.x));
      p.z = Math.max(-7.2, Math.min(7.2, data.z));
      p.rotY = Number(data.rotY) || 0;
    });

    const seats = classroomSeats();
    this.onMessage("sit", (client, data: { seatId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const seat = seats.find((s) => s.id === String(data?.seatId ?? ""));
      if (!seat) return;
      const taken = [...this.state.players.values()].some(
        (o) => o.sessionId !== p.sessionId && o.seatId === seat.id,
      );
      if (taken) return;
      if (Math.hypot(p.x - seat.x, p.z - seat.z) > SEAT_REACH + 0.4) return;
      p.seatId = seat.id;
      p.x = seat.x;
      p.z = seat.z;
      p.rotY = seat.rotY;
    });

    this.onMessage("stand", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.seatId = "";
    });

    this.onMessage("chat", (client, data: { text?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.serverMuted) return;
      const raw = String(data?.text ?? "").slice(0, 240).trim();
      if (!raw) return;
      const text = filterProfanity(raw);
      for (const other of this.clients) {
        const op = this.state.players.get(other.sessionId);
        if (!op) continue;
        if (other.sessionId === client.sessionId || dist(p, op) <= CHAT_RADIUS) {
          other.send("chat", {
            from: client.sessionId,
            name: p.name,
            text,
            kind: "chat",
          });
        }
      }
    });

    this.onMessage("customize", (client, data: { hat?: string; top?: string; accessory?: string; body?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
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
      if (p.userId) void saveLook(p.userId, look);
    });

    this.onMessage("voice", (client, data: { to?: string; type?: string; payload?: unknown }) => {
      const from = this.state.players.get(client.sessionId);
      if (!from || from.serverMuted) return;
      const toId = String(data?.to ?? "");
      const target = this.clients.find((c) => c.sessionId === toId);
      if (!target || toId === client.sessionId) return;
      target.send("voice", {
        from: client.sessionId,
        type: String(data?.type ?? ""),
        payload: data?.payload,
      });
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
          const tClient = this.clients.find((c) => c.sessionId === target.sessionId);
          tClient?.leave(4000);
        }
        if (action === "ban") {
          banName(target.name);
          if (target.userId) void setBanned(target.userId, true);
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
  }

  async onAuth(
    _client: Client,
    options: { name?: string; hat?: string; top?: string; accessory?: string; body?: string; accessToken?: string },
  ) {
    return resolveIdentity(options);
  }

  onJoin(client: Client) {
    const ident = client.auth as Awaited<ReturnType<typeof resolveIdentity>>;
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
    p.x = -3 + (i % 6) * 1.2;
    p.y = 0;
    p.z = 5.5;
    p.rotY = Math.PI;
    p.hat = allowed(WEARABLES.hat, ident.look.hat);
    p.top = allowed(WEARABLES.top, ident.look.top);
    p.accessory = allowed(WEARABLES.accessory, ident.look.accessory);
    p.body = ident.look.body;
    p.seatId = "";
    this.state.players.set(client.sessionId, p);
    this.syncMeta();

    if (ident.role === "owner") {
      this.broadcast("chat", {
        from: "system",
        name: "Klase",
        text: `Owner ${supabaseEnabled() ? ident.name : ownerName()} has joined`,
        kind: "join-owner",
      });
    } else if (ident.role === "admin") {
      this.broadcast("chat", {
        from: "system",
        name: "Klase",
        text: `Admin ${ident.name} has joined`,
        kind: "join-admin",
      });
    }
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.syncMeta();
  }

  private syncMeta() {
    const regulars = [...this.state.players.values()].filter((p) => p.role === "user").length;
    this.setMetadata({ roomKey: this.state.roomKey, regulars, clients: this.state.players.size });
  }
}
