# RFC: Compaction as a capability seam (abstract contract + basic backend)

Status: proposed (2026-06-18)

## Context

A long-running agent conversation grows without bound. As the event log accumulates turns, the derived message history eventually approaches the model's context window — the model then truncates mid-response (`max-tokens`) or degrades. **Compaction** is the mitigation: replace a run of older history with a concise summary, keeping recent context intact.

The [session surface](../../implemented/architecture/2026-06-18-session-surface.md) was built as the foundation for exactly this — a linked list over the event log with a `surfaceOp: { op: 'replace', start, end }` operation purpose-built to shadow a range of nodes and insert a replacement, with `sourceEventSeqs` recording provenance so the decision replays deterministically. What remained was the plugin that *decides what to compact and produces the summary*.

Two forces shape the design. First, compaction is **swappable**: token counting can be a char/4 heuristic or a real tokenizer, and summarization can be a model call, a template, or a remote service — these vary independently of *when* and *which range* to compact. Second, a later commit (`ce43c25`) closed `SurfaceEventType` to five event types (`user/message`, `assistant/message`, `tool/result`, `context/message`, `steering/message`); only those may carry `surfaceOp`. A bespoke `compaction/*` event therefore **cannot** itself appear on the surface — the compiler rejects `surfaceOp` on it and the invariants plugin rejects it at runtime.

## Decision

### Compaction is a capability seam, split interface / implementation

Per the [capability-seams RFC](../../implemented/architecture/2026-06-13-capability-seams.md), compaction ships as separate packages so the contract, the algorithm, and (later) the consumer surface evolve independently:

1. **Interface** — `@deepseek-ai/dsh-compact`: an abstract `CompactService` owning the `ctx.compact` key, the `CompactionResult` vocabulary, and the `compact/*` session events. It declares `compactIfNeeded()` and `compactRegion()` as **abstract** — the contract states *what* compaction does, not *how*.
2. **Implementation** — `@deepseek-ai/dsh-compact-basic`: a concrete `BasicCompactService` that owns the entire algorithm — token estimation (char/4 + per-block overhead), the tail→head retention walk, summarization via `ctx.llm.generate()`, the surface replacement, the lock, and the `agent/request` auto-compaction listener. A tokenizer-based or template-based backend is a sibling package (or a subclass overriding the two protected estimation/summarization hooks).
3. **Consumer** — deferred. A `/compact` tool and slash command will `inject: ['compact']` and call the contract; they are intentionally out of scope here so the seam settles first.

### The contract depends on `dsh-session` and `dsh-llm` — a deliberate deviation

The capability-seams RFC states the interface package "depends only on cordis" (true of `dsh-bash`, whose vocabulary is self-contained). Compaction **cannot** honor that: its verbs are defined *over* a `Session` (`compactRegion(session, start, end)`) and its output *is* the content vocabulary (`CompactionResult.summary: ContentBlock[]`). There is no way to express the contract without naming `Session`/`SessionEvent` (from `dsh-session`) and `ContentBlock` (from `dsh-llm`).

This is not a coupling smell — it is the contract's domain. The "only cordis" guidance was always shorthand for "the interface depends only on what the contract genuinely names, and never on an implementation." `dsh-session` and `dsh-llm` are themselves interface/vocabulary packages, not implementations; `dsh-compact` still imports no backend. The seam's real invariant — *consumers and implementations evolve independently behind an abstract service* — holds intact. We record the deviation here so a future reader doesn't mistake it for an accident or "fix" it by smuggling `Session` behind an opaque handle.

### Abstract `compactIfNeeded` / `compactRegion`, algorithm in the backend

An earlier draft put the full algorithm (the retention walk, token-summing, text extraction) as concrete methods on the interface, with only `estimateContentTokens()` and `summarize()` abstract. That recouples the contract to one strategy: a backend that wants a different retention policy (e.g. turn-count instead of token-budget) or a different event-sequencing would have to fight inherited concrete code. Making both core methods abstract puts every *how* decision in the backend, where it belongs, and keeps the interface a pure statement of *what*. The backend remains internally factored — `estimateContentTokens()` and `summarize()` are `protected` hooks a sub-backend can override without reimplementing the walk — but that factoring is the backend's private concern, not the contract's.

### Surface replacement: `compact/*` events are log-only; one `user/message` carries the summary

Because `SurfaceEventType` is closed, the summary cannot ride on a `compact/*` event. The backend instead appends a **single `user/message`** with `surfaceOp: { op: 'replace', start, end }` whose `content` is the summary `ContentBlock[]` and whose `sourceEventSeqs` covers the shadowed nodes *and* the bookkeeping events. The `compact/*` events are pure log records (lock + provenance), never on the surface. The surface mutation sits **inside** the lock — `compact/end` is the last event appended:

```
compact/start    → log-only. Acquires the lock.
[summarize older range via the backend]
compact/summary  → log-only. Provenance: summary, range, shadowed seqs, token count.
user/message     → surfaceOp { op:'replace', start, end }. THE surface mutation.
                   deriveMessages() renders it as a user-role message.
compact/end      → log-only. Releases the lock.
```

Ordering the surface mutation **before** `compact/end` is deliberate: `session.append()` commits one event at a time, so there is no multi-event transaction to make the sequence atomic. Releasing the lock last converts the crash window from *silent corruption* (a `compact/end` that claims compaction finished while the surface was never shadowed) into a *detectable orphaned lock* (a `compact/start` with no matching `compact/end`), which a persistence backend already detects on reload. A `session/event` listener on `compact/end` likewise never sees the lock free before the replacement has landed.

`deriveMessages()` then yields `[summary_as_user_message, ...retained_nodes]`. An alternative — extending `SurfaceEventType` to admit a `compact/*` type — was rejected: the closed union is a deliberate safety boundary (only message-producing events reach the model), and a summary genuinely *is* user-role context, so reusing `user/message` is honest rather than a workaround.

### Blocking via a log-recorded lock, not a mutex

Compaction must be serialized: no second compaction starts before the first finishes, and no ordinary events interleave the slow summarization. Rather than an in-memory mutex (invisible to replay, lost on crash), the lock **is** the log: `compactRegion` refuses to start if the last `compact/start` has no matching `compact/end` after it. `compact/start` is appended first (fast, synchronous), the slow model call runs, then the `compact/summary` and `user/message` replacement land, and only then is `compact/end` appended — in a `catch` that records the error, so a failed summarization can never wedge the lock. Because the backend runs compaction synchronously inside the `agent/request` waterfall, the loop is single-threaded for that window; the lock additionally gives observability and lets a persistence backend detect an orphaned `compact/start` on reload.

## Consequences

- **New packages**: `packages/compact/compact` (interface) and a sibling `compact-basic` (backend) under `packages/compact/`, wired into the three root tsconfigs. The consumer tier is deferred.
- **`SessionEventMap`** gains `compact/start` / `compact/summary` / `compact/end` by declaration merging (merge-extensible); `SurfaceEventType` is **not** touched. These are session events, not cordis `Events`, so the event-taxonomy gate needs no entry.
- **No changes** to `dsh-session`, `dsh-invariants`, or `dsh-agent-loop`: the surface replace op, the surface-metadata runtime guard, and the `agent/request` waterfall all already exist. Compaction is a pure plugin on documented seams.
- The capability-seams convention gains a second reference beyond bash, and a documented case where "interface depends only on cordis" relaxes to "depends only on interface/vocabulary packages the contract genuinely names." On acceptance, [AGENTS.md](../../../../AGENTS.md) § Conventions and [architecture.md](../../../architecture.md) § "Capability seams" should note this relaxation.
