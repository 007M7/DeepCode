# @deepseek-ai/dsh-session-persistence

The abstract durable session-persistence seam (`ctx.sessionPersistence`). Defines WHAT a persistence backend does — durably store, reload, and list sessions — without saying HOW. Mirrors the `dsh-bash` capability-seam template ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract service here, a concrete implementation in a sibling package, consumers that inject the interface.

The persisted unit IS the existing `SessionEvent` (event-sourced model — the log is the single source of truth), so there is no parallel "persisted message" type. Metadata that is NOT replayable conversation state (format version, cwd, lineage, seed boundary, delegation depth) travels separately as `SessionHeader`, owned by `dsh-session` and re-exported here.

## Service API (`ctx.sessionPersistence`)

| Method | Contract |
|---|---|
| `locate(meta): SessionLocation \| undefined` | Resolve an absolute per-session artifact target without I/O or materialization. Backends without an independent local artifact return `undefined`. |
| `create(meta): Promise<void>` | Register a new session's metadata. MAY defer the physical write until the first `append` (lazy materialization). |
| `append(id, events): Promise<void>` | Durably persist a batch. Append-only; first event `seq` == stored next-seq after any repair; rejects non-JSON-serializable data naming the offending type. |
| `load(id): Promise<{ meta; events }>` | Return a stored header plus a balanced contiguous log. A live load first flushes its snapshot and rejects while its turn is open; a cold load preserves an interrupted final turn and closes it with synthetic `tool/result`/`step/end?`/`turn/end {interrupted}` events. Only a torn tail fragment is dropped; committed corruption and unknown `version` reject. |
| `inspect(id): Promise<{ meta; events }>` | Return a detached valid stored prefix without truncating a torn tail, synthesizing recovery closers, or publishing coordinator state. Serialized with same-id writes; intended for read models and other observers that must never recover a log. |
| `list(): Promise<SessionHeader[]>` | Lightweight listing from metadata, no full-log parse. A zero-event lazily-materialized session is absent from `list`. |
| `listSnapshots(): Promise<SessionPersistenceSnapshot[]>` | Lightweight metadata plus an opaque branded per-log revision, without loading event logs. A revision stays equal while that log and its backing store are unchanged, changes after append or mutating load repair, and cannot collide solely because two stores use the same local counter. |

## Invariants every backend must honor

- **Append-only; a crashed turn is closed, not truncated.** Flushed events are never rewritten. A crash can leave an unclosed final turn whose events are real and possibly large; `load` preserves them and durably appends synthetic closers (a risk-classified error `tool/result` per unanswered assistant call, then `step/end?`+`turn/end {interrupted}`) to balance the log and keep the rehydrated history a valid provider transcript. Only a never-fully-written torn tail fragment is discarded.
- **Contiguous seq.** `load` rejects a `seq` gap/parse error in the MIDDLE of the log; `append`'s first `seq` must equal the stored next-seq.
- **JSON-serializable data.** `append` materializes each direct/replay batch through the shared one-pass lossless-JSON boundary. Live `Session` events are already deep-frozen, but the write coordinator still copies each event into a persistence-owned buffer.
- **Durability.** `append` returns only once the batch is durable.

## The write coordinator

`PersistenceCoordinator` owns per-id state and serialization, one eager write controller per live session, lazy materialization, crash-tail repair, session adoption, and quiescent disposal. A first-party backend composes one, implements the small `PersistenceBackend` storage hook interface, and delegates its stateful methods. JSONL and SQLite therefore share lifecycle correctness while retaining different storage primitives; see the [coordinator Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md) and [flush-controller simplification](../../../.agents/notes/implemented/simplification/2026-07-23-collapse-persistence-flush-state.md).

Each `session/event` copies its event into the session controller and starts an eager drain without blocking the producer. Concurrent notifications share the current drain; events admitted during a write remain pending and trigger the next batch. `session/flush` is an observation barrier that waits until the controller has no current or pending batch. An eager failure is logged and retains the batch; the next explicit flush or backend teardown retries it and surfaces failure to its caller.

Crash repair is cold-only. For a live id, `load(id)` snapshots the authoritative in-memory log, waits for that snapshot to become durable, and returns it with the coordinator's stored header only when balanced; an open live turn rejects instead of receiving synthetic interruption closers. A cold load reserves its id across backend reads and repair writes, so concurrent publication of a same-id live `Session` rejects and rolls back. HMR adoption reads through `loadStored`, applies the coordinator's cwd check, and never closes the active turn.

