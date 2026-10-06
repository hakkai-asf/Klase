# Tasks: Admin Dashboard Enhancements

## Overview

Implementation is split into five layers executed in order:
1. **Shared constants** — new error codes exported from `shared/`
2. **Server: Supabase helpers** — any remaining gaps in `server/src/supabase.ts`
3. **Server: Colyseus room** — passcode-specific error codes in `ClassroomRoom.ts`
4. **Server: Express routes** — any missing route logic in `server/src/admin.ts`
5. **Client: Dashboard UI** — new sections in `client/src/admin.ts`

> All code must build without TypeScript errors. Run `tsc --noEmit` in `server/` and `client/` after each layer.

---

## Layer 1 — Shared Constants

- [ ] 1.1 Add `ROOM_LOCKED`, `PASSCODE_CONSUMED`, and `PASSCODE_EXPIRED` string constants to `shared/src/index.ts`
  - Append `export const ERROR_ROOM_LOCKED = "ROOM_LOCKED";`, `export const ERROR_PASSCODE_CONSUMED = "PASSCODE_CONSUMED";`, `export const ERROR_PASSCODE_EXPIRED = "PASSCODE_EXPIRED";` to the exports in `shared/src/index.ts`.
  - Verify the shared package builds (`cd shared && npx tsc --noEmit` or equivalent).

---

## Layer 2 — Server: Supabase Helpers

All required functions (`loadAdminPermissions`, `upsertAdminPermissions`, `ensureAdminPermissionsRow`, `loadAllAdminPermissions`, `loadRoomConfig`, `loadAllRoomConfigs`, `setRoomLocked`, `loadWhitelistForRoom`, `checkWhitelistEntry`, `consumeWhitelistEntry`, `addWhitelistEntry`, `removeWhitelistEntry`, `searchAccounts`) are already implemented in `server/src/supabase.ts`. No new functions are required.

- [~] 2.1 Verify `checkWhitelistEntry` surfaces expired and consumed passcodes as distinct outcomes
  - Read `server/src/supabase.ts` `checkWhitelistEntry` implementation.
  - The current implementation returns `{ allowed: false }` for both expired and consumed entries without distinguishing them.
  - Extend the return type to `{ allowed: boolean; consumeId?: string; reason?: "consumed" | "expired" }`.
  - In the passcode branch: if a row exists but `consumed = true`, return `{ allowed: false, reason: "consumed" }`. If a row exists but `expires_at` is in the past, return `{ allowed: false, reason: "expired" }`. Otherwise return `{ allowed: false }` (not found).
  - Update the `WhitelistCheckResult` type (or inline type) accordingly. Do not change the userId branch — it does not need distinct error reasons.

- [~] 2.2 Verify `server/src/supabase.ts` exports compile cleanly after task 2.1
  - Run `cd server && npx tsc --noEmit`. Fix any type errors introduced by the return-type change.

---

## Layer 3 — Server: Colyseus Room

- [~] 3.1 Import the three new error constants into `server/src/ClassroomRoom.ts`
  - Add `ERROR_ROOM_LOCKED`, `ERROR_PASSCODE_CONSUMED`, `ERROR_PASSCODE_EXPIRED` to the import from `@klase/shared` at the top of `server/src/ClassroomRoom.ts`.

- [~] 3.2 Throw `PASSCODE_CONSUMED` and `PASSCODE_EXPIRED` as distinct errors in `onAuth()`
  - In `ClassroomRoom.onAuth()`, after `checkWhitelistEntry` returns `{ allowed: false }`, inspect the `reason` field from task 2.1.
  - If `reason === "consumed"`: throw `new ServerError(403, JSON.stringify({ error: ERROR_PASSCODE_CONSUMED, message: "This passcode has already been used." }))`.
  - If `reason === "expired"`: throw `new ServerError(403, JSON.stringify({ error: ERROR_PASSCODE_EXPIRED, message: "This passcode has expired." }))`.
  - Otherwise (no reason / not found): keep the existing `ROOM_LOCKED` throw.
  - Keep the existing `consumeWhitelistEntry` call for single-use passcodes unchanged.

