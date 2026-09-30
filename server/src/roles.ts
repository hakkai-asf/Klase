import { ServerError } from "@colyseus/core";
import type { Look, Role } from "@klase/shared";
import {
  loadProfile,
  roleForAccount,
  supabaseEnabled,
  userFromToken,
} from "./supabase.js";

const banned = new Set<string>();
const admins = new Set(
  (process.env.KLASE_ADMIN_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function ownerName() {
  return (process.env.KLASE_OWNER_NAME ?? "Hakkai").trim();
}

export function resolveGuestRole(name: string): Role {
  if (supabaseEnabled()) return "user";
  const n = name.trim().toLowerCase();
  if (n === ownerName().toLowerCase()) return "owner";
  if (admins.has(n)) return "admin";
  return "user";
}

export function isBannedGuest(name: string, sessionHint: string) {
  return banned.has(name.trim().toLowerCase()) || banned.has(sessionHint);
}

export function banName(name: string) {
  banned.add(name.trim().toLowerCase());
}

export type Identity = {
  name: string;
  role: Role;
  look: Look;
  userId: string;
};

// This function is async because it performs I/O operations (fetching user token & profile)
export async function resolveIdentity(options: {
  name?: string;
  hat?: string;
  top?: string;
  accessory?: string;
  body?: string;
  accessToken?: string;
}): Promise<Identity> {
  const guestLook: Look = {
    hat: String(options?.hat ?? ""),
    top: String(options?.top ?? ""),
    accessory: String(options?.accessory ?? ""),
    body: options?.body === "y" ? "y" : "x",
  };
  const guestName = String(options?.name ?? "Guest").trim().slice(0, 24) || "Guest";

  if (options?.accessToken && supabaseEnabled()) {
    // Suspends execution while fetching user from token
    const user = await userFromToken(options.accessToken);
    if (!user) throw new ServerError(401, "AUTH");
    // Suspends execution while fetching the user's profile
    const profile = await loadProfile(user.id);
    if (profile?.banned) throw new ServerError(403, "BANNED");
    const role = roleForAccount(user, profile);
    return {
      name: (profile?.display_name || guestName).slice(0, 24),
      role,
      look: profile
        ? { hat: profile.hat, top: profile.top, accessory: profile.accessory, body: guestLook.body }
        : guestLook,
      userId: user.id,
    };
  }

  if (isBannedGuest(guestName, "")) throw new ServerError(403, "BANNED");
  // Fast-path for guests, no await required
  return {
    name: guestName,
    role: resolveGuestRole(guestName),
    look: guestLook,
    userId: "",
  };
}

export function assertCanModerate(actorRole: Role, targetRole: Role, action: string) {
  if (actorRole === "user") {
    throw new ServerError(403, "NO_PERMISSION");
  }
  if (targetRole === "owner") {
    throw new ServerError(403, "IMMUNE");
  }
  if (actorRole === "admin" && targetRole === "admin") {
    throw new ServerError(403, "ADMIN_VS_ADMIN");
  }
  if (action === "promote" || action === "demote") {
    if (actorRole !== "owner") throw new ServerError(403, "NO_PERMISSION");
  }
}
