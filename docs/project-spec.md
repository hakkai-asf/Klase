# Klase — Project Spec

## Concept
Real-time 3D multiplayer classroom simulation web app. Inspired by Bondee (avatar customization/charm) and Gather.town (room movement + proximity chat). Users walk around a shared virtual classroom, chat with people near them, and customize their avatar.

## Tech Stack
- **Rendering:** Three.js (browser-based 3D, no installs)
- **Real-time multiplayer:** Colyseus (authoritative server, room-based, matchmaking, capacity limits built in)
- **Backend / Auth / DB:** Supabase (Postgres + Row Level Security fits the relational role/ban/room data better than Firebase; team already has Supabase experience)

## Camera
- **Default view:** locked orthographic isometric / 3/4 top-down (Bondee room view, Gang Beasts room-scale). The whole classroom stays readable. Camera pans slightly with the local player; it does **not** rotate with them, and is not first-person or free-orbit.
- **Input:** WASD/arrows are screen-relative on the floor.
- **Room dressing (v1):** simple classroom — floor, chalkboard, desk grid, cutaway walls facing the camera. Not a dense prop set.

## Avatar System
- Ready Player Me is not usable (developer API shutting down Jan 31, 2026).
- Body style: simple rounded/primitive-based humanoid shapes (inspired by Meccha Chameleon's minimal blank-body look) — built procedurally in Three.js, no external sculpted asset pack needed.
- Wearables: coded attachments (primitive shapes or small custom low-poly meshes) parented to body "sockets" (head, chest, hands, etc.), toggled on/off per user selection.
- Data model per user: `{ hat: 'cap_red', top: 'hoodie_blue', accessory: null, ... }`
- Guest mode: random default look, temp session ID, no persistence.
- Account mode: saved customization + persistent identity via Supabase auth.

## Rooms
- 3 classrooms, identical layout for v1.
- Capacity: **12 regular users per room**.
- Auto-join: user is placed in the first room with available space.
- If all 3 rooms are full, regular users see a "rooms full" error and cannot join.
- Movement: WASD/arrow keys, basic collision (walls, desks) — no physics engine needed.
- Chat: proximity-based (only see messages/players near you).

## Roles & Permissions
| Role | Powers |
|---|---|
| **Owner** (single account, the dev) | Promote/demote admins, kick, ban, mute anyone (including admins), bypass room cap, immune to being kicked/muted/banned |
| **Admin** (promoted by owner) | Kick, ban, mute regular users; bypass room cap; cannot act on owner (admin-vs-admin permissions: TBD) |
| **Regular user** | Normal join/leave; can only **locally mute** other users (client-side only, no effect on server state or other users) |

- All role checks enforced **server-side** in Colyseus — never trust client-side role claims.
- Room-cap bypass: admins/owner skip the `room.clients.length < 12` check entirely.
- Join announcements: owner/admin joins trigger a distinct system message (e.g. "👑 Owner Hakkai has joined" / "🛡️ Admin X has joined"). Regular users get a normal/plain join message (or none).

## Moderation
- **Text chat:** profanity filter (wordlist/regex + leetspeak normalization) applied before broadcasting messages.
- **Voice/mic:** proximity audio (same radius as text). HUD mic toggle, default off. Automated profanity detection is out of scope. Voice moderation is manual (admin/owner mute, plus client-side local mute).
- **Player list menu:** shows all players in the room; regular users can locally mute others (client-side only); admins/owner have global mute/kick/ban actions from the same or an extended menu.

## UI/UX Art Direction
Applies **only** to the 2D overlay: menus, buttons, chat panels, avatar customization screens, HUD, login/landing pages.

- **Style:** claymorphism — soft, puffy, rounded 3D-ish chrome with soft shadows and highlights.
- **Starting palette:** pale baby blue / dusty periwinkle as the base, paired with white/cream and sparse soft pastel accents.
- **Status:** starting aesthetic, not a locked brand system. Refine after real mockups.
- **Not this direction:** the Three.js classroom, furniture, lighting, and procedural avatars. Those keep their own art direction (simple rounded/primitive humanoids, coded wearables).

Working tokens, component recipes, and screen mapping live in [ui-style-guide.md](./ui-style-guide.md).

## Explicitly Out of Scope (v1)
- Ready Player Me or any external avatar API dependency
- Full cloth-physics or detailed sculpted wearable meshes
- Automated voice/mic profanity detection
- Global mute by regular users (local/client-side only)
- Applying claymorphism materials, lighting, or palettes to the 3D classroom or avatar meshes

## Naming
- **App name: Klase**
