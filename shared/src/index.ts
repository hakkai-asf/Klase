export const ROOM_CODES = ["klase-1", "klase-2", "klase-3"] as const;
export type RoomCode = (typeof ROOM_CODES)[number];

export const REGULAR_CAP = 12;
export const CHAT_RADIUS = 6.5;
export const MOVE_SPEED = 2.6;
export const PLAYER_RADIUS = 0.2;
/** Graze slack so exact 2-radius contact does not glue. */
export const PLAYER_SKIN = 0.02;
export const CHAT_LOG_MAX = 40;
export const IDLE_MS = 180_000;
/** Owner/admin idle disconnect. Regulars still use IDLE_MS. */
export const STAFF_IDLE_MS = 30 * 60_000;
export const MOD_REASONS = ["Spamming", "Harassment", "Inappropriate name", "Disrupting class", "Other"] as const;
export type ModReason = (typeof MOD_REASONS)[number];
export const MOD_MESSAGE_MAX = 200;
export const MOD_NAME_MAX = 24;
/** Default in-world name for a verified owner/admin. Not a privilege — the token is. */
export const DEFAULT_STAFF_NAME = "Hakkai";
export const MOD_DURATION_MAX_SEC = 30 * 24 * 3600;
export const MOD_DURATIONS = [
  { label: "5 min", sec: 5 * 60 },
  { label: "15 min", sec: 15 * 60 },
  { label: "1 hour", sec: 60 * 60 },
  { label: "1 day", sec: 24 * 60 * 60 },
  { label: "7 days", sec: 7 * 24 * 60 * 60 },
] as const;

export type ModerationNotice = {
  kind: "kick" | "ban";
  actorRole: "owner" | "admin";
  actorName: string;
  reason: string;
  message: string;
  until: number | null;
};

export function clockRemain(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function humanRemain(ms: number) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hour${hr === 1 ? "" : "s"}`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

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
  cutZ: 0.35,
};

/** Just inside the left-wall back door, facing the board. */
export const SPAWN = {
  x: -CLASSROOM.width / 2 + CLASSROOM.wallThickness + 1.1,
  z: CLASSROOM.cutZ - CLASSROOM.wallThickness - 0.62 - 0.69,
  rotY: Math.PI,
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

const PLAYER_HIT = PLAYER_RADIUS * 2 - PLAYER_SKIN;
const PLAYER_NUDGE = PLAYER_RADIUS * 2 + 0.04;

function playerBlocked(
  px: number,
  pz: number,
  fromX: number,
  fromZ: number,
  others: { x: number; z: number }[],
) {
  return others.some((o) => {
    const next = Math.hypot(px - o.x, pz - o.z);
    if (next >= PLAYER_HIT) return false;
    const prev = Math.hypot(fromX - o.x, fromZ - o.z);
    return !(prev < PLAYER_HIT && next > prev);
  });
}

/** Push overlapping circles apart to a small gap. Sitters stay in `others` (solid). */
export function nudgeFromPlayers(x: number, z: number, others: { x: number; z: number }[]) {
  let px = x;
  let pz = z;
  let hit = false;
  for (const o of others) {
    let dx = px - o.x;
    let dz = pz - o.z;
    let d = Math.hypot(dx, dz);
    if (d >= PLAYER_HIT) continue;
    if (d < 1e-5) {
      dx = 1;
      dz = 0;
      d = 1;
    }
    const s = PLAYER_NUDGE / d;
    px = o.x + dx * s;
    pz = o.z + dz * s;
    hit = true;
  }
  return hit ? clampClassroom(px, pz) : { x, z };
}

/**
 * Axis-split player vs player. Overlap may only persist while the step
 * increases distance; idle overlap nudges apart.
 */
export function resolvePlayerMove(
  x: number,
  z: number,
  tryX: number,
  tryZ: number,
  others: { x: number; z: number }[],
) {
  if (Math.abs(tryX - x) < 1e-8 && Math.abs(tryZ - z) < 1e-8) {
    return nudgeFromPlayers(x, z, others);
  }
  let nx = tryX;
  let nz = tryZ;
  if (playerBlocked(nx, z, x, z, others)) nx = x;
  if (playerBlocked(nx, nz, nx, z, others)) nz = z;
  return { x: nx, z: nz };
}

export const DESK_GRID = {
  rows: 5,
  cols: 10,
  originX: -5.58,
  originZ: -10.25,
  spacingX: 0.92,
  spacingZ: 1.58,
  /** Extra X gap after this many left-side chairs (5 | aisle | 5). */
  aisleAfter: 5,
  aisleWidth: 2.88,
  /** nu-chair forward is local +X; π/2 maps that to the board (−Z). */
  rotY: Math.PI / 2,
  /**
   * Seat pan in un-rotated chair space after height fit 1.24.
   * −X is toward the backrest; −Z is away from the tablet (sitter’s left).
   */
  seatLocalX: -0.10,
  seatLocalZ: -0.04,
  /** Mixamo Sitting Idle faces +Z; π turns the avatar toward the board. */
  sitRotY: Math.PI,
  /** Root height so Mixamo hips land on the pan (~0.64 m), not above it. */
  sitY: 0.22,
};

export function deskCell(col: number, row: number) {
  const aisle = col >= DESK_GRID.aisleAfter ? DESK_GRID.aisleWidth : 0;
  return {
    x: DESK_GRID.originX + col * DESK_GRID.spacingX + aisle,
    z: DESK_GRID.originZ + row * DESK_GRID.spacingZ,
  };
}

/** Six chairs centered on the back wall, facing the board. */
export const BACK_CHAIRS = {
  count: 6,
  originX: -2.3,
  originZ: CLASSROOM.cutZ - CLASSROOM.wallThickness - 0.62,
  spacingX: 0.92,
};

export function backChairCell(i: number) {
  return {
    x: BACK_CHAIRS.originX + i * BACK_CHAIRS.spacingX,
    z: BACK_CHAIRS.originZ,
  };
}

export const SEAT_REACH = 1.25;

export type Seat = { id: string; x: number; z: number; y: number; rotY: number };

export function classroomSeats(): Seat[] {
  const seats: Seat[] = [];
  const c = Math.cos(DESK_GRID.rotY);
  const s = Math.sin(DESK_GRID.rotY);
  for (let row = 0; row < DESK_GRID.rows; row++) {
    for (let col = 0; col < DESK_GRID.cols; col++) {
      const { x: ox, z: oz } = deskCell(col, row);
      const x = ox + DESK_GRID.seatLocalX * c + DESK_GRID.seatLocalZ * s;
      const z = oz - DESK_GRID.seatLocalX * s + DESK_GRID.seatLocalZ * c;
      seats.push({ id: `s${row}-${col}`, x, y: DESK_GRID.sitY, z, rotY: DESK_GRID.sitRotY });
    }
  }
  for (let i = 0; i < BACK_CHAIRS.count; i++) {
    const { x: ox, z: oz } = backChairCell(i);
    const x = ox + DESK_GRID.seatLocalX * c + DESK_GRID.seatLocalZ * s;
    const z = oz - DESK_GRID.seatLocalX * s + DESK_GRID.seatLocalZ * c;
    seats.push({ id: `sb-${i}`, x, y: DESK_GRID.sitY, z, rotY: DESK_GRID.sitRotY });
  }
  return seats;
}

export type ChatKind =
  | "chat"
  | "system"
  | "announce"
  | "whisper"
  | "join-owner"
  | "join-admin"
  | "join"
  | "leave"
  | "leave-owner"
  | "leave-admin";

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