- [~] 3.3 Build the server after changes
  - Run `cd server && npx tsc --noEmit`. Fix any type errors.

---

## Layer 4 — Server: Express Routes

All required routes are already implemented in `server/src/admin.ts`. The following tasks address gaps or confirm existing behaviour matches the spec.

- [~] 4.1 Confirm `POST /api/admin/accounts/set-banned` is accessible to admins with `can_blacklist`
  - Read the `set-banned` handler in `server/src/admin.ts`. It already uses `requireStaff` (not `requireOwner`) and checks `can_blacklist` for admin callers. No change needed if this is correct. Mark done after confirming.

- [~] 4.2 Confirm `DELETE /api/admin/whitelist/entry/:id` returns 404 for non-existent entries
  - `removeWhitelistEntry` in `supabase.ts` issues a `.delete().eq("id", id)` without checking whether a row was deleted.
  - Update the handler in `server/src/admin.ts` to check whether the entry exists before deleting: call `loadWhitelistForRoom` to find by id is too slow — instead add a `getWhitelistEntry(id)` helper in `supabase.ts` that does `.select("id").eq("id", id).maybeSingle()`, then throw `ServerError(404, "NOT_FOUND")` if no row is returned.
  - Alternatively (simpler): use `.delete().eq("id", id).select()` (PostgREST returns deleted rows) to detect a no-op delete and throw 404. Choose whichever approach matches the existing supabase.ts style.

- [~] 4.3 Add `ERRORS` map entries for new error codes in `client/src/admin.ts`
  - This is a client task but must be consistent with server codes. Add to the `ERRORS` constant in `client/src/admin.ts`:
    ```
    ROOM_LOCKED: "This room is currently locked.",
    PASSCODE_CONSUMED: "This passcode has already been used.",
    PASSCODE_EXPIRED: "This passcode has expired.",
    ```

- [~] 4.4 Build the server after all route changes
  - Run `cd server && npx tsc --noEmit`. Fix any type errors.

---

## Layer 5 — Client: Dashboard UI

All changes go into `client/src/admin.ts`. Follow the existing patterns: use the `el()` helper, `api<T>()` for all HTTP calls, and `notify()` for status messages. Do not introduce new files.

### 5.1 — Types and helpers

- [~] 5.1.1 Add TypeScript types for new API responses at the top of `client/src/admin.ts`
  - Add after the existing `RoomInfo` type:
    ```typescript
    type AccountResult = {
      id: string;
      display_name: string;
      role: Role;
      banned: boolean;
    };
    type AdminPermissions = {
      user_id: string;
      can_observe: boolean;
      can_lock_rooms: boolean;
      can_blacklist: boolean;
      can_announce: boolean;
    };
    type WhitelistEntry = {
      id: string;
      room_key: string;
      user_id: string | null;
      passcode: string | null;
      label: string;
      single_use: boolean;
      consumed: boolean;
      expires_at: string | null;
      added_by: string | null;
      created_at: string;
    };
    ```
  - Extend the existing `RoomInfo` type to include:
    ```typescript
    locked: boolean;
    whitelist_mode: boolean;
    ```

- [~] 5.1.2 Add `apiDelete` helper for DELETE requests in `client/src/admin.ts`
  - The existing `api<T>()` helper uses `body === undefined ? "GET" : "POST"`. Add a separate helper:
    ```typescript
    async function apiDelete<T>(path: string, token: string): Promise<T> { ... }
    ```
  - Same error handling pattern as `api<T>()` but always uses method `"DELETE"`.

### 5.2 — Accounts section (owner only)

