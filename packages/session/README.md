# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event` and flush on `session/flush`.

### Public API

- `ctx.sessions.create(id?: string, seed?: SessionEvent[]): Session` Create a session. `seed` replays/forks an existing event log. Disposed with the calling fiber.
- `ctx.sessions.get(id: string): Session | undefined`
- `ctx.sessions.list(): Session[]`

### Events

| Event | Mode | Purpose |
|---|---|---|
| `session/created` | emit | A session was created |
| `session/event` | emit | An event was appended (sync, fire-and-forget) |
| `session/flush` | parallel | Awaited durability checkpoint (persistence plugins drain buffers here) |

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data): SessionEvent` — synchronous, never blocks on I/O.
- `session.deriveMessages(): Message[]` — derive the LLM message history from the event log. Raw `assistant/chunk` events are skipped; `context/message` and `steering/message` render as tagged synthetic user messages.
- `session.events`, `session.seq`, `session.id`

### Session event vocabulary (`types.ts`)

The append-only log: `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/chunk`, `tool/call`, `tool/result`, `steering/message`, `context/message`, `usage`, `error`.

Merge-extensible via `SessionEventMap` — a compaction plugin adds `compaction/marker`, etc.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. See `examples/echo-agent/src/session-jsonl.ts` for the pattern.
- Replay/fork: `ctx.sessions.create(id, seed)` seeds a new session with an existing event log.

### What is NOT here (TODO)

- **Real persistence backends** (JSONL per session dir, sqlite) — future phase.
- **Session event vocabulary review** — `TODO(review)` once the loop and a persistence plugin coexist.
- **Session branching/tree** (pi-style entry tree) — defered unless needed beyond seed-based forking.