When a live session emits `session/disposed`, the coordinator waits for its controller, serializes a final drain, then releases state owned by that exact `Session` object. Failed retirement leaves the controller in the live-session map, so backend teardown can retry it. Backend teardown stops event admission first, flushes every remaining controller, awaits per-id operations, and only then closes the storage handle.

The side-effect-free `locate` and lightweight `listSnapshots` queries remain backend-owned because they describe storage topology and revision identity rather than write orchestration.

The `PersistenceBackend<TornMarker>` hooks (the only seam between the coordinator and storage):

| Hook | Role |
|---|---|
| `name` | Backend label for the dispose-failure `AggregateError`. |
| `loadStored(id)` | Read a stored prefix by id across every storage scope. Used by resume/load, non-mutating inspect, live adoption, and the create-collision probe. Returned metadata identifies `id`; an opaque `tornMarker` is present iff a torn tail must be truncated. |
| `appendBatch(meta, events, isMaterialized)` | Durably append a contiguous batch, lazily materializing ATOMICALLY when not yet materialized. |
| `commitRepair(meta, tornMarker, closers)` | Make a crash repair durable: truncate the torn tail (iff `tornMarker !== undefined` — a marker may be falsy, e.g. seq/offset `0`) and append `closers`. NOT required to be atomic. Used by load (truncate + closers) and live-adoption (truncate only). |
| `list()` | List all stored metadata. |
| `close?()` | Optional lifecycle teardown (e.g. close a db handle), awaited after the dispose drain. |

The coordinator asserts the stored id and compares stored/live cwd before repair or live adoption. Its `inspect()` path validates and clones the prefix without calling `commitRepair` or publishing write state. The `tornMarker` is fully OPAQUE: the coordinator only tests `!== undefined` and round-trips it to `commitRepair`, never inspecting its value (the JSONL backend uses the byte offset to truncate to, the SQLite backend the seq to delete from). A third-party backend MAY implement the abstract service directly without the coordinator, but it must provide the same non-mutating inspection and trustworthy lightweight snapshot revisions. See [the write-coordinator Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md).

## Testing backends

Import `runPersistenceContract` from `tests/contract.ts` (the public API, including stable/change-sensitive lightweight revisions) and `runCoordinatorContract` from `tests/coordinator-contract.ts` (the shared write-path orchestration: adoption, HMR, collision, dispose-drain, crash-tail repair) and call each with a fixture for your backend. Every backend is held to the same append-only / contiguous-seq / lazy-materialization / serializability semantics AND the same orchestration, so a backend's own spec is left with only storage-mechanics tests (path sanitization, fsync rollback; schema version, transaction rollback) on top.

Three backends run these suites: an in-memory reference (in `tests/`), `dsh-session-persistence-jsonl` (append-only file log) and `dsh-session-persistence-sqlite` (`node:sqlite`, each `SessionEvent` one row `(session_id, seq, type, time, data, source_event_seqs, surface_op)`). All passing the same contract + coordinator suite is the proof that the seam is genuinely backend-agnostic — lazy materialization, crash-tail-on-load, and contiguous-seq hold identically over file bytes and over a transactional store.

## Metadata and location types

Re-exported from `dsh-session`: `SessionHeader` (immutable session metadata: `version`, `id`, `createdAt`, `cwd?`, `parentSession?`, `seedLength?`, `delegationDepth?`). `SessionLocation` is `{ readonly kind: string; readonly path: string }`; its path is an absolute backend target, not proof that the artifact exists or contains an unflushed turn.

## Model Experience

### Resumed conversation history

#### What the model sees

This seam adds no prompt or schema. Resume restores stored surface events as message history; stored request headers reconstruct earlier calls, while the new loop composes the current system prompt, tools, and session prefix for its next request. Crash repair marks an assistant request without a durable call as `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, whose text lets the model retry read-only or idempotent work but directs it to verify side effects or ask the user instead of retrying blindly.

#### Token effect

Zero tokens during ordinary persistence. Resume restores retained history cost and pays the current request envelope normally; each repaired call adds the quoted retained error text.

#### KV Cache effect

Persistence does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append without rewriting earlier history.

## Known Limitations and Deferred Work

- **No deletion or retention surface** — pruning stored sessions is out-of-band backend maintenance.
- **`list()` is unpaginated and unfiltered** — it returns every stored session's header; fine for local stores, unindexed at scale.
- **Repair-time synthetic closers are the only crash story** — a backend must synthesize `tool/result`/`step/end`/`turn/end` closers on load; there is no partial-turn resume that continues an interrupted turn instead of closing it.