- [~] 5.2.1 Add `renderAccountsSection(page, token, me, notify)` function
  - Only rendered when `me.role === "owner"`.
  - Creates a `<section class="clay admin-section">` with heading "Accounts".
  - Contains a text input (search query) and a "Search" button.
  - On search: calls `GET /api/admin/accounts?q=<query>` with the bearer token.
  - Renders results as a list. For each result:
    - Display `display_name` and a role badge.
    - If `role === "owner"` or the account is the currently signed-in user: show "(immune)" and no action buttons.
    - Otherwise: show [Promote to admin] (disabled if already admin), [Demote to user] (disabled if already user), [Blacklist] (hidden if already banned), [Unban] (hidden if not banned).
  - Promote: `POST /api/admin/accounts/set-role` with `{ userId: id, role: "admin" }`.
  - Demote: `POST /api/admin/accounts/set-role` with `{ userId: id, role: "user" }`.
  - Blacklist: `POST /api/admin/accounts/set-banned` with `{ userId: id, banned: true }`.
  - Unban: `POST /api/admin/accounts/set-banned` with `{ userId: id, banned: false }`.
  - On success: re-run the search to refresh the list; call `notify("Done.")`.
  - On error: call `notify(ERRORS[code] ?? code, true)`.

- [~] 5.2.2 Mount accounts section in `mountDashboard()` after the "Enter as" section
  - Call `renderAccountsSection(page, token, me, notify)` only when `me.role === "owner"`.

### 5.3 — Admin Permissions panel (owner only)

- [~] 5.3.1 Add `renderPermissionsSection(page, token, me, notify)` function
  - Only rendered when `me.role === "owner"`.
  - On mount: calls `GET /api/admin/permissions` to fetch all `AdminPermissions` rows.
  - Also calls `GET /api/admin/accounts?q=` (or uses the accounts already fetched) to correlate `user_id` → `display_name` for labelling.
  - Renders a list of admin accounts. For each:
    - `display_name` label
    - Four checkboxes: "Observe", "Lock rooms", "Blacklist", "Announce" — checked state reflects current DB values.
    - A "Save" button per row.
  - On save: `POST /api/admin/permissions/:userId` with `{ can_observe, can_lock_rooms, can_blacklist, can_announce }` (all four booleans from checkbox states).
  - On success: update the row's checkbox states to the server-returned values; call `notify("Permissions saved.")`.
  - On error: restore pre-save checkbox states and call `notify(ERRORS[code] ?? code, true)`.

- [~] 5.3.2 Mount permissions section in `mountDashboard()` after the accounts section
  - Call `renderPermissionsSection(page, token, me, notify)` only when `me.role === "owner"`.

### 5.4 — Player Tracker modal

- [~] 5.4.1 Add `openPlayerTrackerModal(token, me, submit)` function
  - Creates a full-screen modal overlay (`position: fixed; inset: 0; z-index: 1000`).
  - Appends to `document.body`, not to the admin page container.
  - Shows a heading "Player Tracker" and a [Close] button.
  - On open and every 3 seconds while open: fetches `GET /api/admin/rooms` and re-renders the player list.
  - Groups players by room. For each room: room heading ("Classroom 1" etc.), then a row per player (name, role badge, muted badge).
  - For owner/admin: shows players across all rooms; each player row shows a room-name badge and moderation buttons (Kick, Ban, Mute/Unmute, Message) that call `submit(roomKey, payload)`.
  - Observer players are excluded from the list (already filtered server-side, but also skip rows where `p.observer === true`).
  - On fetch failure: show error message and a manual "Retry" button; do not close the modal.
  - On close: clear the polling interval and remove the overlay from the DOM.
  - Use the existing `openModerationModal` for the per-player action buttons (same pattern as the room card player rows).

- [~] 5.4.2 Add "Player Tracker" button to the admin page header
  - In `mountDashboard()`, after the existing header buttons (Back to Klase, Sign out), add a "Player Tracker" button.
  - Visible to owner and admin only (already inside the staff-authenticated dashboard).
  - On click: call `openPlayerTrackerModal(token, me, submit)`.

### 5.5 — Room card extensions (lock toggle + observe button + whitelist)

