export const ROOM_CODES = ["klase-1", "klase-2", "klase-3"] as const;
export type RoomCode = (typeof ROOM_CODES)[number];

export const REGULAR_CAP = 12;
export const CHAT_RADIUS = 6.5;
export const MOVE_SPEED = 2.6;
export const PLAYER_RADIUS = 0.2;
export const CHAT_LOG_MAX = 40;
export const IDLE_MS = 180_000;

export type Role = "owner" | "admin" | "user";

export type WearableSlot = "hat" | "top" | "accessory";

export const BODIES = ["x", "y"] as const;
export type BodyId = (typeof BODIES)[number];

export const BODY_LABELS: Record<BodyId, string> = {
  x: "X Bot",
  y: "Y Bot",
};

export const WEARABLES = {
  hat: ["", "cap_red", "cap_blue", "beanie"] as const,
  top: ["", "hoodie_blue", "hoodie_pink", "vest"] as const,
  accessory: ["", "backpack", "scarf"] as const,
};

export type HatId = (typeof WEARABLES.hat)[number];
export type TopId = (typeof WEARABLES.top)[number];
export type AccessoryId = (typeof WEARABLES.accessory)[number];

export type Look = {
  hat: string;
  top: string;
  accessory: string;
  body: BodyId;
};

export function normalizeLook(look: Partial<Look> | null | undefined): Look {
  return {
    hat: String(look?.hat ?? ""),
    top: String(look?.top ?? ""),
    accessory: String(look?.accessory ?? ""),
    body: look?.body === "y" ? "y" : "x",
  };
}

export function randomLook(): Look {
  const pick = <T extends readonly string[]>(arr: T) =>
    arr[Math.floor(Math.random() * arr.length)]!;
  return {
    hat: pick(WEARABLES.hat),
    top: pick(WEARABLES.top),
    accessory: pick(WEARABLES.accessory),
    body: Math.random() < 0.5 ? "x" : "y",
  };
}

export const WEARABLE_LABELS: Record<string, string> = {
  "": "None",
  cap_red: "Red cap",
  cap_blue: "Blue cap",
  beanie: "Beanie",
  hoodie_blue: "Blue hoodie",
  hoodie_pink: "Pink hoodie",
  vest: "Vest",
  backpack: "Backpack",
  scarf: "Scarf",
};

export const CLASSROOM = {
  width: 14.16,
  depth: 29.28,
  wallHeight: 4.02,
  wallThickness: 0.35,
  /** Keep the board (−Z) half. Just behind the last chair row. */
  cutZ: 2.2,
};

export function clampClassroom(x: number, z: number) {
  const hx = CLASSROOM.width / 2 - CLASSROOM.wallThickness - 0.2;
  const minZ = -CLASSROOM.depth / 2 + CLASSROOM.wallThickness + 0.2;
  const maxZ = CLASSROOM.cutZ - CLASSROOM.wallThickness - 0.2;
  return {
    x: Math.max(-hx, Math.min(hx, x)),
    z: Math.max(minZ, Math.min(maxZ, z)),
  };
}

export const DESK_GRID = {
  rows: 3,
  cols: 4,
  originX: -4.7,
  originZ: -5.8,
  spacingX: 3.15,
  spacingZ: 3.05,
  /** nu-chair forward is local +X; π/2 maps that to the board (−Z). */
  rotY: Math.PI / 2,
  /**
   * Seat pan in un-rotated chair space (Object_23 after fit/center).
   * A few cm toward the backrest so the pelvis lands on the pan, not the front lip.
   */
  seatLocalX: 0.08,
  seatLocalZ: 0.07,
  /** Mixamo Sitting Idle faces +Z; π turns the avatar toward the board. */
  sitRotY: Math.PI,
  /** Extra root height so the pelvis rests on the chair, not through it. */
  sitY: 0.18,
};

export const SEAT_REACH = 1.25;

export type Seat = { id: string; x: number; z: number; y: number; rotY: number };

export function classroomSeats(): Seat[] {
  const seats: Seat[] = [];
  const c = Math.cos(DESK_GRID.rotY);
  const s = Math.sin(DESK_GRID.rotY);
  for (let row = 0; row < DESK_GRID.rows; row++) {
    for (let col = 0; col < DESK_GRID.cols; col++) {
      const ox = DESK_GRID.originX + col * DESK_GRID.spacingX;
      const oz = DESK_GRID.originZ + row * DESK_GRID.spacingZ;
      const x = ox + DESK_GRID.seatLocalX * c + DESK_GRID.seatLocalZ * s;
      const z = oz - DESK_GRID.seatLocalX * s + DESK_GRID.seatLocalZ * c;
      seats.push({ id: `s${row}-${col}`, x, y: DESK_GRID.sitY, z, rotY: DESK_GRID.sitRotY });
    }
  }
  return seats;
}

export type ChatKind = "chat" | "system" | "join-owner" | "join-admin" | "join" | "leave" | "leave-owner" | "leave-admin";

const LINK_RE =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|co|app|dev|xyz|me|tv|info|edu|gov)(?:\/\S*)?/gi;

function linkPattern() {
  return new RegExp(LINK_RE.source, "gi");
}

export function hasLink(text: string): boolean {
  return linkPattern().test(text);
}

export function redactLinks(text: string): string {
  return text.replace(linkPattern(), "***");
}
