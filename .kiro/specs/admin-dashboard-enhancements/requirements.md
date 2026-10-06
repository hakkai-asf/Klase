# Requirements Document

## Introduction

This feature enhances the Klase admin dashboard with seven new capabilities: offline promote/demote by account search, an admin-observable-rooms permission, owner-configurable per-admin permission toggles, room locking with a whitelist entry system, a unified ban/blacklist flow, a per-room whitelist (by userId or passcode), and a cross-room player tracker modal. All permission checks are enforced server-side on every request; the client UI is cosmetic only.

## Glossary

- **Owner**: The single privileged account identified by `KLASE_OWNER_USER_ID` or `KLASE_OWNER_EMAIL` environment variables. Has full unrestricted access to all moderation capabilities.
- **Admin**: A registered account with `profiles.role = 'admin'`. Subject to per-admin permission flags stored in `admin_permissions`.
- **Admin_Permissions**: A per-admin row in the `admin_permissions` table holding four boolean permission flags: `can_observe`, `can_lock_rooms`, `can_blacklist`, `can_announce`.
- **Dashboard**: The `/admin` web page rendered by `client/src/admin.ts`.
- **Permission_Guard**: The server-side middleware that reads `admin_permissions` from the database and validates each admin action before execution.
- **Room_Config**: A row in the `room_config` table keyed by `room_key`, storing `locked` (bool) and `whitelist_mode` (bool).
- **Whitelist**: The `whitelist` table storing per-room entries by `user_id` or `passcode`.
- **Passcode**: An opaque string (~20 characters) stored in `whitelist.passcode`, optionally single-use and optionally expiring.
- **Blacklist**: The offline flow for setting `profiles.banned = true` on an account that is not currently in a room.
- **Ban**: The online flow for removing a player from a room and setting `profiles.banned = true`.
- **Player_Tracker**: A modal UI element showing all online players across all three classrooms with per-player room indicators.
- **Account_Search**: A server-side endpoint that queries `profiles` by `display_name` or a prefix thereof, returning matches for owner/admin use.
- **Guest**: A player with an empty `userId` (no Supabase account).
- **Colyseus_Server**: The game server built on the Colyseus framework running in `server/src/`.
- **Express_Server**: The HTTP API layer in `server/src/admin.ts` and related files.
- **Supabase**: The PostgreSQL-backed BaaS providing `auth.users`, `profiles`, and all new tables.

---

## Requirements

### Requirement 1: Offline Account-Based Promote/Demote

**User Story:** As the Owner, I want to search registered accounts by display name and promote or demote them without requiring them to be online, so that I can manage roles at any time.

#### Acceptance Criteria

1. THE Dashboard SHALL expose an account search input that queries the `Account_Search` endpoint by partial `display_name` match, returning at most 20 results per query.
2. WHEN the Owner submits a promote or demote action for a search result, THE Express_Server SHALL update `profiles.role` in Supabase and return a success response.
3. WHEN a promote or demote request is received, IF the requesting account's role is not `owner`, THEN THE Express_Server SHALL return 403 `NO_PERMISSION` without executing the change.
4. IF a search result has an empty `userId` (Guest), THEN THE Dashboard SHALL disable the promote and demote controls for that result and display the label "Guest — cannot be promoted".
5. IF an account's current role is `owner`, THEN THE Express_Server SHALL reject any promote or demote action targeting that account with a 403 `IMMUNE` error.
6. WHEN the Owner performs a promote action on a `user`-role account, THE Express_Server SHALL set `profiles.role = 'admin'` and create a default `admin_permissions` row for that account if one does not already exist, with all four permission flags (`can_observe`, `can_lock_rooms`, `can_blacklist`, `can_announce`) set to `false`.
7. WHEN the Owner performs a demote action on an `admin`-role account, THE Express_Server SHALL set `profiles.role = 'user'` and retain the existing `admin_permissions` row for historical reference.
8. IF the Owner submits a promote action targeting an account that already has `profiles.role = 'admin'`, OR a demote action targeting an account that already has `profiles.role = 'user'`, THEN THE Express_Server SHALL return 400 `BAD_REQUEST`.
9. IF the `Account_Search` endpoint receives a request from an account whose role is not `owner`, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.

