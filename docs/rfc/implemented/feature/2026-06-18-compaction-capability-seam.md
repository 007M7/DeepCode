# RFC: Compaction as a capability seam (abstract contract + basic backend)

Status: implemented

## Problem

A long-running agent conversation grows without bound. As the event log accumulates turns, the derived message history eventually approaches the model's context window — the model then truncates mid-response (`max-tokens`) or degrades. **Compaction** is the mitigation: replace a run of older history with a concise summary, keeping recent context intact.

The [session surface](../../implemented/architecture/2026-06-18-session-surface.md) was built as the foundation for exactly this — an ordered projection over the event log with a `surfaceOp: { op: 'replace', start, end }` operation purpose-built to shadow a range of entries and insert a replacement, with `sourceEventSeqs` recording provenance so the decision replays deterministically. What remained was the plugin that *decides what to compact and produces the summary*.

Two forces shape the design. First, compaction policy and reusable token measurement vary independently: measurement belongs to the LLM-family [`ctx.tokenMeter` service](../../implemented/architecture/2026-07-15-replay-token-meter-service.md), while summarization can be a model call, a template, or a remote service. Second, `SurfaceEventType` is closed to five event types (`user/message`, `assistant/message`, `tool/result`, `context/message`, `steering/message`); only those may carry `surfaceOp`. A bespoke `compaction/*` event therefore **cannot** itself appear on the surface — the compiler rejects `surfaceOp` on it and the invariants plugin rejects it at runtime.

## Decision

### Compaction is a capability seam, split interface / implementation

Per the [capability-seams RFC](../../implemented/architecture/2026-06-13-capability-seams.md), compaction ships as separate packages so the contract, the algorithm, and (later) the consumer surface evolve independently:

1. **Interface** — `@deepseek-ai/dsh-compact`: an abstract `CompactService` owning the `ctx.compact` key, the `CompactionResult` vocabulary, and the `compact/*` session events. It declares `compactIfNeeded()` and `compactRegion()` as **abstract** — the contract states *what* compaction does, not *how*.
2. **Implementation** — `@deepseek-ai/dsh-compact-basic`: a concrete `BasicCompactService` that consumes `ctx.tokenMeter` and owns the tail→head retention walk, summarization via `ctx.llm.stream()`, the surface replacement, the lock, and the `agent/pre-step` auto-compaction listener. `summarize()` is its sole subclass hook; pricing and replay stay with the meter.
3. **Consumer** — deferred. A `/compact` tool and slash command will `inject: ['compact']` and call the contract; they are intentionally out of scope here so the seam settles first.

### The contract depends on `dsh-session` and `dsh-llm` — a deliberate deviation

The capability-seams RFC states the interface package "depends only on cordis" (true of `dsh-bash`, whose vocabulary is self-contained). Compaction **cannot** honor that: its verbs are defined *over* a `Session` (`compactRegion(session, start, end)`) and its output *is* the content vocabulary (`CompactionResult.summary: ContentBlock[]`). There is no way to express the contract without naming `Session`/`SessionEvent` (from `dsh-session`) and `ContentBlock` (from `dsh-llm`).

This is not a coupling smell — it is the contract's domain. The "only cordis" guidance was always shorthand for "the interface depends only on what the contract genuinely names, and never on an implementation." `dsh-session` and `dsh-llm` are themselves interface/vocabulary packages, not implementations; `dsh-compact` still imports no backend. The seam's real invariant — *consumers and implementations evolve independently behind an abstract service* — holds intact.

### Abstract `compactIfNeeded` / `compactRegion`, algorithm in the backend

An earlier draft put the full algorithm (the retention walk, token-summing, text extraction) as concrete methods on the interface. That recouples the contract to one strategy: a backend that wants a different retention policy or event sequence would have to fight inherited concrete code. Making both core methods abstract puts every *how* decision in the backend and keeps the interface a statement of *what*. Token measurement is not a compaction hook at all; the singleton service lets multiple consumers share one per-session replay fold.

`compactIfNeeded(agent, fullSystemPrompt, sessionPrefix, signal)` takes required pressure inputs and cancellation. The session comes from the agent. `compactRegion(session, start, end, agent, signal?)` keeps an optional signal for manual callers and requires `session === agent.session`; implementations reject mismatch before model resolution, lock acquisition, summarization, or log mutation. The pre-step integration resolves a provisional model from the latest logged request header, then `AgentOptions.model`; a model-less router-only first step skips pressure because `agent/request` can route later. The default summarizer resolves its model from explicit config, the latest logged routed model, then agent options.

### Auto-compaction runs on `agent/pre-step`, a dedicated surface-mutation seam

Compaction mutates the session surface, so it runs before the step opens and before messages are derived. `agent/request` remains a call-config transform and never needs to rebuild history after a surface change.

The fix is a dedicated loop seam, **`agent/pre-step`** (`@mode serial`), fired by the loop *after* system assembly and *before* the step opens (`step/start`):

