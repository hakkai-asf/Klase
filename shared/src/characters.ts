export type CharacterDef = {
  id: string;
  name: string;
  file: string;
  tag?: string;
  heightM?: number;
  rotX?: number;
  rotY?: number;
  yOffset?: number;
  tagLift?: number;
};

export const DEFAULT_CHARACTER = "x";

export const CHARACTERS = [
  { id: "x", name: "X Bot", file: "Xbot.skinned.glb", tag: "Character", heightM: 1.7 },
  { id: "y", name: "Y Bot", file: "Xbot.skinned.glb", tag: "Character", heightM: 1.7 },
  { id: "swat", name: "SWAT Operator", file: "s.w.a.t_operator_cop_-_game_ready_animated.glb", tag: "Character", heightM: 1.7 },
  { id: "hakkai", name: "Hakkai", file: "HAKKAI 3D1.glb", tag: "Character", heightM: 1.7 },
  { id: "boy", name: "Young Boy", file: "3d_character_young_boy.glb", tag: "Character", heightM: 1.55 },
  { id: "tupac", name: "Tupac", file: "2pac.glb", tag: "Character", heightM: 1.75, rotX: -Math.PI / 2 },
] as const satisfies readonly CharacterDef[];

export type BodyId = (typeof CHARACTERS)[number]["id"];

export const BODIES = CHARACTERS.map((c) => c.id) as readonly BodyId[];

export const BODY_LABELS = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.name])) as Record<BodyId, string>;

const ID_SET = new Set<string>(BODIES);

export function isCharacterId(v: unknown): v is BodyId {
  return typeof v === "string" && ID_SET.has(v);
}

export function normalizeCharacterId(v: unknown): BodyId {
  return isCharacterId(v) ? v : DEFAULT_CHARACTER;
}

export function characterById(v: unknown): CharacterDef {
  const id = normalizeCharacterId(v);
  return (CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]) as CharacterDef;
}
