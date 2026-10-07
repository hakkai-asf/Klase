# OOP Concepts in Klase — Codebase Analysis

This document maps three core Object-Oriented Programming concepts to their exact
implementations in the Klase source code. All line numbers were verified directly
against the current state of the repository.

---

## 1. Encapsulation — Private Fields and Methods

**File:** `server/src/ClassroomRoom.ts`

Encapsulation restricts direct access to an object's internal state, exposing it
only through controlled interfaces. `ClassroomRoom` demonstrates this with four
private fields and two private methods that manage in-room state without exposing
those internals to external callers.

### Private Fields

| Line | Declaration | Purpose |
|------|-------------|---------|
| 102 | `private chatLog: ChatLine[] = []` | Circular buffer of the last 40 chat messages. Only readable through the `need-history` message handler; never exposed directly on the class interface. |
| 103 | `private lastActive = new Map<string, number>()` | Tracks each session's last activity timestamp. Used exclusively by the idle-timeout loop; callers cannot manipulate idle state from outside the room. |
| 107 | `private joined = new Set<string>()` | Records sessions that have fully completed `onJoin`. Every message handler checks this guard first — pre-join connections are silently ignored. |
| 109 | `private quietLeave = new Set<string>()` | Marks sessions that were kicked or banned, so `onLeave` suppresses the generic "has left" announcement for them. |

### Private Methods

| Line | Signature | Purpose |
|------|-----------|---------|
| 111 | `private touch(sessionId: string)` | Updates `lastActive` for a session. Centralises the idle-reset logic so no message handler writes to `lastActive` directly. |
| 115 | `private pushChat(line: ChatLine)` | Appends a message to `chatLog` and immediately enforces the `CHAT_LOG_MAX` ceiling. No external code can add to the log or bypass the size limit. |

### Why This Is Encapsulation

The comment in `schema.ts` (L5–L7) explicitly acknowledges the design trade-off:
Colyseus requires public fields on `Schema` subclasses for state sync, so `Player`
and `ClassroomState` cannot use private fields there. The comment directs readers
to `ClassroomRoom.ts` as the authoritative example of encapsulation in this codebase.

```typescript
// server/src/ClassroomRoom.ts  L102–L119
private chatLog: ChatLine[] = [];
private lastActive = new Map<string, number>();
private joined = new Set<string>();
private quietLeave = new Set<string>();

private touch(sessionId: string) {
  this.lastActive.set(sessionId, Date.now());
}

private pushChat(line: ChatLine) {
  this.chatLog.push(line);
  if (this.chatLog.length > CHAT_LOG_MAX)
    this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
}
```

---

## 2. Class Inheritance Chain

**Files:** `server/src/schema.ts` and `server/src/ClassroomRoom.ts`

Inheritance allows a class to acquire the behaviour and structure of a parent class.
Klase uses a two-level chain built on the Colyseus framework:

```
Schema  ──extends──▶  Player
Schema  ──extends──▶  ClassroomState  (contains a MapSchema<Player>)
Room<ClassroomState>  ──extends──▶  ClassroomRoom
```

### schema.ts

| Line | Declaration | Inherits from | What it gains |
|------|-------------|---------------|---------------|
| 9 | `export class Player extends Schema` | `Schema` | Automatic serialisation and delta-sync of every field over WebSocket to all connected clients. |
| 47 | `export class ClassroomState extends Schema` | `Schema` | Same delta-sync, but for the room-level state — `roomKey` and the `players` map that holds all `Player` instances. |

### ClassroomRoom.ts

| Line | Declaration | Inherits from | What it gains |
|------|-------------|---------------|---------------|
| 49 | `export class ClassroomRoom extends Room<ClassroomState>` | `Room<ClassroomState>` | The full Colyseus room lifecycle: `onCreate`, `onAuth`, `onJoin`, `onLeave`, `onDispose`, the `clock`, `broadcast`, `clients`, and the typed `this.state` bound to `ClassroomState`. |

```typescript
// server/src/schema.ts  L9
export class Player extends Schema { ... }

// server/src/schema.ts  L47
export class ClassroomState extends Schema {
  roomKey = "";
  players = new MapSchema<Player>();
}

// server/src/ClassroomRoom.ts  L49
export class ClassroomRoom extends Room<ClassroomState> { ... }
```

`ClassroomRoom` overrides the inherited lifecycle hooks to add game-specific logic
(capacity checks in `onJoin`, idle timeouts in `onCreate`'s `clock.setInterval`,
cleanup in `onDispose`) without reimplementing the underlying WebSocket management.

---

## 3. Array Operations — Circular Buffer via `push` and `splice`

**File:** `server/src/ClassroomRoom.ts`, inside `private pushChat()` (L115–L120)

The chat history is implemented as a fixed-capacity circular buffer using two
standard `Array` methods.

| Line | Operation | Behaviour |
|------|-----------|-----------|
| 117 | `this.chatLog.push(line)` | Appends the new `ChatLine` object to the end of the array. `push` mutates the array in place and returns the new length. |
| 119 | `this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX)` | When the buffer exceeds `CHAT_LOG_MAX` (40), removes entries from index 0 forward — the oldest messages — keeping the array at exactly 40 entries. `splice(start, deleteCount)` mutates the array in place and returns the removed elements (discarded here). |

```typescript
// server/src/ClassroomRoom.ts  L115–L120
private pushChat(line: ChatLine) {
  // Append new chat line to the circular buffer
  this.chatLog.push(line);
  // Trim oldest entries when buffer exceeds max
  if (this.chatLog.length > CHAT_LOG_MAX)
    this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
}
```

`CHAT_LOG_MAX` is defined as `40` in `shared/src/index.ts` and imported at the top
of `ClassroomRoom.ts`. The result is that the chat log never exceeds 40 lines in
memory: `push` grows it by one, and `splice` trims the excess from the front, making
the array behave like a queue with a hard ceiling.

---

## Accuracy Notes — Corrections to the Reference List

The topics and functions cited in the reference list are all genuine. The **line
numbers** were off because the file has grown since the reference was compiled.
Correct line numbers as of the current commit:

| Reference claim | Actual line |
|----------------|-------------|
| Private fields at L20–L21 | **L102–L103** |
| `private touch()` at L23 | **L111** |
| `private pushChat()` at L27 | **L115** |
| `class ClassroomRoom` at L18 | **L49** |
| `class Player extends Schema` at L8 | **L9** |
| `class ClassroomState extends Schema` at L41 | **L47** |
| `chatLog.push()` at L29 | **L117** |
| `chatLog.splice()` at L31 | **L119** |