---

### Requirement 2: Admin Silent Observation of Rooms

**User Story:** As an Admin with the `can_observe` permission, I want to enter a room as a silent invisible observer, so that I can monitor activity without affecting the room.

#### Acceptance Criteria

1. WHEN an Admin with `can_observe = true` requests entry via `?mode=observe`, THE Colyseus_Server SHALL admit them in observer (god) mode.
2. IF an Admin's `can_observe` flag is `false` or absent and they request entry via `?mode=observe`, THEN THE Colyseus_Server SHALL reject the request with a 403 `NO_PERMISSION` error.
3. IF the logged-in account is an Admin and the server-reported `can_observe` flag is `true`, THEN THE Dashboard SHALL display the "Observe" button for that Admin; otherwise the "Observe" button SHALL be hidden.
4. THE Colyseus_Server SHALL NOT trust the `can_observe` value sent by the client; it SHALL re-read `admin_permissions` from the database on every join request.
5. WHILE a player is in observer mode, THE Colyseus_Server SHALL not broadcast that player's state to other clients, exclude them from the regular-player count in room metadata, and suppress join and leave announcements for that player.
6. WHEN an observer disconnects from a room, THE Colyseus_Server SHALL NOT broadcast a leave announcement for that player.

---

### Requirement 3: Owner-Configurable Per-Admin Permissions

**User Story:** As the Owner, I want to toggle individual permission flags for each Admin account in the dashboard, so that I can grant or restrict capabilities on a per-admin basis.

#### Acceptance Criteria

1. THE Dashboard SHALL display a permissions panel for each Admin account listing the four flags: `can_observe`, `can_lock_rooms`, `can_blacklist`, `can_announce`.
2. WHEN the Owner explicitly submits a permissions change, THE Express_Server SHALL upsert the corresponding boolean columns in `admin_permissions` for the target `user_id` and return a success response.
3. THE Permission_Guard SHALL read `admin_permissions` from the database on every admin API request and SHALL NOT use any permission value supplied by the client; IF the database read fails, THEN THE Permission_Guard SHALL deny the request with 503 rather than proceeding without verified permissions.
4. IF a permission flag is absent from the `admin_permissions` row (e.g., newly created), THEN THE Permission_Guard SHALL treat the missing flag as `false`.
5. IF a request would use a permission to affect the Owner's account, THEN THE Express_Server SHALL return 403 `IMMUNE`, regardless of which flags are set.
6. WHEN the Owner submits a permissions change, IF the requesting account's role is not `owner`, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.
7. WHEN the Dashboard loads, THE Dashboard SHALL fetch the current permission state for all admins from the server; it SHALL NOT persist permission state in `localStorage` or cookies.
8. IF the Express_Server returns an error in response to a permissions save, THEN THE Dashboard SHALL display an error message and retain the unsaved toggle state so the Owner can retry.

---

### Requirement 4: Room Lock / Disable

**User Story:** As the Owner or an Admin with `can_lock_rooms`, I want to lock a room so that only authorised users can enter, so that I can protect classroom sessions from uninvited participants.

#### Acceptance Criteria

