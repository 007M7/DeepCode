# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event` and flush on `session/flush`.

### Public API

- `ctx.sessions.create(id?: SessionId, options?: { seed?: SessionEvent[]; meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number } }): Session` — Create a session. `options.seed` replays/forks an existing event log; `options.meta` attaches creation metadata (validated absolute `cwd`, `parentSession` lineage) as the immutable `SessionHeader`. The store fills `version`/`id` and defaults `createdAt` to now; a caller reconstructing a persisted session passes the original `createdAt` to preserve it. Disposed with the calling fiber.
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### Advanced: ordered-teardown lifecycle primitives

`create()` covers the common case (the session is owned by the calling fiber). When a session must be torn down **in order with another resource** — so a final flush is captured before `onAppend` detaches — `create()`'s self-contained effect is wrong, because a fiber unload disposes sibling effects *concurrently*. For that, split the lifecycle and fold it into the owner's single effect:

- `ctx.sessions.prepare(id?, options?): Session` — validate the id/cwd and construct the `Session`, WITHOUT entering it into the store. Same options as `create`.
- `ctx.sessions.enter(session): () => void` — wire `onAppend` → `session/event` and add the session to the store; returns the DETACH disposer. Does NOT emit `session/created` (the caller yields the disposer first, then calls `announce`, so a throwing listener rolls the attach back). The id was already validated by `prepare`, which runs in the same synchronous sequence, so `enter` does not re-check.
- `ctx.sessions.announce(session): void` — emit `session/created` for an entered session.

`dsh-agent-loop`'s `AgentLoop.start` is the canonical consumer: it yields `enter`'s detach disposer, the registry unregister, and the loop-stop disposer into ONE composite effect, so teardown stops + awaits the loop (final flush captured) BEFORE detaching the session — whether the trigger is the `AgentHandle`'s `dispose()` or a fiber unload.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `session/created` | emit | A session was created |
| `session/event` | emit | An event was appended (sync, fire-and-forget) |
| `session/flush` | parallel | Awaited durability checkpoint (persistence plugins drain buffers here) |

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data): SessionEvent` — synchronous, never blocks on I/O. **Throws** if `data` is not losslessly JSON-serializable (BigInt, function, symbol, undefined, non-finite number, circular ref, or an exotic object like Map/Set/Date) — the event log is the durable source of truth, so this invariant is enforced at the source (exported as `isJsonValue` for backends to reuse on their replay/fork entry points).
- `session.deriveMessages(): Message[]` — derive the LLM message history from the event log. Raw `assistant/chunk` events are skipped; `context/message` and `steering/message` render as tagged synthetic user messages.
- `session.events`, `session.seq`, `session.id`
- `session.header: SessionHeader` — immutable creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`). Kept out of the event log (a storage concern, not replayable state); a minimal v1 header is synthesized for bare `Session` construction.

### Metadata types (`types.ts`)

- `SessionHeader` — immutable session metadata, written once: `{ version, id, createdAt, cwd?, parentSession? }`. Owned here (beside `SessionId`) because `Session.header` is typed by it; persistence backends re-export it rather than own it (which would force a package cycle).

### Session event vocabulary (`types.ts`)

The append-only log: `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/chunk`, `tool/call`, `tool/result`, `steering/message`, `context/message`, `usage`, `error`.

Merge-extensible via `SessionEventMap` — a compaction plugin adds `compaction/marker`, etc.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. A durable backend reads the log and reloads it into a live session; the metadata seam (`SessionHeader`, `session.header`) is what such a backend stores beside the log.
- Replay/fork: `ctx.sessions.create(id, { seed })` seeds a new session with an existing event log.

### What is NOT here (TODO)

- **Session branching/tree** (pi-style entry tree) — defered unless needed beyond seed-based forking.
