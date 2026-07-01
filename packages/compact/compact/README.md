# @deepseek-ai/dsh-compact

The **compaction seam**: an abstract `CompactService` (`ctx.compact`) defining WHAT compaction does — decide when history is too large and summarize an older range into a single surface node — without saying HOW.

This package is the interface tier of the compaction capability, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-compact` (this) | the interface: abstract service + `compact/*` events + `CompactionResult` |
| `@deepseek-ai/dsh-compact-basic` (deferred) | a backend: char/4 estimation + token-budget retention + `llm.stream()` summarization |
| `@deepseek-ai/dsh-tool-compact` (deferred) | the model-facing `/compact` tool over `ctx.compact` |

Unlike the bash seam, this interface depends on `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-llm` — the contract's verbs are defined over a `Session` and its output is the `ContentBlock` vocabulary, so they cannot be expressed without naming those packages. That deviation from the "interface depends only on cordis" guidance is intentional and recorded in the [compaction capability-seam RFC](../../../docs/rfc/proposed/feature/2026-06-18-compaction-capability-seam.md).

## Service API (`ctx.compact`)

Both methods are **abstract** — the backend owns the entire strategy (token estimation, retention policy, event sequencing, summarization).

| Member | Semantics |
|---|---|
| `compactIfNeeded(session, systemPrompt?, model?, signal?)` | Estimate the history size; if over the backend's threshold, compact an older range via `compactRegion`, keeping recent context intact. Returns the `CompactionResult`, or `null` if nothing needed compacting. |
| `compactRegion(session, start, end, model, signal?)` | Forcibly summarize surface nodes `[start, end]` (inclusive seqs) into a single replacement node. **Throws** if a compaction is already in progress, if `start`/`end` aren't surface nodes, or if `start > end`. |

Both methods take an optional `signal: AbortSignal`. A backend that summarizes via `ctx.llm.stream()` **must** forward it into the call's `GenerateOptions.signal`, so an abort or fiber dispose tears down the in-flight summarization instead of leaving an orphaned model call running past the cancellation. The turn that the `compact/*` events belong to is not a parameter — it is recoverable from the log (the currently-open turn), so the backend stamps it without the caller supplying it.

## Surface contract

`SurfaceEventType` is a closed union — only `user/message`, `assistant/message`, `tool/result`, `context/message`, and `steering/message` may carry `surfaceOp`. A `compact/*` event therefore **cannot** appear on the surface. A successful compaction instead:

1. appends `compact/start` (log-only) — acquires the lock,
2. summarizes the range,
3. appends `compact/summary` (log-only) — provenance: summary, range, shadowed seqs, token count,
4. appends a single `user/message` with `surfaceOp: { op: 'replace', start, end }` carrying the summary — **the only surface mutation**,
5. appends `compact/end` (log-only) — releases the lock.

The surface mutation (step 4) sits **inside** the lock bracket: `compact/end` is the last event, so the lock is never released before the mutation lands. A crash between `compact/start` and `compact/end` therefore leaves a detectable orphaned lock (a `compact/start` with no matching `compact/end`) rather than a `compact/end` that falsely claims compaction finished while the surface was never shadowed.

`deriveMessages()` then renders the summary as a user-role message followed by the retained nodes. The shadowed events remain in the raw log, so replay is deterministic.

## Blocking

Compaction is serialized via a log-recorded lock: `compactRegion` refuses to start if the last `compact/start` has no matching `compact/end` after it. The lock is the log (not an in-memory mutex), so it survives replay and a persistence backend can detect an orphaned `compact/start` on reload. The lock brackets the **whole** operation — summarization, the `compact/summary` provenance record, *and* the `user/message` surface replacement all happen before `compact/end` — so a `session/event` listener firing on `compact/end` never observes the lock free while the surface mutation is still pending. `compact/end` is appended even when summarization throws, so a failure can never wedge the lock.

## Events

The `compact/*` events extend `SessionEventMap` (merge-extensible) via declaration merging — they are session events, not cordis `Events`:

| Event | Payload | On surface? |
|---|---|---|
| `compact/start` | `{ turn }` | no (log-only) |
| `compact/summary` | `{ summary, shadowedRange, shadowedSeqs, shadowedTokenCount }` | no (log-only) |
| `compact/end` | `{ turn, error? }` | no (log-only) |

## Implementing a backend

Subclass `CompactService`, implement `compactIfNeeded` and `compactRegion`, and load the subclass as a plugin — it registers as `ctx.compact`. A tokenizer-, template-, or model-backed implementation can live as a sibling package without changing callers.
