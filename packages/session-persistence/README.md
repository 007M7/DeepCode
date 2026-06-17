# @deepseek-ai/dsh-session-persistence

The abstract durable session-persistence seam (`ctx.sessionPersistence`). Defines WHAT a persistence backend does — durably store, reload, list, and update sessions — without saying HOW. Mirrors the `dsh-bash` capability-seam template ([ADR 0009](../../docs/adr/0009-capability-seams.md)): an abstract service here, a concrete implementation in a sibling package, consumers that inject the interface.

The persisted unit IS the existing `SessionEvent` (event-sourced model — the log is the single source of truth), so there is no parallel "persisted message" type. Metadata that is NOT replayable conversation state (format version, cwd, lineage) travels separately as `SessionMeta`, owned by `dsh-session` and re-exported here.

## Service API (`ctx.sessionPersistence`)

| Method | Contract |
|---|---|
| `create(meta): Promise<void>` | Register a new session's metadata. MAY defer the physical write until the first `append` (lazy materialization). |
| `append(id, events): Promise<void>` | Durably persist a batch (from the `session/flush` drain). Append-only; first event `seq` == stored next-seq after any repair; rejects non-JSON-serializable data naming the offending type. |
| `load(id): Promise<{ meta; events }>` | Reload meta + log. Preserves an interrupted (unclosed) final turn and closes it with synthetic closers — an error `tool/result` per unanswered `tool-call`, then `step/end?`+`turn/end {interrupted}` (a turn can be huge — never truncated); only a torn tail fragment is dropped. Events contiguous (`events[i].seq === i`); rejects a committed-region gap/parse error or unknown `version`. |
| `list(): Promise<SessionMeta[]>` | Lightweight listing from metadata, no full-log parse. |
| `has(id)` / `delete(id)` | Existence / removal. A zero-event lazily-materialized session is absent from `has`/`list`. |
| `update(id, summary): Promise<void>` | Update mutable `SessionSummary` fields without touching the append-only log. |

## Invariants every backend must honor

- **Append-only; a crashed turn is closed, not truncated.** Committed events (at or below a flushed `turn/end`) are never rewritten. A crash can leave an unclosed final turn whose events are real and possibly large; `load` preserves them and durably appends synthetic closers (an error `tool/result` per unanswered `tool-call`, then `step/end?`+`turn/end {interrupted}`) to balance the log and keep the rehydrated history a valid provider transcript. Only a never-fully-written torn tail fragment is discarded.
- **Contiguous seq.** `load` rejects a `seq` gap/parse error in the MIDDLE of the log; `append`'s first `seq` must equal the stored next-seq.
- **JSON-serializable data.** `append` rejects non-serializable `event.data`; backends snapshot each event when buffering (the live `session.events` object is mutable).
- **Durability.** `append` returns only once the batch is durable.

## Testing backends

Import `runPersistenceContract` from `tests/contract.ts` and call it with a factory that yields a fresh, empty backend plus a teardown. Every backend is held to the same append-only / contiguous-seq / lazy-materialization / serializability semantics; a backend's own spec adds implementation-specific tests (crash repair, path sanitization) on top.

> **TODO (validate the abstraction with a second backend):** `dsh-session-persistence-jsonl` is currently the only implementation, so the interface and `runPersistenceContract` are only proven against one storage model. A second backend — a SQLite implementation (`dsh-session-persistence-sqlite`), where each `SessionEvent` maps 1:1 onto a row `(session_id, seq, type, time, data)` — would run the SAME `runPersistenceContract` suite and so prove the seam is genuinely backend-agnostic (lazy materialization, crash-tail-on-load, contiguous-seq all expressed against a transactional store rather than an append-only file).

## Metadata types

Re-exported from `dsh-session`: `SessionHeader` (immutable: `version`, `id`, `createdAt`, `cwd?`, `parentSession?`), `SessionSummary` (mutable: `updatedAt`, `title?`, `firstPrompt?`), `SessionMeta` (their intersection).
