# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it. A **surface** layer (a linked list of message-producing events) is maintained on top of the raw log for efficient derivation and compaction.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event`, flush on `session/flush`, and may mirror the paired `session/created`/`session/disposed` lifecycle.

### Public API

- `ctx.sessions.create(id?: SessionId, options?: { seed?: SessionEvent[]; meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number } }): Session` — Create a session. `options.seed` replays/forks an existing event log: the constructor reads each array entry once, then recursively validates and copies every nested value in one pass so validation and storage cannot observe different getter results or erase an exotic prototype before checking it. `options.meta` attaches creation metadata (validated absolute `cwd`, `parentSession` lineage, seed boundary) as the immutable `SessionHeader`: the store rejects an exotic metadata shell, reads every accepted field once, and constructs a detached, deep-frozen header. The store fills `version`/`id` and defaults `createdAt` to now; a caller reconstructing a persisted session passes the original `createdAt` and persisted `seedLength` to preserve them. Disposed with the calling fiber.
- `ctx.sessions.flush(session: Session): Promise<void>` Dispatch the awaited `session/flush` durability checkpoint with the carrier captured at enter — THE flush entry point (the loop's turn-end checkpoint and idle injection call it; never dispatch a raw `ctx.parallel`). Rejects a prepared, detached, or stale same-id object instead of inventing a subject-less carrier.
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session` — Resolve a live session object or id, select a seed through the inclusive `boundary` event seq (default: current last event), require that boundary to be `turn/end`, and create a live child session with lineage metadata.
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### Advanced: ordered-teardown lifecycle primitives

`create()` covers the common case (the session is owned by the calling fiber). When a session must be torn down **in order with another resource** — so a final flush is captured before the store-owned append observer detaches — `create()`'s self-contained effect is wrong, because a fiber unload disposes sibling effects *concurrently*. For that, split the lifecycle and fold it into the owner's single effect:

- `ctx.sessions.prepare(id?, options?): Session` — read `options.seed`/`options.meta` once, validate and detach the metadata/header, and construct the `Session` WITHOUT entering it into the store. Same options as `create`.
- `ctx.sessions.reserve(id): SessionRegistrationReservation` — hold an unpublished id under the calling fiber and construct its one owned Session through `reservation.prepare(options?)`. Until `release()` or owner unload, bare `prepare`/`create`/`enter` calls for that id reject; the factory later presents the exact capability to `enter`, making setup-time publication structurally impossible without leaking an abandoned reservation across HMR disposal.
- `ctx.sessions.enter(session, reservation?): () => void` — install the module-private `session/event` observer, capture its scope carrier, and add the session under one accepted id; returns the idempotent DETACH disposer, which clears notification, carrier, and accepted-key state. Does NOT emit `session/created` (the caller installs the disposer first, then calls `announce`, so a throwing listener rolls the attach back). It re-checks the id because public `prepare`/`enter` calls may be interleaved; a stale prepared object must not overwrite a live same-id session. A factory passes the opaque capability from `reserve(id)` so setup cannot enter the reserved session or publish a same-id replacement before the owning transaction.
- `ctx.sessions.announce(session): void` — begin the one allowed `session/created` announcement for an entered session; repeat and reentrant calls reject before dispatch. Its detach emits `session/disposed` exactly once, including rollback after a partially delivered creation notification; a never-announced entry emits neither edge.

`dsh-agent-loop` is the canonical consumer: after unpublished agent setup it enters both session and agent before announcing either, then nests loop stop, agent removal, session detach, and scope unwind in one ordered lifecycle. The final flush therefore settles before this package detaches the session, whether teardown starts from an `AgentHandle` or owner-fiber unload.

### Live service events

The store pairs announced creation with disposal, publishes each append, and provides an awaited durability checkpoint. Disposal listener failures, including returned-promise rejections, are contained per observer so teardown cannot be interrupted. Exact `session/*` signatures, modes, and scope-carrier behavior live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the append-only payload vocabulary is separately generated into the [persistence catalog](../../../docs/persistence-catalog.md). Persistence consumers write behind from the append notification and drain on the store-owned flush entry point rather than dispatching the event directly.

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data, opts?): SessionEvent` — synchronous, never blocks on I/O. **Throws** if `data` or surface metadata is not losslessly JSON-serializable (BigInt, function, symbol, undefined, `-0`, non-finite number, circular ref, or an exotic object like Map/Set/Date/class instance). One recursive validate-and-copy pass reads each nested value exactly once and produces the detached value that enters the log, so validation and durability cannot diverge through a stateful getter or a prototype-erasing clone. The accepted event and every nested value are deep-frozen before publication; the returned event and observer notification share that immutable owned record. A third parameter `opts: SurfaceIntent` carries surface metadata: `surfaceOp` and `sourceEventSeqs` are each read once, then the former controls how the event enters the surface linked list and the latter records provenance. Runtime validation accepts only `'append'` or the exact `{ op: 'replace', start, end }` record with non-negative safe-integer bounds, and provenance must be an array of non-negative safe integers; non-surface events reject either field. The marker is **required** for the five `SurfaceEventType` events (every message-producing event must declare how it joins the surface) and rejected by the compiler for non-surface types. The contract is enforced two ways: the typed overload handles a specific event literal, AND runtime checks cover widened unions and raw seed/load logs so invalid metadata can never silently enter or disappear from `deriveMessages()`.
- `session.deriveMessages(): Message[]` — the LLM message history, CACHED: each surface node is projected exactly once, when first seen (O(new nodes) per call; a surface rewrite rebuilds via `surface.replaceGeneration`). Returns a fresh array snapshot per call over SHARED, deep-frozen `Message` objects — cloned once off the log at projection time, so a consumer can never mutate logged data (mutation throws). The surface is the single source of derived history — there is no raw-log fallback.
- `session.deriveEventMessage(event): Message | null` — the per-event projection `deriveMessages()` folds: one event's derived message (an unfrozen clone), or `null` when it produces none (a non-surface event, or an empty-content `assistant/message` hosting only usage). External reconstructors and the dev invariant fold the same function over a log prefix's surface, so no two paths can disagree about what a request's messages were (the reconstructability RFC).
- `session.surface: SurfaceManager` — the derived surface, lazily rebuilt from `surfaceOp` markers in the log. Processes only new events (delta) on each access — the log is append-only, so prior events never change. `surface.replaceGeneration` is the rewrite signal: bumped by every folded `replace` and by `invalidate()`, never reset, so an incremental consumer comparing generations cannot be fooled.
- `session.events` — a cached, frozen array snapshot over deep-frozen events. Repeated reads without an append return the same array; an append invalidates the cache and the next read returns a new snapshot, while earlier snapshots stay unchanged. Neither a cast nor a retained reference can push into the live log or rewrite an accepted event.
- `session.seq`, `session.id` — `id` is a non-writable, non-configurable runtime identity slot, not merely TypeScript-readonly.
- `session.header: SessionHeader` — detached, deep-frozen creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`/`seedLength`) published through a non-writable, non-configurable slot. Construction validates its lossless-JSON shape and requires the header id to match `session.id`, so a caller cannot later replace or mutate persistence routing or lineage. Kept out of the event log (a storage concern, not replayable state); a minimal header (stamped with the current `SESSION_FORMAT_VERSION`) is synthesized for bare `Session` construction.

### Lossless JSON utilities

Durable values need one accepted representation, not a check followed by a second read. `isJsonValue(value)` is the boolean predicate; `snapshotJsonValue(value)` recursively validates and copies a plain value in one pass, returning `undefined` for invalid input and propagating a throwing getter. The snapshot helper accepts finite JSON numbers except `-0` (JSON rewrites it to `0`), dense ordinary arrays, and plain or null-prototype objects; it rejects cycles, unsupported scalars, and exotic prototypes before normalization.

### Surface types

- `SurfaceOp` — how a surface node entered the linked list: `'append'` (normal tail append) or `{ op: 'replace', start, end }` (replace nodes from `start` through `end` inclusive — both must be valid surface node seqs; `start === end` replaces a single node). Used by compaction to shadow old nodes without deleting them.
- `SurfaceIntent` — `{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`, the required third parameter to `session.append()` for surface-eligible types.
- `SurfaceNode` — `{ seq: number; prev: number | null; next: number | null }`, one node in the surface linked list.
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
