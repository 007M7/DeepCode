# @deepseek-ai/dsh-compact-basic

The **basic compaction backend**: a `BasicCompactService` implementing the `@deepseek-ai/dsh-compact` seam with a char/4 token heuristic, token-budget retention, and `ctx.llm.stream()` summarization.

This is the implementation tier of the compaction capability — see the [interface package](../compact/README.md) for the seam and the [capability-seam RFC](../../../docs/rfc/proposed/feature/2026-06-18-compaction-capability-seam.md) for the design.

## What it owns

The abstract contract states only WHAT compaction does; this backend owns every HOW decision:

- **Token estimation** — `estimateContentTokens()`: char/4 with per-block structural overhead (`text`/`reasoning` = `ceil(len/4) + 4`, `tool-call` from name + arguments, `tool-result` recursive, `image` = 85, unknown blocks via JSON length).
- **Retention policy** — `compactIfNeeded()` ALWAYS retains the in-flight turn's surface nodes verbatim (its initiating request and any mid-turn tool results — the exact input/observation the model is acting on, even if they exceed the budget), then walks the OLDER (closed-turn) nodes tail→head, summing per-node token estimates, and compacts everything older than the first node that overflows the `retainTokens` budget. The cutoff is snapped to a step boundary so the compacted region never splits a step's `assistant/message` tool-calls from their `tool/result`s (the budget is a soft target): it prefers snapping FORWARD to the next clean boundary, and falls back to snapping BACKWARD when the forward snap would reach the protected in-flight turn. If no step-aligned cutoff exists in the older range (e.g. its only content is an open tail step), it declines (returns `null`) and retries once an older step closes. `compactRegion()` enforces step-alignment strictly, throwing on a boundary that would split a step. Token-based (not turn-count) retention keeps more short turns and compacts tool-heavy turns sooner.
- **Summarization** — `summarize()`: a `ctx.llm.stream()` call assembled via `BlockAssembler` (the single model-call surface) with a fixed system prompt that asks for a structured checkpoint (Primary Request and Intent · Key Technical Concepts · Files and Code · Errors and Fixes · Pending Tasks · Current Work · Next Step · Critical Context), every section mandatory, exact paths/commands/identifiers preserved. The compacted region is flattened to a plain-text transcript first: text and reasoning contribute their text, and every non-text block (image, tool-call, tool-result, plugin-added types) contributes a type-tagged placeholder (`[image]`, `[tool-call: name(args)]`, …) so the summarizer is told what existed rather than silently dropping it.
- **Checkpoint framing** — the raw summary is not landed directly. `compactRegion()` wraps it in a checkpoint preamble (so a resuming model reads it as a checkpoint, not a fresh user request, and builds on the captured context rather than restating it) plus `<compacted-summary>…</compacted-summary>` tags. Because region compaction can be invoked manually, a surface may hold several checkpoints, so the framing does not claim everything after it is recent or verbatim. The tags make a prior checkpoint detectable in the transcript on the next compaction cycle: the summarization prompt then instructs the model to merge it in place (preserve still-true facts, drop stale ones) rather than re-summarize it verbatim — a cheap incremental merge that needs no extra log/event machinery. The unframed summary stays on the `compact/summary` provenance event.
- **Surface mutation** — `compactRegion()` appends the `compact/start` → `compact/summary` → `compact/end` log records and the single `user/message` replace node carrying the framed summary (see the interface README).
- **Auto-compaction** — an `agent/request` waterfall listener delegates to `compactIfNeeded()` before every model call (every step, not just a turn's first — a tool-heavy turn grows the surface mid-turn, so a runaway turn still compacts) and re-derives messages after compacting; the listener owns no threshold logic of its own (the single token-pressure check lives in `compactIfNeeded()`).

`estimateContentTokens()` and `summarize()` are overridable hooks: a tokenizer-based or template-based backend can subclass `BasicCompactService` and override just those, reusing the retention walk and surface plumbing.

## Config (`BasicCompactConfig`)

| Key | Default | Meaning |
|---|---|---|
| `contextWindow` | `128000` | Context window size in tokens. |
| `thresholdRatio` | `0.8` | Compact when estimated usage exceeds this fraction of the window. |
| `retainTokens` | `20480` | Tokens of recent context to keep intact. |
| `summarizationModel` | `''` | Model for summarization (empty → use the agent's model). |
| `summarizationMaxTokens` | `2048` | Max tokens for the summary response. |
| `auto` | `true` | Register the `agent/request` auto-compaction listener. Set `false` for manual-only. |

## Usage

```ts
import type { Context } from 'cordis'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'

export const name = 'compact-basic'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.plugin(BasicCompactService, { contextWindow: 128000, retainTokens: 20480 })
}
```

Loading the plugin registers `ctx.compact`. With `auto: true` (the default) it compacts automatically under token pressure; a consumer (a future `/compact` tool) can also call `ctx.compact.compactIfNeeded(...)` or `ctx.compact.compactRegion(...)` directly.