1. WHEN the Owner or an Admin with `can_lock_rooms = true` sends a lock-room request, THE Express_Server SHALL set `room_config.locked = true` for the specified `room_key` and return a success response.
2. WHEN a lock-room request is received from an Admin, IF the Admin's `can_lock_rooms` flag is `false` or absent, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.
3. WHILE `room_config.locked = true`, IF a `user`-role player attempts to join and is not present in the `whitelist` for that room, THEN THE Colyseus_Server SHALL deny the join request with 403 `ROOM_LOCKED`; players already inside the room at the time of locking SHALL NOT be ejected.
4. WHEN a `user`-role player is denied entry to a locked room, THE Colyseus_Server SHALL include a human-readable locked-room message in the error response payload.
5. WHILE `room_config.locked = true`, THE Colyseus_Server SHALL allow `owner` and `admin` role players to join regardless of whitelist status.
6. THE Express_Server SHALL persist the lock state in `room_config`; the lock SHALL survive server restarts.
7. WHEN the Owner or an Admin with `can_lock_rooms = true` sends an unlock-room request, THE Express_Server SHALL set `room_config.locked = false` for the specified `room_key` and return a success response.
8. THE Dashboard SHALL display the current lock state for each room (refreshed at most every 3 seconds), and SHALL provide lock/unlock controls that are visible only to the Owner and admins whose `can_lock_rooms` flag is `true`.
9. THE Colyseus_Server SHALL re-read the lock state from the database on every join request and SHALL NOT cache the lock state across join evaluations.
10. IF a lock or unlock request specifies a `room_key` that does not exist in `room_config` or is not a valid room code, THEN THE Express_Server SHALL return 404 with no state mutation.

---

### Requirement 5: Ban / Blacklist System (Unified)

**User Story:** As the Owner or an Admin with `can_blacklist`, I want to ban online players and blacklist offline accounts through a single flag, so that banned users cannot join any room regardless of how the ban was applied.

#### Acceptance Criteria

1. WHEN the Owner or an Admin with `can_blacklist = true` submits a blacklist request for an offline account, THE Express_Server SHALL set `profiles.banned = true` for the target `user_id`.
2. WHEN a blacklist request is received from an Admin, IF the Admin's `can_blacklist` flag is `false` or absent, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.
3. IF a blacklist or unban request targets an account whose resolved role is `owner`, THEN THE Express_Server SHALL return 403 `IMMUNE`.
4. WHEN a player with `profiles.banned = true` attempts to join any room, THE Colyseus_Server SHALL reject the join request with 403 `BANNED`.
5. WHEN the Express_Server processes an offline blacklist request, THE Express_Server SHALL set `profiles.banned = true` for the target account; WHEN the Colyseus_Server processes an online ban action, THE Colyseus_Server SHALL set `profiles.banned = true` for the target account; no additional flag or separate table SHALL be used for either path.
6. WHEN an Admin performs the online ban action, THE Permission_Guard SHALL enforce the existing `assertCanModerate` rules; the `can_blacklist` flag governs the offline blacklist path only.
7. THE Dashboard SHALL expose an account search input in the blacklist panel, separate from the promote/demote panel, that is visible only to the Owner and admins whose `can_blacklist` flag is `true`.
8. WHEN a blacklist is applied to an offline account, THE Express_Server SHALL NOT send any kick notice or in-room message.
9. IF a blacklisted user's `user_id` is present in any room's `whitelist`, THEN THE Colyseus_Server SHALL still deny their join request; blacklist status takes precedence over whitelist status.
10. WHEN the Owner or an Admin with `can_blacklist = true` submits an unban request for a banned account, THE Express_Server SHALL set `profiles.banned = false` for the target `user_id` and return a success response.
11. IF a blacklist request targets an account with an empty `user_id` (Guest), THEN THE Express_Server SHALL return 400 `BAD_REQUEST`; guest blocking is handled only by the in-room ban flow.

---

### Requirement 6: Per-Room Whitelist

