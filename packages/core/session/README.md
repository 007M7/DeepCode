# dsh-session

Event-sourced session log and in-memory store. A `Session` is the append-only source of truth for an agent's whole interaction history — the LLM message history is *derived* from it. A **surface** layer (an ordered projection of message-producing events) is maintained on top of the raw log for efficient derivation and compaction.

The optional `@deepseek-ai/dsh-session/invariant` companion registers this package's relational trace checks with `ctx.invariants`: monotonic sequence numbers, turn/step enclosure, and same-step tool call/result pairing. It replays existing sessions when loaded or reloaded; storage validation, snapshotting, freezing, provenance, and surface acceptance remain always-on responsibilities of the root session package.

## Service: `SessionStore` (ctx key: `sessions`)

Creates and holds event-sourced `Session` instances. Persistence is intentionally not implemented here — plugins subscribe to `session/event`, flush on `session/flush`, and may mirror the paired `session/created`/`session/disposed` lifecycle.

### Public API

- `ctx.sessions.create(id?, { seed?, meta? }?)` validates and detaches durable seed/header data, fills the version and id, defaults `createdAt` to now, publishes the session, and binds it to the calling fiber. Persisted reconstruction supplies its original `createdAt`, `seedLength`, and `delegationDepth`.
- `ctx.sessions.flush(session)` dispatches the awaited parallel durability checkpoint through the session's captured scope. Every listener starts and the call waits for all to settle before reporting failure; unpublished, detached, and stale objects reject.
- `ctx.sessions.appendOutOfBand(session, type, data, trigger)` accepts only plugin event types opted into `OutOfBandSessionEventMap`. It appends directly inside an open turn; otherwise it atomically opens a zero-step plugin turn, appends, closes, and flushes. A target failure still closes and flushes the synthetic turn, and detach is deferred until the sequence settles.
- `findLastMessageTurnEnd(events)` pairs message-triggered starts with their ends and returns the latest matched `turn/end`. Outcome consumers use this fold instead of the raw latest turn boundary because a later injection or plugin-owned zero-step turn has its own outcome.
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session` — Resolve a live session object or id, select a seed through the inclusive `boundary` event seq (default: current last event), require that boundary to be `turn/end`, and create a live child session with lineage metadata.
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### Advanced: ordered-teardown lifecycle primitives

Use the split lifecycle only when teardown must be ordered with another resource:

- `prepare(id?, options?)` validates and constructs without publication.
- `enter(session)` performs the collision check, publishes without announcing, and returns an entry-bound idempotent detach. Concurrent same-id preparations are allowed, but only one entry succeeds; a stale detach cannot remove its replacement.
- `announce(session)` emits the single creation edge and rejects repeat or reentrant announcements. Detach during that dispatch is deferred and later emits the paired disposal edge; an unannounced entry emits neither lifecycle edge.

`dsh-agent-loop` uses this split so final loop flush precedes session detach; see the [ownership Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

### Live service events

The store pairs announced creation with disposal, publishes post-commit append notifications with per-listener containment, and provides an awaited durability checkpoint. Exact signatures and scope behavior live in the generated [event catalog](../../../docs/cordis-catalog/events.md); payloads live in the [persistence catalog](../../../docs/persistence-catalog.md).

### Class: `Session`

Plain class (not a Cordis Service). Create via `ctx.sessions.create()`.

- `session.append(type, data, opts?)` snapshots and freezes durable data and surface metadata, validates marker shape, provenance, complete replacement coverage, and content-only single-result `tool/result` rewrites, commits synchronously, then notifies observers with independent failure containment. Reentrant attached-session appends reject, and runtime checks cover widened unions and loaded logs.
- `session.deriveMessages()` incrementally projects each new surface entry once and returns a fresh array over shared frozen messages. Assistant projections preserve provider/model provenance and adapter-private replay state. A surface rewrite rebuilds the projection; there is no raw-log fallback.
- `session.deriveEventMessage(event)` is the canonical per-event projection used by reconstruction and request checks.
- `session.surface` exposes the readonly `SessionSurface` view owned by the session's single incremental surface manager; `replaceGeneration` changes on every committed rewrite.
- `session.events` is a cached frozen snapshot invalidated by append; accepted events remain deeply frozen.
- `session.seq`, `session.id` — current sequence and readonly typed identity.
- `session.header: SessionHeader` — detached, deep-frozen creation metadata (`version`, `id`, `createdAt`, optional `cwd`/`parentSession`/`seedLength`/`delegationDepth`). Construction validates the durable record and requires its id to match `session.id`.

### Lossless JSON utilities

Durable values need one accepted representation, not a check followed by a second read. `isJsonValue(value)` is the boolean predicate; `snapshotJsonValue(value)` iteratively validates and copies a plain value in one pass, returning `undefined` for invalid input and propagating a throwing getter. The snapshot helper accepts finite JSON numbers except `-0` (JSON rewrites it to `0`), dense ordinary arrays, and plain or null-prototype objects; it rejects cycles, unsupported scalars, and exotic prototypes before normalization without imposing a call-stack depth limit.

### Chunk-row storage codec (`chunk-rows.ts`)

Providers stream token-sized deltas, so a raw log stores hundreds of `assistant/chunk` lines whose JSON envelopes dwarf their payloads. `packChunkRuns(events)` packs each run of ≥3 consecutive same-block delta chunks into one storage row — `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` (bare slash-less tags: storage vocabulary, not `SessionEventMap` members) — and `decodeStorageRecord(value)` expands a parsed line back into its exact events (`seq0`/`time0` + per-member `dt` gaps reconstruct every `seq`/`time`). The encoder whitelists exact shapes and stores anything unrecognized verbatim; the decoder validates row-tagged values and throws on malformation. Owned here so the JSONL backend and the fixture readers (`dsh-llm-replay`, `dsh-acp-snapshot`) share one codec; the write-side switch is the backend's `packChunks` config.

### Surface types

- `SurfaceOp` — how an event entered the ordered surface: `'append'` (normal tail append) or `{ op: 'replace', start, end }` (replace entries from `start` through `end` inclusive — both must be valid surface seqs; `start === end` replaces one entry). Used by compaction to shadow old events without deleting them.
- `SurfaceIntent` — `{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`, the required third parameter to `session.append()` for surface-eligible types.
- `SessionSurface` — the readonly live `nodes` and `replaceGeneration` projection exposed by `session.surface`; candidate validation remains private to `Session`.
- `foldSurface(events)` — replay the canonical surface contract into detached current event sequences and actual replacement ranges. The same pass rejects non-contiguous seqs, misplaced or malformed metadata, empty or duplicate provenance, non-earlier sources, invalid positional ranges, replacements that fail to cite every shadowed surface entry, and a `tool/result` replacement that changes anything except one current result's `content`; `SurfaceManager` shares the atomic transition while retaining only its incremental sequence cache.
- `isSurfaceEvent(event)` / `isSurfaceEligibleType(type)` — the first narrows a `SessionEvent` to a fully formed surface event; the second detects a surface-eligible event missing its marker when validating a seed or loaded log.

### Request-header reconstruction (`request-header.ts`)

`request/header` records a full canonical snapshot of the non-history request envelope with reason `initial`, `resume`, or `change`. `foldRequestHeader()` selects the latest snapshot; legacy delta events and the removed `fallback` reason are rejected. `messagePrefix` remains separate from derived history. See the [reconstructable-requests Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md).

A `user/message` renders its `content` verbatim as a user-role message whether it is a direct human prompt (`user` source), a synthetic injection (`plugin`/`goal` source), or an admitted goal round — `source` is the only channel that tells them apart. It may attach JSON `meta` for replayable plugin state; metadata remains durable but is excluded from `deriveMessages()`. A `user/message` or `steering/message` with prompt-prefix context keeps the exact combined model bytes in `content` and stores a model-hidden `envelope` containing the direct `displayContent` and prefix context source/metadata descriptors. `displayPromptContent()` selects the human-facing prompt without changing derived history.

`tool/result` persists the model-facing content, optional internal failure identity, and optional presentation metadata. A tool's successful canonical `value` and human-readable canonical failure message remain execution-local; rendered error content is the replay-authoritative message. This preserves the existing event shape and does not change `SESSION_FORMAT_VERSION`.

### Session event vocabulary (`types.ts`)

The append-only log's event types, enumerated member by member — payloads, surface badges, provenance — in the generated [persistence log event catalog](../../../docs/persistence-catalog.md). Token accounting reads per-step `assistant/chunk { type: 'usage' }` records and treats `assistant/message.usage` as the committed-step fallback when no usage chunk exists; failed model-request attempts have no assistant message. Provider/model/replay provenance rides on `assistant/message`; an operational error's step is on `turn/end.reason` for `kind: 'error'`, with structured provider facts for a final model-request failure.

Merge-extensible via `SessionEventMap` — a plugin declaration-merges its own types (the compaction seam's `compact/*`, bounded recovery's non-surface `llm/retry`, the hook bridges' `hook/*`); merged members appear in the same catalog. `OutOfBandSessionEventMap` is a separate empty-by-default marker map: an event owner must merge the same key there before `appendOutOfBand()` accepts that log-only type, while surface and lifecycle types remain excluded.

Also defines `TurnTriggerMap` and `TurnEndReasonMap` (merge-extensible sum types for typed turn boundaries — `kind`-tagged instead of strings). A final model-request error retains one structured `LlmFailure`; other turn errors retain message/code, and both identify the failed step.

An interrupted live turn ends with the coarse `{ kind: 'aborted' }` outcome. Caller identity belongs to the Agent's runtime cancellation signal rather than the durable transcript; disposal remains the separate `{ kind: 'disposed' }` terminal state.

Every `SessionEvent` carries two optional top-level fields (structural metadata):

- `sourceEventSeqs?: number[]` — seq numbers of provenance sources (e.g., the `assistant/chunk` seqs behind an `assistant/message`, or the shadowed entries behind a compaction replacement entry). On `assistant/message`, a present `[]` records a known empty provider stream, while omission means legacy or otherwise unrecorded provenance; other surface events require a non-empty list when this field is present.
- `surfaceOp?: SurfaceOp` — how this event entered the surface. Absent for non-surface events (boundaries, chunks, usage, errors).

### Metadata types (`types.ts`)

- `SessionHeader` — session metadata written once when published as `Session.header`, where detachment and deep-freezing enforce immutability at runtime: `{ version, id, createdAt, cwd?, parentSession?, seedLength?, delegationDepth? }`. Persistence loaders may return mutable detached copies of the same data type. Owned here (beside `SessionId`) because `Session.header` is typed by it; persistence backends re-export it rather than own it (which would force a package cycle).

### Extension points

- Persistence plugins: subscribe to `session/event` (write-behind) and drain on `session/flush` (awaited) and fiber dispose. A durable backend reads the log and reloads it into a live session; the metadata seam (`SessionHeader`, `session.header`) is what such a backend stores beside the log.
- Replay/fork: `create(id, { seed })` validates and freezes a contiguous current-format log and rebuilds its surface; request headers require provider/model, assistant messages require provider/model provenance, and a coarse aborted outcome must contain only `{ kind: 'aborted' }` (legacy reason-bearing records are rejected). `fork(source, boundary?, childSessionId?)` selects a completed-turn prefix and records lineage.
- Compaction: `dsh-compact-basic` appends a `user/message` replacement for summary checkpoints, while `dsh-compact-tool-result-prune` appends a content-only `tool/result` replacement. Tool-pairing boundary policy and its cache belong to the [`dsh-compact` seam](../../compact/compact/README.md), while this package owns ordered surface membership, replacement validation, and `replaceGeneration`.

## Model Experience

### Derived message history

#### What the model sees

The model receives projections of `user/message`, `assistant/message`, `tool/result`, and `steering/message` surface entries verbatim: each is a user- or assistant-role message carrying its content blocks unchanged. A prompt envelope changes only human presentation; its prefix context and request delimiter are already present in the event content. Tool calls live inside assistant messages. Chunks, boundaries, usage, hook records, todo records, and other log-only events add no message.

#### Token effect

Appended surface entries are resent on later steps. A `replace` surface operation removes the shadowed entries from future inputs without deleting their raw log records.

#### KV Cache effect

Appended surface entries preserve reusable prefixes. A `replace` operation invalidates reuse from the first shadowed message even though the underlying event log stays append-only.

### Crash-repair result

#### What the model sees

If recovery finds an assistant tool request with no durable `tool/call`, its synthetic `TOOL_NOT_STARTED` result says `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.` If a durable `tool/call` has no result, its `TOOL_OUTCOME_UNKNOWN` result says `The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.`

#### Token effect

Zero tokens in an intact session. Each repaired call adds its retained risk-specific error text on resume.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Logged request header

#### What the model sees

The session reconstructs the system prompt, tool schemas, call config, and session prefix that the loop actually sent. Header events do not add a second copy to message history; the prefix is prepended outside `deriveMessages()`.

#### Token effect

Zero duplicate tokens from logging. The reconstructed prefix, system text, and schemas still incur their normal per-request cost.

#### KV Cache effect

Logging causes no invalidation, and exact reconstruction preserves request-prefix identity. A later header with changed prefix, prompt, or schemas may invalidate reuse from its first difference.

## Known Limitations and Deferred Work

- **Session branching/tree** (pi-style entry tree) — deferred unless needed beyond boundary-based `fork()`.
- **`fork()` cuts only at closed-turn boundaries of live sessions** — the boundary must be a `turn/end` event and the source must be in the store; forking a persisted-but-unloaded session is excluded from the [fork API](../../../.agents/notes/implemented/feature/2026-06-30-session-store-fork-api.md).
- **`SESSION_FORMAT_VERSION` stays pinned at `0`** — pre-release, no compatibility implied: a backend rejects any other version, and no migration path exists until the first release ([policy](../../../AGENTS.md)).
- **`TurnEndReasonMap` omits the ACP-named `refusal` / `max_turn_requests` variants** — producer-gated: they land when an adapter or the loop first emits them.
