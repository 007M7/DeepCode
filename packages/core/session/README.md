# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it. A **surface** layer (a linked list of message-producing events) is maintained on top of the raw log for efficient derivation and compaction.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event` and flush on `session/flush`.

### Public API

- `ctx.sessions.create(id?: SessionId, options?: { seed?: SessionEvent[]; meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number } }): Session` — Create a session. `options.seed` replays/forks an existing event log; `options.meta` attaches creation metadata (validated absolute `cwd`, `parentSession` lineage, seed boundary) as the immutable `SessionHeader`. The store fills `version`/`id` and defaults `createdAt` to now; a caller reconstructing a persisted session passes the original `createdAt` and persisted `seedLength` to preserve them. Disposed with the calling fiber.
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

- `session.append(type, data, opts?): SessionEvent` — synchronous, never blocks on I/O. **Throws** if `data` is not losslessly JSON-serializable (BigInt, function, symbol, undefined, non-finite number, circular ref, or an exotic object like Map/Set/Date) — the event log is the durable source of truth, so this invariant is enforced at the source (exported as `isJsonValue` for backends to reuse on their replay/fork entry points). A third parameter `opts: SurfaceIntent` carries surface metadata: `surfaceOp` controls how the event enters the surface linked list, and `sourceEventSeqs` records provenance (the seq numbers of events this one derives from). It is **required** for the five `SurfaceEventType` events (every message-producing event must declare how it joins the surface) and rejected by the compiler for non-surface types. The marker requirement is enforced two ways: the typed overload makes `opts` mandatory when `type` is a specific `SurfaceEventType` literal, AND `append` **throws** at runtime if a surface-eligible event arrives with no `surfaceOp` — covering the case where `type` widens to the `SessionEventType` union (a caller iterating raw events, where the conditional overload collapses to optional) so a marker-less message event can never silently land in the log and vanish from `deriveMessages()`.
- `session.deriveMessages(): Message[]` — derive the LLM message history by walking the surface linked list (skipping non-surface events like chunks and boundaries; a `replace` shadows the nodes it covers). The surface is the single source of derived history — there is no raw-log fallback.
- `session.surface: SurfaceManager` — the derived surface, lazily rebuilt from `surfaceOp` markers in the log. Processes only new events (delta) on each access — the log is append-only, so prior events never change.
- `session.events`, `session.seq`, `session.id`
- `session.header: SessionHeader` — immutable creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`/`seedLength`). Kept out of the event log (a storage concern, not replayable state); a minimal header (stamped with the current `SESSION_FORMAT_VERSION`) is synthesized for bare `Session` construction.

### Surface types

- `SurfaceOp` — how a surface node entered the linked list: `'append'` (normal tail append) or `{ op: 'replace', start, end }` (replace nodes from `start` through `end` inclusive — both must be valid surface node seqs; `start === end` replaces a single node). Used by compaction to shadow old nodes without deleting them.
- `SurfaceIntent` — `{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`, the required third parameter to `session.append()` for surface-eligible types.
- `SurfaceNode` — `{ seq: number; prev: number | null; next: number | null }`, one node in the surface linked list.
- `isSurfaceEvent(event)` / `isSurfaceEligibleType(type)` — the first narrows a `SessionEvent` to a fully-formed surface node (type is surface-eligible AND `surfaceOp` present); the second is the type-only check (is this one of the five `SurfaceEventType` values?), used to detect a surface-eligible event MISSING its marker — e.g. when validating a seed/load log.

### Session event vocabulary (`types.ts`)

The append-only log's event types, enumerated member by member — payloads, surface badges, provenance — in the generated [persistence log event catalog](../../../docs/persistence-catalog/log-events.md). Token usage rides on `assistant/message.usage`; an operational error's step is on `turn/end.reason` for `kind: 'error'`.

Merge-extensible via `SessionEventMap` — a plugin declaration-merges its own types (the compaction seam's `compact/*`, the hook bridges' `hook/*`); merged members appear in the same catalog.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings).

Every `SessionEvent` carries two optional top-level fields (structural metadata):

- `sourceEventSeqs?: number[]` — seq numbers of provenance sources (e.g., the `assistant/chunk` seqs behind an `assistant/message`, or the shadowed nodes behind a compaction replace node).
- `surfaceOp?: SurfaceOp` — how this event entered the surface. Absent for non-surface events (boundaries, chunks, usage, errors).

### Metadata types (`types.ts`)

- `SessionHeader` — immutable session metadata, written once: `{ version, id, createdAt, cwd?, parentSession?, seedLength? }`. Owned here (beside `SessionId`) because `Session.header` is typed by it; persistence backends re-export it rather than own it (which would force a package cycle).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. A durable backend reads the log and reloads it into a live session; the metadata seam (`SessionHeader`, `session.header`) is what such a backend stores beside the log.
- Replay/fork: `ctx.sessions.create(id, { seed })` seeds a new session with an existing event log. The surface rebuilds deterministically from `surfaceOp` markers in the seeded events. The seed is validated to the SAME invariants `append` enforces — including that every surface-eligible event (`SurfaceEventType`) carries a `surfaceOp` marker — so a marker-less message event is rejected at construction rather than silently vanishing from `deriveMessages()` (the surface is the sole derivation path) on resume.
- Compaction: the `dsh-compact-basic` plugin appends a `user/message` with `surfaceOp: { op: 'replace', start, end }` to shadow old surface nodes behind a summary checkpoint.

### What is NOT here (TODO)

- **Session branching/tree** (pi-style entry tree) — deferred unless needed beyond seed-based forking.
