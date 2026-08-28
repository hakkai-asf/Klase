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

export type ChatKind = "chat" | "system" | "join-owner" | "join-admin";
