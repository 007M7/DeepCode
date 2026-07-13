# @deepseek-ai/dsh-compact-basic

The **basic compaction backend**: a `BasicCompactService` implementing the `@deepseek-ai/dsh-compact` seam with a chars-per-token heuristic (the `charsPerToken` config, default 4), token-budget retention, and summarization as a direct one-shot `ctx.llm.stream()` call (interceptable at `llm/stream`).

This is the implementation tier of the compaction capability — see the [interface package](../compact/README.md) for the seam and the [capability-seam RFC](../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) for the design.

## What it owns

This backend owns the compaction policy:

- **Estimation** — a configurable characters-per-token heuristic counts the current session prefix supplied to pre-step, derived history, and system prompt, matching the next request rather than stale logged prefix state.
- **Retention** — compact the oldest whole surface units while preserving a recent tail and balanced tool-call/result cuts. Turn boundaries do not protect old steps inside a runaway turn. An open indivisible tail declines until it closes; a single unit larger than the budget remains out of scope.
- **Convergence** — retry head-checkpoint compaction up to `compactionRetries`; reject a summary that does not shrink its source, and throw if retries cannot return below threshold.
- **Summarization** — a direct `llm/stream` call uses the configured model and cap without running the loop-only `agent/request` seam. The input transcript preserves non-text blocks as tagged placeholders; only returned text enters the checkpoint, excluding reasoning and tool calls that would leak private reasoning or create an orphaned call.
- **Framing** — the replacement user message marks established checkpoint context with `<compacted-summary>` tags. The raw summary remains on the provenance event, and later automatic cycles merge the prior checkpoint.
- **Lifecycle** — `compactRegion()` records its start, summary, replacement, and end. The serial `agent/pre-step` listener checks pressure before every step, outside an open step, so a tool-heavy turn remains compactable and the loop derives history once after mutation.
- **Failure handling** — an unmatched `compact/start` is an inert crash marker because no replacement landed. Recoverable failure records an error end and leaves the surface unchanged.

`estimateContentTokens()` and `summarize()` are overridable hooks: a tokenizer-based or template-based backend can subclass `BasicCompactService` and override just those, reusing the retention walk and surface plumbing. `summarize()` returns the summary blocks together with the call envelope it actually used (`{ summary, model, maxTokens? }`) — the caller logs that envelope on the `compact/summary` provenance event, so an overriding backend reports its own envelope honestly.

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
