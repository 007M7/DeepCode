# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it. A **surface** layer (a linked list of message-producing events) is maintained on top of the raw log for efficient derivation and compaction.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event`, flush on `session/flush`, and may mirror the paired `session/created`/`session/disposed` lifecycle.

### Public API

- `ctx.sessions.create(id?: SessionId, options?: { seed?: readonly SessionEvent[]; meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number } }): Session` — Create a session. The persistence/replay seed and resulting header are validated, detached, and deep-frozen at this durable boundary. The store fills `version`/`id` and defaults `createdAt` to now; a persisted reconstruction supplies the original `createdAt` and `seedLength`. Disposed with the calling fiber.
- `ctx.sessions.flush(session: Session): Promise<void>` Dispatch the awaited `session/flush` durability checkpoint with the carrier captured at enter — THE flush entry point (the loop's turn-end checkpoint and idle injection call it; never dispatch a raw `ctx.parallel`). Every captured listener starts, the call waits for all of them to settle, and a failure rejects only after the other listeners finish. Rejects a prepared, detached, or stale same-id object instead of inventing a subject-less carrier.
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session` — Resolve a live session object or id, select a seed through the inclusive `boundary` event seq (default: current last event), require that boundary to be `turn/end`, and create a live child session with lineage metadata.
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### Advanced: ordered-teardown lifecycle primitives

`create()` covers the common case (the session is owned by the calling fiber). When a session must be torn down **in order with another resource** — so a final flush is captured before the store attachment and publication hooks are removed — `create()`'s self-contained effect is wrong, because a fiber unload disposes sibling effects *concurrently*. For that, split the lifecycle and fold it into the owner's single effect:

- `ctx.sessions.prepare(id?, options?): Session` — validate durable seed/header data and construct the `Session` WITHOUT entering it into the store. Same options as `create`.
- `ctx.sessions.enter(session): () => void` — perform the authoritative ID collision check, install append publication state, and insert the exact session without announcing it. Returns an idempotent detach bound to the captured entry object, so a stale disposer cannot remove a later same-ID replacement. Concurrent same-ID preparation is allowed; only one final entry succeeds.
- `ctx.sessions.announce(session): void` — begin the one allowed `session/created` announcement for an entered session; repeat and reentrant calls reject before dispatch. A detach requested synchronously by a creation listener is deferred until that dispatch unwinds, so another creation listener cannot observe `session/disposed` before its own `session/created` callback. Detach emits `session/disposed` exactly once, including rollback after a partially delivered creation notification; a never-announced entry emits neither edge.

`dsh-agent-loop` is the canonical consumer: after unpublished agent setup it enters both session and agent before announcing either, then nests loop stop, agent removal, session detach, and scope unwind in one ordered lifecycle. The final flush therefore settles before this package detaches the session, whether teardown starts from an `AgentHandle` or owner-fiber unload.

### Live service events

The store pairs announced creation with disposal, publishes each append, and provides an awaited durability checkpoint. Before the log push it resolves the scoped `session/event` callback list. The push is the commit point; callback throws or returned-promise rejections are logged and contained per observer. A committed append therefore returns normally, later observers still run, and detach waits until publication unwinds. Exact `session/*` signatures, modes, and scope-carrier behavior live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the append-only payload vocabulary is separately generated into the [persistence catalog](../../../docs/persistence-catalog.md).

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data, opts?): SessionEvent` — synchronous, never blocks on I/O. At this durable boundary, data and surface metadata are lossless-JSON snapshotted and deep-frozen. For an attached session, a reentrant append during dispatch/observer publication rejects, and detach waits for that publication to unwind. Callbacks resolve before the log push; the push is the commit point, after which each observer failure is contained independently. Runtime surface validation covers widened unions and raw seed/load logs.
- `session.deriveMessages(): Message[]` — the LLM message history, CACHED: each surface node is projected exactly once, when first seen (O(new nodes) per call; a surface rewrite rebuilds via `surface.replaceGeneration`). Returns a fresh array per call over shared, deep-frozen `Message` objects. Each projection reuses the already deep-frozen content in its durable log event, so no second deep clone is needed and a consumer still cannot mutate logged data. The surface is the single source of derived history — there is no raw-log fallback.
- `session.deriveEventMessage(event): Message | null` — the per-event projection `deriveMessages()` folds: a fresh message wrapper that reuses the event's already frozen content, or `null` when the event produces none (a non-surface event, or an empty-content `assistant/message` hosting only usage). External reconstructors and the dev invariant fold the same function over a log prefix's surface, so no two paths can disagree about what a request's messages were (the reconstructability RFC).
- `session.surface: SurfaceManager` — the derived surface, lazily rebuilt from `surfaceOp` markers in the log. Processes only new events (delta) on each access — the log is append-only, so prior events never change. `surface.replaceGeneration` is the rewrite signal: bumped by every folded `replace` and by `invalidate()`, never reset, so an incremental consumer comparing generations cannot be fooled.
- `session.events` — a cached, frozen array snapshot over deep-frozen events. Repeated reads without an append return the same array; an append invalidates the cache and the next read returns a new snapshot, while earlier snapshots stay unchanged. Neither a cast nor a retained reference can push into the live log or rewrite an accepted event.
- `session.seq`, `session.id` — current sequence and readonly typed identity.
- `session.header: SessionHeader` — detached, deep-frozen creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`/`seedLength`). Construction validates the durable record and requires its id to match `session.id`.

### Lossless JSON utilities

Durable values need one accepted representation, not a check followed by a second read. `isJsonValue(value)` is the boolean predicate; `snapshotJsonValue(value)` recursively validates and copies a plain value in one pass, returning `undefined` for invalid input and propagating a throwing getter. The snapshot helper accepts finite JSON numbers except `-0` (JSON rewrites it to `0`), dense ordinary arrays, and plain or null-prototype objects; it rejects cycles, unsupported scalars, and exotic prototypes before normalization.

### Surface types

- `SurfaceOp` — how a surface node entered the linked list: `'append'` (normal tail append) or `{ op: 'replace', start, end }` (replace nodes from `start` through `end` inclusive — both must be valid surface node seqs; `start === end` replaces a single node). Used by compaction to shadow old nodes without deleting them.
- `SurfaceIntent` — `{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`, the required third parameter to `session.append()` for surface-eligible types.
- `SurfaceNode` — `{ seq: number; prev: number | null; next: number | null }`, one node in the surface linked list.
- `foldSurface(events)` — replay the canonical surface transitions into detached current nodes and actual replacement ranges, rejecting surface-eligible events that lack their mandatory marker. `SurfaceManager` shares the same transitions while retaining its incremental cache.
- `isSurfaceEvent(event)` / `isSurfaceEligibleType(type)` — the first narrows a `SessionEvent` to a fully-formed surface node (type is surface-eligible AND `surfaceOp` present); the second is the type-only check (is this one of the five `SurfaceEventType` values?), used to detect a surface-eligible event MISSING its marker — e.g. when validating a seed/load log.

### Request-header reconstruction (`request-header.ts`)

The `request/header` (full `EpochHeader` snapshot with a `RequestHeaderReason`) and `request/header-delta` (system line-trim / name-keyed tools delta / whole config / whole session prefix) events make the request envelope logged session state, so every conversation request is a pure function of the log. The pure trio reconstructs it: `foldRequestHeader(events)` folds a log (or any prefix) into the header in force; `diffHeader(prev, next)` encodes a change (undefined when equal); `applyHeaderDelta(prev, delta)` replays one. Writer contract: every logged delta is round-trip-verified (`apply(prev, delta)` deep-equals the new header) with a `'fallback'` snapshot when the encoding cannot express the change (a pure tool reordering), so folding never needs error recovery on a well-formed log. `canonicalHeader` pins the one representation of absence (empty system/tools/messagePrefix ≡ absent fields; a delta's EMPTY prefix array encodes the transition back to absence). `EpochHeader.messagePrefix` is the durable record of the `agent/session-prefix` waterfall's product — composed once per loop instance, the request is `messagePrefix + derived history`, and `deriveMessages()` never returns it.

### Session event vocabulary (`types.ts`)

The append-only log's event types, enumerated member by member — payloads, surface badges, provenance — in the generated [persistence log event catalog](../../../docs/persistence-catalog.md). Token usage rides on `assistant/message.usage`; an operational error's step is on `turn/end.reason` for `kind: 'error'`.

Merge-extensible via `SessionEventMap` — a plugin declaration-merges its own types (the compaction seam's `compact/*`, the hook bridges' `hook/*`); merged members appear in the same catalog.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings).

Every `SessionEvent` carries two optional top-level fields (structural metadata):

- `sourceEventSeqs?: number[]` — seq numbers of provenance sources (e.g., the `assistant/chunk` seqs behind an `assistant/message`, or the shadowed nodes behind a compaction replace node).
- `surfaceOp?: SurfaceOp` — how this event entered the surface. Absent for non-surface events (boundaries, chunks, usage, errors).

### Metadata types (`types.ts`)

- `SessionHeader` — session metadata written once when published as `Session.header`, where detachment and deep-freezing enforce immutability at runtime: `{ version, id, createdAt, cwd?, parentSession?, seedLength? }`. Persistence loaders may return mutable detached copies of the same data type. Owned here (beside `SessionId`) because `Session.header` is typed by it; persistence backends re-export it rather than own it (which would force a package cycle).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. A durable backend reads the log and reloads it into a live session; the metadata seam (`SessionHeader`, `session.header`) is what such a backend stores beside the log.
- Replay/fork: `ctx.sessions.create(id, { seed })` seeds a new session with an existing event log. The surface rebuilds deterministically from `surfaceOp` markers in the seeded events. The constructor reads each seed entry once and uses the same one-pass lossless-JSON snapshot and exact surface-metadata shape checks as `append`, then enforces contiguous seqs and deep-freezes every accepted record; a stateful caller, exotic nested value, marker-less or malformed surface event, metadata on a non-surface event, or retained seed reference therefore cannot silently change the reconstructed history. Broader turn-enclosure checks stay in `dsh-invariants` and persistence repair. Ordinary live-session forks use `ctx.sessions.fork(source, boundary?, childSessionId?)`, where `boundary` is the inclusive source event seq to fork through.
- Compaction: the `dsh-compact-basic` plugin appends a `user/message` with `surfaceOp: { op: 'replace', start, end }` to shadow old surface nodes behind a summary checkpoint.

### What is NOT here (TODO)

- **Session branching/tree** (pi-style entry tree) — deferred unless needed beyond boundary-based `fork()`.
