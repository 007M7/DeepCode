# @deepseek-ai/dsh-compact

The **compaction seam**: an abstract `CompactService` (`ctx.compact`) defining WHAT compaction does — decide when history is too large and summarize an older range into a single surface node — without saying HOW.

This package is the interface tier of the compaction capability, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-compact` (this) | the interface: abstract service + `compact/*` events + `CompactionResult` + tool-pairing boundary helpers + the shared transcript renderer (`renderTranscript`/`renderContentBlocks`) |
| `@deepseek-ai/dsh-compact-basic` | a backend: `ctx.tokenMeter` pressure + token-budget retention + `llm.stream()` summarization |
| `@deepseek-ai/dsh-tool-compact` (deferred) | the model-facing `/compact` tool over `ctx.compact` |

Unlike the bash seam, this interface depends on `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-llm` — the contract's verbs are defined over a `Session` and its output is the `ContentBlock` vocabulary, so they cannot be expressed without naming those packages. That deviation from the "interface depends only on cordis" guidance is intentional and recorded in the [compaction capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).

## Service API (`ctx.compact`)

Both methods are **abstract** — the backend owns trigger policy, retention, event sequencing, and summarization. Reusable request measurement is a separate service, [`ctx.tokenMeter`](../../llm/token-meter/README.md), rather than part of this interface.

| Member | Semantics |
|---|---|
| `compactIfNeeded(agent, trigger, signal)` | Consider automatic compaction for `trigger: 'pressure' \| 'context-overflow'`. A pressure trigger may apply the backend's threshold and retained-tail policy; a confirmed overflow may force a useful balanced reduction. Returns the `CompactionResult`, or `null` when no safe range exists. A backend's summarization request is a direct `ctx.llm.stream()` call (not a loop step), so per-call interception happens at `llm/stream`. |
| `compactRegion(start, end, agent, signal?)` | Forcibly summarize surface nodes `[start, end]` (inclusive seqs) from `agent.session` into a single replacement node. **Throws** if a compaction is already in progress, if `start`/`end` aren't surface nodes, or if `start` is positioned after `end` on the surface. The range is a SURFACE-POSITION span, not a numeric seq interval — after a prior replace lands a fresh high-seq summary node at the shadowed range's position, surface order no longer tracks seq order. |

`CompactionResult` keeps the raw summary and bookkeeping-event seqs available to callers alongside the shadowed range and token accounting; its drift-checked shape lives in the [compaction data-structure reference](../../../docs/core-data-structures/compaction.md#compactionresult).

`compactIfNeeded` takes a required `signal`; `compactRegion`'s is optional. A backend that summarizes via `ctx.llm.stream()` **must** forward it into the call's `GenerateOptions.signal`, so an abort or fiber dispose tears down the in-flight summarization instead of leaving an orphaned model call running past the cancellation. The turn that the `compact/*` events belong to is recoverable from the owned session's log (the currently-open turn), so the backend stamps it from the log rather than trusting a caller-supplied value.

## Tool-pairing boundaries

The interface exports `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)` for snapping and validating compaction edges. A safe edge has no unanswered assistant tool call crossing it. Each helper validates that the event sequence is in the current surface and answers from balances cached per cut in surface order.

The private per-session cache is keyed by `session.surface.replaceGeneration` and the processed surface-entry count. An unchanged generation extends the fold with unseen tail entries only; a log-only append with no new surface entry does no event reads, while a replacement generation rebuilds current membership and balances. Missing event seqs and a `tool/result` without a preceding open call reject as corrupt surface state.

## Surface contract

`SurfaceEventType` is a closed union — only `user/message`, `assistant/message`, `tool/result`, `context/message`, and `steering/message` may carry `surfaceOp`. A `compact/*` event therefore **cannot** appear on the surface. A successful compaction instead:

1. appends `compact/start` (log-only) — acquires the lock,
2. summarizes the range,
3. appends `compact/summary` (log-only) — provenance: summary, range, shadowed seqs, token count, and provider/model call envelope,
4. appends a single `user/message` with `surfaceOp: { op: 'replace', start, end }` carrying the summary — **the only surface mutation**,
5. appends `compact/end` (log-only) — releases the lock.

The surface mutation (step 4) sits **inside** the lock bracket: `compact/end` is the last event, so the lock is never released before the mutation lands. A crash between `compact/start` and `compact/end` therefore leaves a detectable orphaned lock (a `compact/start` with no matching `compact/end`) rather than a `compact/end` that falsely claims compaction finished while the surface was never shadowed.

`deriveMessages()` then renders the summary as a user-role message followed by the retained nodes. The shadowed events remain in the raw log, so replay is deterministic.

## Blocking

Compaction is serialized via a log-recorded lock: `compactRegion` refuses to start if the last `compact/start` has no matching `compact/end` after it. The lock is the log (not an in-memory mutex), so it survives replay and a persistence backend can detect an orphaned `compact/start` on reload. The lock brackets the **whole** operation — summarization, the `compact/summary` provenance record, *and* the `user/message` surface replacement all happen before `compact/end` — so a `session/event` listener firing on `compact/end` never observes the lock free while the surface mutation is still pending. `compact/end` is appended even when summarization throws, so a failure can never wedge the lock.

## Events

The `compact/*` events extend `SessionEventMap` (merge-extensible) via declaration merging — they are session events, not cordis `Events`, and all three are log-only (no `surfaceOp`). Per-event payloads and semantics are in the generated [persistence log event catalog](../../../docs/persistence-catalog.md).

## Implementing a backend

Subclass `CompactService`, implement `compactIfNeeded` and `compactRegion`, and load the subclass as a plugin — it registers as `ctx.compact`. A template- or model-backed implementation can live as a sibling package without changing callers or the shared token meter.

## Model Experience

### Conversation history, when a backend is invoked

#### What the model sees

A successful implementation replaces an older surface range with one user-role summary checkpoint; the raw events stay logged but stop appearing in derived model messages. The seam itself performs no rewrite.

#### Token effect

Zero direct tokens from this interface. A backend trades many retained history tokens for one summary and leaves the recent tail unchanged.

#### KV Cache effect

A successful backend replacement invalidates reuse from the first shadowed history token; the seam itself does not alter a request.

### Transcript supplied to a compaction consumer

#### What the model sees

`renderTranscript()` joins entries with one blank line and renders them exactly as `User: <content>`, `Assistant: <content>`, `Tool result (call <callId>): <content>`, `Tool error (call <callId>): <content>`, `[Context: <content>]`, or `[Steering: <content>]`. Non-text blocks render exactly as `[reasoning: <text>]`, `[tool-call: <name>(<arguments>)]`, `[tool-result: <content>]`, `[tool-result]`, or `[<block-type>]`.

#### Token effect

Data-dependent input tokens are paid only by the auxiliary model or consumer that requests this transcript; the conversation model does not receive a duplicate transcript.

#### KV Cache effect

No conversation-cache invalidation. A consumer's auxiliary request can reuse only the exact prefix produced by this rendering; changed or compacted entries invalidate reuse from their first difference.

## Known Limitations and Deferred Work

- **No model-facing consumer tier yet** — `@deepseek-ai/dsh-tool-compact` (the `/compact` tool) is deferred; compaction is reachable only via direct `ctx.compact` calls or a backend's auto listener.
- **Single-unit overflow is out of contract** — one indivisible unit (a closed tool pair or a large pasted `user/message`) alone exceeding the budget cannot be compacted.
- **An envelope that alone approaches the window is not surface-compaction work** — compaction shrinks derived history, never the system prompt, tools, or session prefix.
