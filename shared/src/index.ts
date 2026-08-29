export const ROOM_CODES = ["klase-1", "klase-2", "klase-3"] as const;
export type RoomCode = (typeof ROOM_CODES)[number];

export const REGULAR_CAP = 12;
export const CHAT_RADIUS = 6.5;
export const MOVE_SPEED = 5.2;

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
  width: 20,
  depth: 16,
  wallHeight: 3.2,
  wallThickness: 0.35,
};

export const DESK_GRID = {
  rows: 3,
  cols: 4,
  originX: -5.6,
  originZ: -1.7,
  spacingX: 3.7,
  spacingZ: 3.05,
  /** Combo faces the board (−Z). */
  rotY: Math.PI,
  /** Chair seat in local space after the combo is centered. */
  seatLocalX: 0,
  seatLocalZ: 0.32,
  /** Mixamo Sitting Idle faces +Z; do not add extra yaw or the pose reads as falling. */
  sitRotY: 0,
};

export const SEAT_REACH = 1.25;

export type Seat = { id: string; x: number; z: number; rotY: number };

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
      seats.push({ id: `s${row}-${col}`, x, z, rotY: DESK_GRID.sitRotY });
    }
  }
  return seats;
}

export type ChatKind = "chat" | "system" | "join-owner" | "join-admin";
