import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

export class Player extends Schema {
  sessionId = "";
  name = "";
  role = "user";
  x = 0;
  y = 0;
  z = 0;
  rotY = 0;
  hat = "";
  top = "";
  accessory = "";
  body = "x";
  serverMuted = false;
  userId = "";
  seatId = "";
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  role: "string",
  x: "float32",
  y: "float32",
  z: "float32",
  rotY: "float32",
  hat: "string",
  top: "string",
  accessory: "string",
  body: "string",
  serverMuted: "boolean",
  userId: "string",
  seatId: "string",
});

export class ClassroomState extends Schema {
  roomKey = "";
  players = new MapSchema<Player>();
}
defineTypes(ClassroomState, {
  roomKey: "string",
  players: { map: Player },
});
