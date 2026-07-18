# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it. A **surface** layer (an ordered projection of message-producing events) is maintained on top of the raw log for efficient derivation and compaction.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event`, flush on `session/flush`, and may mirror the paired `session/created`/`session/disposed` lifecycle.

### Public API

- `ctx.sessions.create(id?, { seed?, meta? }?)` validates and detaches durable seed/header data, fills the version and id, defaults `createdAt` to now, publishes the session, and binds it to the calling fiber. Persisted reconstruction supplies its original `createdAt` and `seedLength`.
- `ctx.sessions.flush(session)` dispatches the awaited parallel durability checkpoint through the session's captured scope. Every listener starts and the call waits for all to settle before reporting failure; unpublished, detached, and stale objects reject.
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session` — Resolve a live session object or id, select a seed through the inclusive `boundary` event seq (default: current last event), require that boundary to be `turn/end`, and create a live child session with lineage metadata.
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### Advanced: ordered-teardown lifecycle primitives

Use the split lifecycle only when teardown must be ordered with another resource:

- `prepare(id?, options?)` validates and constructs without publication.
- `enter(session)` performs the collision check, publishes without announcing, and returns an entry-bound idempotent detach. Concurrent same-id preparations are allowed, but only one entry succeeds; a stale detach cannot remove its replacement.
- `announce(session)` emits the single creation edge and rejects repeat or reentrant announcements. Detach during that dispatch is deferred and later emits the paired disposal edge; an unannounced entry emits neither lifecycle edge.

`dsh-agent-loop` uses this split so final loop flush precedes session detach; see the [ownership RFC](../../../docs/rfc/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

### Live service events

The store pairs announced creation with disposal, publishes post-commit append notifications with per-listener containment, and provides an awaited durability checkpoint. Exact signatures and scope behavior live in the generated [event catalog](../../../docs/cordis-catalog/events.md); payloads live in the [persistence catalog](../../../docs/persistence-catalog.md).

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data, opts?)` snapshots and freezes durable data and surface metadata, validates marker shape, provenance, and complete replacement coverage, commits synchronously, then notifies observers with independent failure containment. Reentrant attached-session appends reject, and runtime checks cover widened unions and loaded logs.
- `session.deriveMessages()` incrementally projects each new surface entry once and returns a fresh array over shared frozen messages. Assistant projections preserve provider/model provenance and adapter-private replay state. A surface rewrite rebuilds the projection; there is no raw-log fallback.
- `session.deriveEventMessage(event)` is the canonical per-event projection used by reconstruction and invariants.
- `session.surface` lazily folds only new `surfaceOp` markers; `replaceGeneration` changes on every rewrite.
- `session.events` is a cached frozen snapshot invalidated by append; accepted events remain deeply frozen.
- `session.seq`, `session.id` — current sequence and readonly typed identity.
- `session.header: SessionHeader` — detached, deep-frozen creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`/`seedLength`). Construction validates the durable record and requires its id to match `session.id`.

### Lossless JSON utilities

Durable values need one accepted representation, not a check followed by a second read. `isJsonValue(value)` is the boolean predicate; `snapshotJsonValue(value)` recursively validates and copies a plain value in one pass, returning `undefined` for invalid input and propagating a throwing getter. The snapshot helper accepts finite JSON numbers except `-0` (JSON rewrites it to `0`), dense ordinary arrays, and plain or null-prototype objects; it rejects cycles, unsupported scalars, and exotic prototypes before normalization.

### Surface types

- `SurfaceOp` — how an event entered the ordered surface: `'append'` (normal tail append) or `{ op: 'replace', start, end }` (replace entries from `start` through `end` inclusive — both must be valid surface seqs; `start === end` replaces one entry). Used by compaction to shadow old events without deleting them.
- `SurfaceIntent` — `{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`, the required third parameter to `session.append()` for surface-eligible types.
- `foldSurface(events)` — replay the canonical surface contract into detached current event sequences and actual replacement ranges. The same pass rejects non-contiguous seqs, misplaced or malformed metadata, empty or duplicate provenance, non-earlier sources, invalid positional ranges, and replacements that fail to cite every shadowed surface entry; `SurfaceManager` shares the atomic transition while retaining only its incremental sequence cache.
- `isSurfaceEvent(event)` / `isSurfaceEligibleType(type)` — the first narrows a `SessionEvent` to a fully formed surface event; the second detects a surface-eligible event missing its marker when validating a seed or loaded log.

### Request-header reconstruction (`request-header.ts`)

`request/header` records a full canonical snapshot of the non-history request envelope with reason `initial`, `resume`, or `change`. `foldRequestHeader()` selects the latest snapshot; legacy delta events and the removed `fallback` reason are rejected. `messagePrefix` remains separate from derived history. See the [reconstructable-requests RFC](../../../docs/rfc/implemented/architecture/2026-07-05-reconstructable-requests.md).

`context/message` defaults to the canonical tagged context projection. A producer may set `envelope: 'raw'` when its `content` already contains the complete model-facing frame, and may attach JSON `meta` for replayable plugin state; metadata remains durable but is excluded from `deriveMessages()`.

### Session event vocabulary (`types.ts`)

The append-only log's event types, enumerated member by member — payloads, surface badges, provenance — in the generated [persistence log event catalog](../../../docs/persistence-catalog.md). Token usage and provider/model/replay provenance ride on `assistant/message`; an operational error's step is on `turn/end.reason` for `kind: 'error'`.

Merge-extensible via `SessionEventMap` — a plugin declaration-merges its own types (the compaction seam's `compact/*`, the hook bridges' `hook/*`); merged members appear in the same catalog.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings).

Every `SessionEvent` carries two optional top-level fields (structural metadata):

- `sourceEventSeqs?: number[]` — seq numbers of provenance sources (e.g., the `assistant/chunk` seqs behind an `assistant/message`, or the shadowed entries behind a compaction replacement entry). On `assistant/message`, a present `[]` records a known empty provider stream, while omission means legacy or otherwise unrecorded provenance; other surface events require a non-empty list when this field is present.
- `surfaceOp?: SurfaceOp` — how this event entered the surface. Absent for non-surface events (boundaries, chunks, usage, errors).

### Metadata types (`types.ts`)

- `SessionHeader` — session metadata written once when published as `Session.header`, where detachment and deep-freezing enforce immutability at runtime: `{ version, id, createdAt, cwd?, parentSession?, seedLength? }`. Persistence loaders may return mutable detached copies of the same data type. Owned here (beside `SessionId`) because `Session.header` is typed by it; persistence backends re-export it rather than own it (which would force a package cycle).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. A durable backend reads the log and reloads it into a live session; the metadata seam (`SessionHeader`, `session.header`) is what such a backend stores beside the log.
- Replay/fork: `create(id, { seed })` validates and freezes a contiguous current-format log and rebuilds its surface; request headers require provider/model and assistant messages require provider/model provenance. `fork(source, boundary?, childSessionId?)` selects a completed-turn prefix and records lineage.
- Compaction: the `dsh-compact-basic` plugin appends a `user/message` with `surfaceOp: { op: 'replace', start, end }` to shadow old surface entries behind a summary checkpoint. Tool-pairing boundary policy and its cache belong to the [`dsh-compact` seam](../../compact/compact/README.md), while this package owns ordered surface membership and `replaceGeneration`.

## Model Experience

### Derived message history

**What the model sees**: The model receives projections of `user/message`, `assistant/message`, and `tool/result` surface entries verbatim. A `context/message` is a user-role message containing exactly `<context source="<source-kind>">`, its content blocks, and `</context>`; `steering/message` uses the identical `<steering source="<source-kind>">` / `</steering>` wrapper. Tool calls live inside assistant messages. Chunks, boundaries, usage, hook records, todo records, and other log-only events add no message.

**Token effect**: Appended surface entries are resent on later steps. A `replace` surface operation removes the shadowed entries from future inputs without deleting their raw log records.

### Crash-repair result

**What the model sees**: If a persisted turn ended with unanswered tool calls, each synthetic error result contains exactly `Tool call interrupted by a crash; no result was recorded.`

**Token effect**: Zero tokens in an intact session. Each repaired call adds this retained error text on resume.

### Logged request header

**What the model sees**: The session reconstructs the system prompt, tool schemas, call config, and session prefix that the loop actually sent. Header events do not add a second copy to message history; the prefix is prepended outside `deriveMessages()`.

**Token effect**: Zero duplicate tokens from logging. The reconstructed prefix, system text, and schemas still incur their normal per-request cost.

## Known Limitations and Deferred Work

- **Session branching/tree** (pi-style entry tree) — deferred unless needed beyond boundary-based `fork()`.
- **`fork()` cuts only at closed-turn boundaries of live sessions** — the boundary must be a `turn/end` event and the source must be in the store; forking a persisted-but-unloaded session is excluded from the [fork API](../../../docs/rfc/implemented/feature/2026-06-30-session-store-fork-api.md).
- **`SESSION_FORMAT_VERSION` stays pinned at `0`** — pre-release, no compatibility implied: a backend rejects any other version, and no migration path exists until the first release ([policy](../../../AGENTS.md)).
- **`TurnEndReasonMap` omits the ACP-named `refusal` / `max_turn_requests` variants** — producer-gated: they land when an adapter or the loop first emits them.