- [~] 5.5.1 Add lock/unlock controls to each room card in `renderRooms()`
  - After the existing "Enter room" / "Observe" buttons, add a lock button only when `me.role === "owner"` OR (`me.role === "admin"` AND the server-reported `me.permissions?.can_lock_rooms === true`).
  - Button text: "🔒 Lock" when `room.locked === false`; "🔓 Unlock" when `room.locked === true`.
  - On click: `POST /api/admin/room-config` with `{ roomKey: room.roomKey, locked: !room.locked }`.
  - On success: call `notify("Room locked." / "Room unlocked.")` and call `refresh()`.
  - On error: call `notify(ERRORS[code] ?? code, true)`.

- [~] 5.5.2 Show "Observe" button for admins with `can_observe`
  - The existing "Observe" button is currently only rendered for `me.role === "owner"`.
  - Change the condition to: `me.role === "owner" || (me.role === "admin" && me.permissions?.can_observe === true)`.
  - The `me` object must include the `permissions` field. Update the type for `me` in `mountDashboard()` to include `permissions?: AdminPermissions | null`.
  - The `/api/admin/me` response already returns `permissions` for admin callers.

- [~] 5.5.3 Add `renderWhitelistPanel(card, roomKey, token, me, notify)` function
  - Only rendered when `room.locked === true` OR as always-visible sub-panel (owner choice; always-visible is simpler and more discoverable).
  - Calls `GET /api/admin/whitelist/:roomKey` on mount and on each explicit refresh.
  - Renders a table: label | type (user/passcode) | single-use | expires | passcode-value (owner only, masked for admins) | [Remove] button.
  - [Remove] calls `DELETE /api/admin/whitelist/entry/:id`.
  - "Add user" form: text input for `user_id` (UUID), label input, single-use checkbox, optional expiry date input → `POST /api/admin/whitelist/:roomKey/add` with `{ type: "user", user_id, label, single_use, expires_at }`.
  - "Add passcode" form: label input, single-use checkbox, optional expiry → `POST /api/admin/whitelist/:roomKey/add` with `{ type: "passcode", label, single_use, expires_at }`. After success, show the returned `entry.passcode` in a read-only field with a "Copy" button (visible once, then gone).
  - Write operations (add/remove) only shown to owner or admin with `can_lock_rooms`.
  - Read-only view (list only) shown to all staff.
  - On error: call `notify(ERRORS[code] ?? code, true)`.

- [~] 5.5.4 Mount whitelist panel in `renderRooms()` for each room card
  - Call `renderWhitelistPanel(card, room.roomKey, token, me, notify)` after the moderation toolbar for each room.

### 5.6 — Build and smoke-test

- [~] 5.6.1 Run TypeScript build for both client and server
  - `cd client && npx tsc --noEmit`
  - `cd server && npx tsc --noEmit`
  - Fix all type errors before marking done.

- [~] 5.6.2 Manual smoke test checklist
  - Sign in as owner → accounts section visible, search returns results, promote/demote works.
  - Admin permissions panel visible (owner only) → toggle a flag, save, verify persisted on reload.
  - Lock a room → join as regular user (no whitelist entry) → confirm join fails with ROOM_LOCKED.
  - Add a userId whitelist entry → join as that user → confirm admission.
  - Add a single-use passcode entry → join with passcode → confirm admission; join again → confirm PASSCODE_CONSUMED.
  - Observe button hidden for admin with `can_observe=false`; visible with `can_observe=true`.
  - Player Tracker modal opens, shows players across rooms, closes cleanly.
  - Offline blacklist → target account joins → denied with BANNED.

---

## Dependency Order

```
1.1 → 3.1
1.1 → 4.3
2.1 → 3.2
3.1 + 3.2 → 3.3
4.1 + 4.2 + 4.3 → 4.4
5.1.1 + 5.1.2 → all 5.2–5.5 tasks
5.2.1 → 5.2.2
5.3.1 → 5.3.2
5.4.1 → 5.4.2
5.5.1 + 5.5.2 + 5.5.3 → 5.5.4
all 5.x → 5.6.1 → 5.6.2
```
