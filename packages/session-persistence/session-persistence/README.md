# @deepseek-ai/dsh-session-persistence

The abstract durable session-persistence seam (`ctx.sessionPersistence`). Defines WHAT a persistence backend does — durably store, reload, and list sessions — without saying HOW. Mirrors the `dsh-bash` capability-seam template ([capability seams](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)): an abstract service here, a concrete implementation in a sibling package, consumers that inject the interface.

The persisted unit IS the existing `SessionEvent` (event-sourced model — the log is the single source of truth), so there is no parallel "persisted message" type. Metadata that is NOT replayable conversation state (format version, cwd, lineage, seed boundary) travels separately as `SessionHeader`, owned by `dsh-session` and re-exported here.

## Service API (`ctx.sessionPersistence`)

| Method | Contract |
|---|---|
| `create(meta): Promise<void>` | Register a new session's metadata. MAY defer the physical write until the first `append` (lazy materialization). |
| `append(id, events): Promise<void>` | Durably persist a batch (from the `session/flush` drain). Append-only; first event `seq` == stored next-seq after any repair; rejects non-JSON-serializable data naming the offending type. |
| `load(id): Promise<{ meta; events }>` | Reload meta + log. Preserves an interrupted (unclosed) final turn and closes it with synthetic closers — an error `tool/result` per unanswered `tool-call`, then `step/end?`+`turn/end {interrupted}` (a turn can be huge — never truncated); only a torn tail fragment is dropped. Events contiguous (`events[i].seq === i`); rejects a committed-region gap/parse error or unknown `version`. |
| `list(): Promise<SessionHeader[]>` | Lightweight listing from metadata, no full-log parse. A zero-event lazily-materialized session is absent from `list`. |

## Invariants every backend must honor

- **Append-only; a crashed turn is closed, not truncated.** Committed events (at or below a flushed `turn/end`) are never rewritten. A crash can leave an unclosed final turn whose events are real and possibly large; `load` preserves them and durably appends synthetic closers (an error `tool/result` per unanswered `tool-call`, then `step/end?`+`turn/end {interrupted}`) to balance the log and keep the rehydrated history a valid provider transcript. Only a never-fully-written torn tail fragment is discarded.
- **Contiguous seq.** `load` rejects a `seq` gap/parse error in the MIDDLE of the log; `append`'s first `seq` must equal the stored next-seq.
- **JSON-serializable data.** `append` materializes each direct/replay batch through the shared one-pass lossless-JSON boundary. Live `Session` events are already deep-frozen, but the write coordinator still copies each event into a persistence-owned buffer.
- **Durability.** `append` returns only once the batch is durable.

## The write coordinator

`PersistenceCoordinator` owns per-id state, write-behind buffers and serialization, the `session/event` → `session/flush` drain, lazy materialization, crash-tail repair, session adoption, and quiescent disposal. A first-party backend composes one, implements the small `PersistenceBackend` storage hook interface, and delegates its four public service methods. JSONL and SQLite therefore share lifecycle correctness while retaining different storage primitives; see the [coordinator RFC](../../../docs/rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md).

The `PersistenceBackend<TornMarker>` hooks (the only seam between the coordinator and storage):

| Hook | Role |
|---|---|
| `name` | Backend label for the dispose-failure `AggregateError`. |
| `loadStored(id)` | Read a stored prefix by id, scanning ANY storage scope. Used by resume/load and, via `!== undefined`, the create-collision probe. Returns an opaque `tornMarker` iff a torn tail must be truncated. |
| `loadLive(id, cwd)` | Read a stored prefix SCOPED to `cwd` (HMR live-adoption must only adopt a log at the SAME cwd; a same-id log elsewhere is a collision, not a resume). A globally-unique-id backend ignores `cwd`. |
| `appendBatch(meta, events, isMaterialized)` | Durably append a contiguous batch, lazily materializing ATOMICALLY when not yet materialized. |
| `commitRepair(meta, tornMarker, closers)` | Make a crash repair durable: truncate the torn tail (iff `tornMarker !== undefined` — a marker may be falsy, e.g. seq/offset `0`) and append `closers`. NOT required to be atomic. Used by load (truncate + closers) and live-adoption (truncate only). |
| `list()` | List all stored metadata. |
| `close?()` | Optional lifecycle teardown (e.g. close a db handle), awaited after the dispose drain. |

The `tornMarker` is fully OPAQUE: the coordinator only tests `!== undefined` and round-trips it to `commitRepair`, never inspecting its value (the JSONL backend uses the byte offset to truncate to, the SQLite backend the seq to delete from). The public `SessionPersistence` service shape is unchanged, so a third-party backend MAY still implement the abstract service directly without the coordinator. See [the write-coordinator RFC](../../../docs/rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md).

## Testing backends

Import `runPersistenceContract` from `tests/contract.ts` (the public-API contract) and `runCoordinatorContract` from `tests/coordinator-contract.ts` (the shared write-path orchestration: adoption, HMR, collision, dispose-drain, crash-tail repair) and call each with a fixture for your backend. Every backend is held to the same append-only / contiguous-seq / lazy-materialization / serializability semantics AND the same orchestration, so a backend's own spec is left with only storage-mechanics tests (path sanitization, fsync rollback; schema version, transaction rollback) on top.

Three backends run these suites: an in-memory reference (in `tests/`), `dsh-session-persistence-jsonl` (append-only file log) and `dsh-session-persistence-sqlite` (`node:sqlite`, each `SessionEvent` one row `(session_id, seq, type, time, data, source_event_seqs, surface_op)`). All passing the same contract + coordinator suite is the proof that the seam is genuinely backend-agnostic — lazy materialization, crash-tail-on-load, and contiguous-seq hold identically over file bytes and over a transactional store.

## Metadata types

Re-exported from `dsh-session`: `SessionHeader` (immutable session metadata: `version`, `id`, `createdAt`, `cwd?`, `parentSession?`, `seedLength?`).

## Model Experience

### Resumed conversation history

**What the model sees**: This seam adds no prompt or schema. Resume restores stored surface events as message history; stored request headers reconstruct earlier calls, while the new loop composes the current system prompt, tools, and session prefix for its next request. Crash repair inserts exactly `Tool call interrupted by a crash; no result was recorded.` as the error result for each unanswered tool call.

**Token effect**: Zero tokens during ordinary persistence. Resume restores retained history cost and pays the current request envelope normally; each repaired call adds the quoted retained error text.

## Known Limitations and Deferred Work

- **No deletion or retention surface** — the seam is `create`/`append`/`load`/`list` only; pruning stored sessions is out-of-band backend maintenance.
- **`list()` is unpaginated and unfiltered** — it returns every stored session's header; fine for local stores, unindexed at scale.
- **Repair-time synthetic closers are the only crash story** — a backend must synthesize `tool/result`/`step/end`/`turn/end` closers on load; there is no partial-turn resume that continues an interrupted turn instead of closing it.