```
assembly = ctx.systemPrompt.assemble()
await ctx.serial('agent/pre-step', agent, turn, step, system, prefix, signal)  ⟵ compaction mutates the surface here
session('step/start')                 ⟵ the step opens AFTER the seam
messages = session.deriveMessages()   ⟵ single derive, reflects the compaction
request  = waterfall agent/request    ⟵ pure request transform (hooks, model switch)
```

The loop derives messages once after `agent/pre-step`. Running before `step/start` keeps compaction records outside any half-open step, simplifying crash repair. The seam is awaited and serial so surface mutations cannot interleave; listeners return `void` and do not use Cordis bail values as vetoes.

### Retention is turn-agnostic; tool-pairing balance is the only structural guard

Auto-compaction fires before **every** step, not once per turn. This is **load-bearing for runaway-turn survival**: a tool-heavy ReAct turn appends an `assistant/message` + a `tool/result` per step, so the surface grows *within* a turn. A single turn can grow past the window on its own (a "runaway turn") — and the only moment to rescue it before the next model call overflows is the next step's `pre-step` checkpoint. Gating compaction to a turn's first step (or, worse, retaining the whole in-flight turn verbatim) re-opens exactly the hole compaction exists to close: the harness would die when compaction is most needed.

`compactIfNeeded` retains the smallest tail of whole surface units whose estimated size reaches `retainTokens` and compacts older nodes. A unit is a complete closed step or one no-step message. If the token cutoff lands inside a step, retention expands until the cut is tool-pairing balanced. Balance is checked on surface order, not log sequence, because replacement summaries have new sequence numbers at old surface positions. `dsh-compact` exports the before/after edge helpers; their per-session cache folds only appended surface-tail nodes while `replaceGeneration` is unchanged, does no event reads for log-only growth, and rebuilds current membership and balances after replacement. `compactRegion` rejects boundaries that split a tool call from its result. The in-flight turn receives no special retention.

A runaway turn thus compacts exactly like any other history: its early *closed* steps get summarized while its recent steps stay verbatim. When the only compactable content left is an un-splittable open tail step (its tool-calls have no results yet), compaction declines (`null`) and retries once that step closes.

**Single-unit overflow is out of scope, by design.** If a single retained unit — one closed step, or a large free entry such as a pasted `user/message` — *alone* exceeds the budget, compaction cannot help and the next model call may go out over-budget. Bounding an individual unit's size is a separate concern (output truncation), handled elsewhere; compaction makes no promise about it, and the harness without such a mechanism can still break on a single oversized unit. This is named honestly rather than papered over.

### Head-anchoring: one auto checkpoint, always at the head

Auto-compaction always starts at the surface head, merging the prior checkpoint with newly compacted history so only one automatic checkpoint remains. `shadowedRange` is therefore positional rather than a numeric sequence interval: a newer summary sequence may occupy an older surface position. `shadowedSeqs` records the authoritative surface order. Manual mid-range compaction may leave multiple checkpoints.

### Approximate convergence invariant

`resolveConfig` supplies usable defaults: threshold ratio `0.8`, retained tail `floor(contextWindow × 0.16)`, empty summarization-model override, `maxTokens: 8192`, `compactionRetries: 1`, and `auto: true`. Optional top-level `thresholdRatio` and `retainTokens` override the policy for the token meter's single context window; retention must remain below the resulting threshold. Convergence remains dynamic because provider output caps can be spent on hidden or surfaced reasoning tokens and summary size is unpredictable. If the compacted surface remains over threshold, `compactIfNeeded()` re-compacts the head checkpoint up to the configured retry count, but each committed summary must be smaller than what it shadows.

### Surface replacement: `compact/*` events are log-only; one `user/message` carries the summary

Because `SurfaceEventType` is closed, the summary cannot ride on a `compact/*` event. The backend instead appends a **single `user/message`** with `surfaceOp: { op: 'replace', start, end }` whose `content` is the (framed) summary and whose `sourceEventSeqs` covers the shadowed entries *and* the bookkeeping events. The `compact/*` events are pure log records (lock + provenance). The surface mutation sits **inside** the lock — `compact/end` is the last event appended:

```
compact/start    → log-only. Acquires the lock.
[summarize older range via the backend]
compact/summary  → log-only. Provenance: raw summary, range, shadowed seqs, token count.
user/message     → surfaceOp { op:'replace', start, end }. THE surface mutation (framed summary).
                   deriveMessages() renders it as a user-role message.
compact/end      → log-only. Releases the lock (carries `error` on a recoverable failure).
```

`deriveMessages()` then yields `[summary_as_user_message, ...retained_entries]`. Reusing `user/message` is honest rather than a workaround: a summary genuinely *is* user-role context.

### Checkpoint framing + incremental merge (backend-private)

The basic backend wraps the summary as established checkpoint context and tags it for incremental merging on the next cycle. The raw summary remains on `compact/summary`. Framing is backend policy; the seam promises only that one replacement user message carries the possibly framed summary.

### Blocking via a log-recorded lock, plus a crash/recoverable failure taxonomy

