# @deepseek-ai/dsh-compact-basic

The **basic compaction backend**: a `BasicCompactService` implementing the `@deepseek-ai/dsh-compact` seam with a chars-per-token heuristic (the `charsPerToken` config, default 4), token-budget retention, and summarization routed through the agent request pipeline.

This is the implementation tier of the compaction capability — see the [interface package](../compact/README.md) for the seam and the [capability-seam RFC](../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) for the design.

## What it owns

The abstract contract states only WHAT compaction does; this backend owns every HOW decision:

- **Token estimation** — `estimateContentTokens()`: chars divided by the `charsPerToken` config (default 4) with per-block structural overhead (`text`/`reasoning` = `ceil(len/charsPerToken) + 4`, `tool-call` from name + arguments, `tool-result` recursive, `image` = 85, unknown blocks via JSON length).
- **Retention policy** — `compactIfNeeded()` walks the surface nodes tail→head summing per-node token estimates, and retains the smallest tail-run of WHOLE units (a closed step, or a single no-step node such as a pre-step `user/message` or inter-step `steering/message`) whose total reaches `retainTokens`; everything older is compacted. Retention is **turn-agnostic** — turn boundaries play no role, so a single runaway turn that alone exceeds the window compacts its OWN early closed steps rather than being retained verbatim (the failure mode that motivated dropping turn-protection: a tool-heavy turn must stay compactable or the harness dies exactly when compaction is needed). The only structural guard is **tool-pairing balance**: the compacted region's edges are balanced cuts on the surface (no unanswered tool-call crosses either edge), so it never splits a step's `assistant/message` tool-calls from their `tool/result`s. When the only compactable content left is an un-splittable open tail step, it declines (returns `null`) and retries once an older step closes. **Single-unit overflow is out of scope, by design**: if one retained unit (a single closed step, or a large pasted `user/message`) ALONE exceeds the budget, compaction cannot help and the call may go out over-budget — bounding an individual unit's size is a separate concern. `compactRegion()` enforces tool-pairing balance strictly, throwing on a boundary that would split a step. `dsh-session` exports `isToolPairingBalanced` for the check.
- **Dynamic convergence** — no static summary-length config pretends to bound what the model will write. If framing/estimator/system overhead leaves the compacted surface above threshold, `compactIfNeeded()` re-compacts the head checkpoint up to `compactionRetries` extra times; if it still cannot get below threshold, it throws. A summary whose estimated stored size is not smaller than the shadowed content fails closed before it mutates the surface.
- **Summarization** — `summarize()`: a `GenerateOptions` request assembled via `BlockAssembler` with a fixed system prompt that asks for a structured checkpoint (Primary Request and Intent · Key Technical Concepts · Files and Code · Errors and Fixes · Pending Tasks · Current Work · Next Step · Critical Context), every section mandatory, exact paths/commands/identifiers preserved. The request runs through the `agent/request` waterfall before `ctx.llm.stream()`, so router agents that choose the concrete model there also route compaction summaries. `maxTokens` is the provider-side generation cap; only text blocks from the model's reply are kept before the checkpoint is stored (reasoning is dropped so private chain-of-thought never leaks into the durable summary, and a stray `tool-call` is dropped so the synthesized `user/message` summary cannot land an orphaned call with no matching `tool-result`). The compacted region is flattened to a plain-text transcript first: text and reasoning contribute their text, and every non-text block (image, tool-call, tool-result, plugin-added types) contributes a type-tagged placeholder (`[image]`, `[tool-call: name(args)]`, …) so the summarizer is told what existed rather than silently dropping it.
- **Checkpoint framing** — the raw summary is not landed directly. `compactRegion()` wraps it in a checkpoint preamble (so a resuming model reads it as a checkpoint, not a fresh user request, and builds on the captured context rather than restating it) plus `<compacted-summary>…</compacted-summary>` tags. Because region compaction can be invoked manually, a surface may hold several checkpoints, so the framing does not claim everything after it is recent or verbatim. The tags make a prior checkpoint detectable in the transcript on the next compaction cycle: the summarization prompt then instructs the model to merge it in place (preserve still-true facts, drop stale ones) rather than re-summarize it verbatim — a cheap incremental merge that needs no extra log/event machinery. The unframed summary stays on the `compact/summary` provenance event.
- **Surface mutation** — `compactRegion()` appends the `compact/start` → `compact/summary` → `compact/end` log records and the single `user/message` replace node carrying the framed summary (see the interface README).
- **Auto-compaction** — an `agent/pre-step` listener delegates to `compactIfNeeded()` before every step (not just a turn's first — a tool-heavy turn grows the surface mid-turn, so a runaway turn still compacts, and per-step firing is the only moment to rescue it before overflow). `agent/pre-step` is a serial (awaited, in-order) surface-mutation checkpoint that fires after `turn/start` and BEFORE the step opens (`step/start`) and its request history is derived, so compaction mutates the surface — with its log-only `compact/*` records landing cleanly outside any step — and the loop derives once from the result: no double-derive, and the listener cannot see (or need to rewrite) an already-assembled `messages` array. The listener owns no threshold logic of its own (the single token-pressure check lives in `compactIfNeeded()`); because Cordis `serial` bails early on non-void return values, the listener returns `void` and does not use the dispatcher's bail channel as a veto surface.
- **Failure handling** — the `compact/start … compact/end` bracket is a log-recorded lock: it makes a crash mid-summarization a detectable orphan (a `compact/start` with no `compact/end`), records provenance, and prevents a concurrent compaction. Two failure paths: a **crash** (the loop dies mid-summarization) leaves a dangling `compact/start` that is inert — `compact/*` events are log-only, the surface replacement never landed, so the full history derives fine and generic turn-repair closes the turn; a **recoverable** failure (summarization throws but the loop survives) appends `compact/end` with its `error` field set, leaving the surface untouched so the call proceeds with full history. Core session repair stays compaction-agnostic by design — it never learns about `compact/*`.

`estimateContentTokens()` and `summarize()` are overridable hooks: a tokenizer-based or template-based backend can subclass `BasicCompactService` and override just those, reusing the retention walk and surface plumbing.

## Config (`BasicCompactConfig`)

Every knob is **required** except `auto` — there is no concrete data yet to justify default thresholds/budgets, so a consumer states each value explicitly rather than inherit a guessed default. `auto` alone defaults to `true`.

| Key | Required | Meaning |
|---|---|---|
| `contextWindow` | yes | Context window size in tokens. |
| `thresholdRatio` | yes | Compact when estimated usage exceeds this fraction of the window. |
| `retainTokens` | yes | Tokens of recent context to keep intact. |
| `summarizationModel` | yes | Model for summarization (`''` → use the agent's model). |
| `maxTokens` | yes | Provider generation cap for the summarization call; may include reasoning tokens. |
| `compactionRetries` | yes | Extra compaction attempts after the first if the compacted surface remains over threshold. |
| `auto` | no (default `true`) | Register the `agent/pre-step` auto-compaction listener. Set `false` for manual-only. |
| `charsPerToken` | no (default `4`) | Token-estimator text density (estimated tokens = chars / `charsPerToken`; may be fractional). The default suits English text; CJK-heavy deployments should set ~1-2 or the estimate undershoots several-fold and compaction fires too late. |

## Usage

```ts
import type { Context } from 'cordis'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'

export const name = 'compact-basic'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.plugin(BasicCompactService, {
    contextWindow: 128000,
    thresholdRatio: 0.8,
    retainTokens: 20480,
    summarizationModel: '',
    maxTokens: 8192,
    compactionRetries: 1,
  })
}
```

Loading the plugin registers `ctx.compact`. With `auto: true` (the default) it compacts automatically under token pressure; a consumer (a future `/compact` tool) can also call `ctx.compact.compactIfNeeded(...)` or `ctx.compact.compactRegion(...)` directly.
