# RFC: After-call compaction pressure and context-overflow recovery

Status: implemented

English | [中文](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)

## Problem

Automatic compaction originally ran at `agent/pre-step` and received an assembled prompt and session prefix. That boundary was necessarily provisional: `agent/request` could still route another model or change call configuration, tool schemas were not frozen with the compaction inputs, and the next assistant output, tool results, buffered context, and steering did not exist yet. Expanding the pre-step signature could move the stale boundary but could not make it exact.

Successful calls are not the only pressure signal. A provider can reject a request for exceeding its context window before it returns usage, and some successful calls omit usage. The system therefore needs replayable post-call pressure plus a narrow failure-recovery path that preserves the provider error whenever compaction cannot prove useful progress.

## Decision

### Successful pressure moves to a durable post-step checkpoint

`agent/pre-step` is narrowed to `(agent, turn, step, signal)`. It remains a generic serial checkpoint before `step/start`, but it carries no compaction-only prompt or prefix fields.

The loop fires awaited serial `agent/post-step(agent, turn, step, signal)` after assistant output, every dispatched or synthetic tool result, post-tool context, and steering are durable, but before `step/end`. This placement gives pressure policy the complete successful-call state without splitting an assistant tool call from its result. A listener failure is an ordinary turn failure; it never enters model-request recovery.

`dsh-compact-basic` reads the exact latest routed model from the durable request header only to establish that a completed route exists, then asks the singleton `ctx.tokenMeter` to measure the canonical logged envelope and current surface. It does not fall back to `AgentOptions.model` for automatic pressure. A headerless session has no completed routed request to assess and produces no work; any durable non-empty model name uses the same estimator. Operational measurement or summarization failures warn and continue with full history.

### Request recovery is limited to the final model boundary

`RequestError`, `RequestErrorDecision`, and the `agent/request-error` waterfall represent failures after the final adapter has been selected. Private `WeakSet` tagging preserves the original thrown error identity across dispatch, iterator construction, and iteration. Terminal in-band `error` or `aborted` finishes enter the same path. Prompt assembly, request middleware, request logging, result processing, tools, post-step listeners, and cleanup remain ordinary failures.

The failed step closes before recovery runs. A retry opens the next numbered step and rebuilds the request from the durable log; consecutive recovery attempts reset only after a successful provider request. Both DeepSeek adapters normalize recognized provider context-limit failures to `CONTEXT_WINDOW_EXCEEDED`.

If cancellation lands after assistant tool calls are durable but before all calls dispatch, the loop records a synthetic aborted `tool/result` for every undispatched call before following the normal abort path. The surface therefore never retains orphaned durable tool calls merely because cancellation won the race.

### CompactService exposes intent, not token accounting

`CompactService.compactIfNeeded(agent, trigger, signal)` accepts `trigger: 'pressure' | 'context-overflow'`. The interface gains no estimation methods or token types; `ctx.tokenMeter` remains the reusable accounting owner.

For `pressure`, compact-basic applies the service-wide threshold and retained-tail policy to one unified `ctx.tokenMeter.measure()` result. Below pressure it returns without pruning. Once pressure qualifies, optional `ctx.toolResultPrune` rewrites oversized current results and compact-basic remeasures through the same meter; safe pressure skips the model call, while remaining pressure selects and summarizes from the pruned surface. The same singleton meter owns range pricing, provenance, shadowed token counts, and non-shrinking-summary rejection. The common defaults remain threshold ratio `0.8`, retained history `floor(contextWindow × 0.16)`, summarization model `''`, `maxTokens: 8192`, `compactionRetries: 1`, and `auto: true`.

For canonical overflow, compact-basic bypasses scalar pressure and the normal retained-token budget. It prunes first, then chooses the maximal tool-balanced head range while leaving the newest indivisible unit and attempts one shrinking summary compaction under the same signal when a range exists. The automatic listener snapshots `session.surface.replaceGeneration` and returns `{ action: 'retry' }` whenever pruning or summarization increases it. A backend returning a result without replacement cannot authorize retry, while pruning-only progress can authorize a retry without a `CompactionResult`.

`maxOverflowRetries` is optional and defaults to `1`; `0` disables overflow recovery without disabling pressure. `auto: false` registers neither automatic listener. Noncanonical errors, exhausted attempts, an already-aborted signal, a missing routed model, no safe range, no generation change, and recovery throws all delegate to the next listener. With no later recovery, the loop reports the original provider error object and code. Cancellation or disposal remains authoritative even if recovery work completes concurrently.

The default summarizer still resolves explicit configuration, then the latest logged route, then agent options. Because direct `llm/stream` middleware may reroute that auxiliary call, `compact/summary.model` records the final mutable `GenerateOptions.model` observed after dispatch rather than the pre-waterfall candidate.

## Testing

Lifecycle tests pin post-step ordering after durable tool/context/steering work, content-less and max-token successes, final-adapter dispatch/iterator/in-band boundaries, retry numbering, attempt reset, cancellation, disposal, synthetic tool results, and original error identity.

Compact tests pin low-friction service-wide defaults, actual routed-model selection, unlisted-model measurement, unified pressure-and-retention decisions, pressure-gated pruning, pruning-only relief, summarization from pruned input, optional-plugin fallback, pruning-only and summarized overflow recovery, newest tool-pair retention, non-shrinking rejection, generation proof, caps, disabled listeners, single downstream delegation, and auxiliary summary routing provenance. Real-loop composition covers both thrown and in-band overflow: the failed step closes, compaction lands between attempts, and the next numbered request is reconstructed from the replacement surface.

## Alternatives considered

- **Keep provisional pre-step pressure and add more arguments** — rejected because later routing and request mutation remain outside any earlier snapshot, while generic lifecycle becomes coupled to one plugin.
- **Retry the same numbered step** — rejected because recovery appends durable events after the failed boundary. A new step preserves balanced nesting and reconstructability.
- **Retry whenever `compactIfNeeded` returns a result** — rejected because a custom backend can report success without changing model-visible state. `replaceGeneration` is the authoritative proof.
- **Let compact-basic parse provider wording** — rejected because classification belongs at adapters and must cover both thrown and in-band delivery.
- **Fall back to `AgentOptions.model` when no durable route exists** — rejected because automatic policy must describe a completed logged request. Headerless pressure and recovery delegate unchanged.

## Consequences

Pressure describes the actual completed routed request, including durable tool results and request-only prefix fields, rather than a provisional next-call guess. Optional model-free pruning removes predictable tool-output bulk before summary selection and can independently create retry-worthy progress. Canonical overflow supplies the backstop when no successful usage anchor exists. Recovery is bounded, cancellation-owned, and monotonic: it retries only after a visible surface generation change.

The cost is one additional serial checkpoint on successful steps and adapter-maintained overflow classification. Provider wording and heuristic character density remain maintenance risks. Surface compaction still cannot repair an envelope that alone exceeds the window or split one indivisible oversized message/tool unit.

This RFC supersedes only the pre-step automatic-trigger portion of the [compaction capability-seam RFC](../feature/2026-06-18-compaction-capability-seam.md). The service split, standalone token meter, balanced range contract, log-recorded lock, summary replacement, and sole `summarize()` subclass hook remain unchanged.