The `compact/start … compact/end` bracket is justified, in order of what now does the work:

1. **Crash-detectable orphan + provenance** (primary). Summarization is a slow model call persisted *after* `compact/start`. A crash mid-summarization leaves a `compact/start` with no matching `compact/end` — a detectable orphan. Releasing the lock last (rather than first) converts the crash window from *silent corruption* into that detectable orphan.
2. **Prevents concurrent compaction.** `compactRegion` refuses to start if the current turn holds an unmatched `compact/start`. (The loop is single-threaded across the awaited `pre-step`, so this is also a re-entry tripwire — a thrown "already in progress" signals a real bug.)

Two failure paths, both documented:

- **Crash** (the loop dies mid-summarization): a dangling `compact/start`, no closer. Because `compact/*` are **log-only**, the orphan is **inert** — the surface replacement never landed, so the full, uncompacted history derives correctly. Generic turn-repair (`interruptedTurnClosers`) closes the turn with a synthetic `turn/end`; the orphan sits *before* that `turn/end`, so the turn-scoped in-progress check never sees it and a crash can't wedge future compaction. Compaction simply re-attempts at the next `pre-step`.
- **Recoverable** (summarization throws but the loop survives): the backend appends `compact/end` with its **`error`** field set, leaving the surface untouched, and the model call proceeds with full history.

`compact/end` keeps its `error?` field (mirroring `tool/result`'s self-contained error — one event tells success from failure without correlating a sibling). There is no separate `compact/error` event.

**Core session repair stays compaction-agnostic — deliberately.** `interruptedTurnClosers` is never taught about `compact/*`. Teaching it would force every future `xxx/start … xxx/end` plugin pair to patch a core module — exactly the coupling the capability-seam architecture exists to avoid. Because the log-only orphan is inert, no special repair is needed: generic turn-repair plus the inertness of an un-landed surface mutation is sufficient.

## Alternatives considered

- **The full algorithm as concrete interface methods** — rejected because it recouples the contract to one retention strategy. Both core methods are abstract; reusable measurement is a separate LLM-family service and `summarize()` is basic's sole hook.
- **Compaction on the `agent/request` waterfall** — the earlier cut; rejected for the double-derive it forced and for handing the listener context it structurally cannot compact. The dedicated `agent/pre-step` seam makes the layering correct by construction.
- **A separate `compact/error` event** — rejected: `compact/end` keeps an `error?` field, mirroring `tool/result`'s self-contained error — one event tells success from failure without correlating a sibling.
- **Teaching core turn-repair about `compact/*`** — rejected: the log-only orphan is inert, and a core module patched for every future `xxx/start … xxx/end` plugin pair is exactly the coupling the capability-seam architecture exists to avoid.

## Consequences

- **Packages**: `packages/compact/compact` supplies the interface and `compact-basic` supplies the backend. `packages/llm/token-meter` owns replay-aware measurement independently. The consumer tier is deferred.
- **New loop seam**: `agent/pre-step` (`@mode serial`) declared in `dsh-agent` and emitted by `dsh-agent-loop` after system assembly and before `step/start`. This is a documented change to the loop — `docs/architecture.md` records it and the generated cordis catalog carries its signature.
- **`SessionEventMap`** gains `compact/start` / `compact/summary` / `compact/end` by declaration merging (merge-extensible); `SurfaceEventType` is **not** touched. These are session events, not cordis `Events`, so the event-taxonomy gate needs no entry.
- **`dsh-compact`** owns `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)`, the cached surface-edge checks that `compactRegion` and `compactIfNeeded` use to avoid splitting a tool-call/result pair. The cache validates current membership by seq and answers both edges from one per-cut balance sequence; stale or missing seqs and orphan results reject. `dsh-session` continues to own the surface `replace` operation, ordered event sequences, and rewrite generation.
- **`dsh-invariants`** drops its `surface replace: start must be <= end` assertion: a head-anchored compaction lands a high-seq replacement entry at an older range's *position*, so `start > end` numerically is normal and valid (the range is positional, validated by the surface's `indexOf` checks that remain). The turn-enclosure invariant is reused unchanged.
- **Wiring**: `examples/coding-agent/cordis.yml` loads zero-config `dsh-token-meter` before `dsh-compact-basic`; the service-wide window and compact defaults make the pair usable without repeated numeric policy.

## Testing

- **Unit:** Real Loader and invariant plugins cover whole-unit retention, convergence failure, both `compact/end` outcomes, head anchoring, open-tail refusal, inert crash orphans, and compacting closed steps inside one oversized open turn.
- **Loop:** Tests pin one awaited `agent/pre-step` per step between `turn/start` and `step/start`; a surface mutation there lands outside the step and appears in the single derived request.
- **With-key e2e:** A real model and bash session with lowered limits triggers compaction, records a complete `compact/start…end` pair, shrinks the surface, and finishes the task.
- **Snapshot gap:** Runaway-turn compaction cannot yet replay because the summarization call records no `assistant/chunk` events or `sessionId`; interleaved summarization-call replay remains follow-up work.