**User Story:** As the Owner or an Admin, I want to manage a per-room whitelist of users and passcodes, so that specific people can enter locked rooms.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a whitelist management panel per room, visible to the Owner and all admins; write operations (add/remove) SHALL be restricted to the Owner and admins with `can_lock_rooms = true`.
2. WHEN the Owner or an authorised Admin adds a `user_id` entry to the whitelist, THE Express_Server SHALL insert a row into `whitelist` with `room_key`, `user_id`, and `added_by` populated; IF the requesting account lacks the required permission, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.
3. WHEN the Owner or an authorised Admin adds a passcode entry, THE Express_Server SHALL insert a row into `whitelist` with `room_key`, a server-generated exactly-20-character opaque passcode, a `label` (1–80 characters supplied by the requester), and `added_by` populated; IF the requesting account lacks the required permission, THEN THE Express_Server SHALL return 403 `NO_PERMISSION`.
4. IF a passcode entry has `single_use = true` and has already been successfully consumed, THEN THE Colyseus_Server SHALL reject any subsequent use of that passcode with error code `PASSCODE_CONSUMED`.
5. IF a passcode entry has a non-null `expires_at` and the current time is past `expires_at`, THEN THE Colyseus_Server SHALL deny admission with error code `PASSCODE_EXPIRED`.
6. WHEN a `user`-role player joins a locked room, THE Colyseus_Server SHALL grant admission if at least one valid match exists — either a non-expired, unconsumed `whitelist` row for the player's `user_id`, or a non-expired, unconsumed `whitelist` row matching the `passcode` supplied in the join options; a failed match on one path SHALL NOT prevent admission via the other path.
7. WHEN a client supplies a `passcode` in join options, THE Colyseus_Server SHALL validate it server-side; a passcode that is expired, consumed, or unrecognised SHALL be treated as absent.
8. THE Express_Server SHALL generate passcodes server-side using a cryptographically secure random source; clients SHALL NOT supply their own passcode values.
9. WHEN an existing whitelist entry is removed, THE Express_Server SHALL hard-delete the row from `whitelist`; players already inside the room at the time of removal SHALL remain until they disconnect naturally.
10. THE Dashboard SHALL display each whitelist entry with its label, type (user or passcode), single-use status, and expiry date if set.
11. WHEN a `user`-role player is granted admission via both a matching `user_id` row and a matching `passcode` row, IF the passcode entry has `single_use = true`, THEN THE Colyseus_Server SHALL still mark that passcode as consumed.
12. IF the whitelist database lookup fails during a join evaluation for a locked room, THEN THE Colyseus_Server SHALL deny admission with 403 `ROOM_LOCKED` rather than fail open.

---

### Requirement 7: Cross-Room Player Tracker Modal

**User Story:** As a player or staff member, I want to open a modal that shows online players, so that staff can monitor all rooms at once and regular users can see who is in their room.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a "Player Tracker" button that opens a modal; WHEN the modal is opened by a staff member (owner or admin), the modal SHALL display live player data fetched from the `/api/admin/rooms` endpoint.
2. WHEN a `user`-role player opens the Player Tracker in-game, THE Client SHALL display only the players present in their current room.
3. WHEN an `owner`- or `admin`-role player opens the Player Tracker in-game, THE Client SHALL display all players across all three rooms, each accompanied by a badge showing the room name (e.g., "Classroom 1").
4. WHEN the Player Tracker modal is open, THE Client SHALL re-fetch player data at most every 3 seconds.
5. WHEN the Owner or Admin views the Player Tracker modal, THE modal SHALL provide per-player moderation action buttons (kick, ban, mute, unmute, message) that submit to the existing `/api/admin/moderate` endpoint.
6. THE Colyseus_Server SHALL exclude observer-mode players from all Player Tracker data; observers SHALL NOT be visible to any client through this modal.
7. WHEN a moderation action is submitted from the Player Tracker modal, THE Express_Server SHALL enforce all existing server-side permission rules via `assertCanModerate` and `Permission_Guard`.
8. IF the Player Tracker data fetch fails, THEN THE modal SHALL display an error state and provide a manual retry control without closing the modal.
9. WHEN a `user`-role player requests Player Tracker data for rooms other than their own, THE Express_Server SHALL return only their current room's data; cross-room data SHALL require owner or admin authentication.
