# @deepseek-ai/dsh-compact-basic

The **basic compaction backend**: a `BasicCompactService` implementing the `@deepseek-ai/dsh-compact` seam with a chars-per-token heuristic (the `charsPerToken` config, default 4), token-budget retention, and summarization as a direct one-shot `ctx.llm.stream()` call (interceptable at `llm/stream`).

This is the implementation tier of the compaction capability — see the [interface package](../compact/README.md) for the seam and the [capability-seam RFC](../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) for the design.

## What it owns

This backend owns the compaction policy:

- **Estimation** — a configurable characters-per-token heuristic counts the current session prefix supplied to pre-step, derived history, and system prompt, matching the next request rather than stale logged prefix state.
- **Retention** — compact the oldest whole surface units while preserving a recent tail and balanced tool-call/result cuts through the [`dsh-compact` boundary helpers](../compact/README.md#tool-pairing-boundaries). Turn boundaries do not protect old steps inside a runaway turn. An open indivisible tail declines until it closes; a single unit larger than the budget remains out of scope.
- **Convergence** — retry head-checkpoint compaction up to `compactionRetries`; reject a summary that does not shrink its source, and throw if retries cannot return below threshold.
- **Summarization** — a direct `llm/stream` call uses the configured provider/model pair and cap, falling back to the latest logged request target and then the agent target, without running the loop-only `agent/request` seam. The input transcript preserves non-text blocks as tagged placeholders; only returned text enters the checkpoint, excluding reasoning and tool calls that would leak private reasoning or create an orphaned call.
- **Framing** — the replacement user message marks established checkpoint context with `<compacted-summary>` tags. The raw summary remains on the provenance event, and later automatic cycles merge the prior checkpoint.
- **Lifecycle** — `compactRegion()` records its start, summary, replacement, and end. The serial `agent/pre-step` listener checks pressure before every step, outside an open step, so a tool-heavy turn remains compactable and the loop derives history once after mutation.
- **Failure handling** — an unmatched `compact/start` is an inert crash marker because no replacement landed. Recoverable failure records an error end and leaves the surface unchanged.

`estimateContentTokens()` and `summarize()` are overridable hooks: a tokenizer-based or template-based backend can subclass `BasicCompactService` and override just those, reusing the retention walk and surface plumbing. `summarize()` returns the summary blocks together with the call envelope it actually used (`{ summary, provider, model, maxTokens? }`) — the caller logs that envelope on the `compact/summary` provenance event, so an overriding backend reports its own envelope honestly.

## Config (`BasicCompactConfig`)

Every knob is **required** except `auto` — there is no concrete data yet to justify default thresholds/budgets, so a consumer states each value explicitly rather than inherit a guessed default. `auto` alone defaults to `true`.

| Key | Required | Meaning |
|---|---|---|
| `contextWindow` | yes | Context window size in tokens. |
| `thresholdRatio` | yes | Compact when estimated usage exceeds this fraction of the window. |
| `retainTokens` | yes | Tokens of recent context to keep intact. |
| `summarizationProvider` | yes | Provider for summarization (`''` together with an empty model → use the latest logged request pair, then the agent pair). |
| `summarizationModel` | yes | Model for summarization (`''` together with an empty provider → use the latest logged request pair, then the agent pair). |
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
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 8192,
    compactionRetries: 1,
  })
}
```

Loading the plugin registers `ctx.compact`. With `auto: true` (the default) it compacts automatically under token pressure; a consumer (a future `/compact` tool) can also call `ctx.compact.compactIfNeeded(...)` or `ctx.compact.compactRegion(...)` directly.

## Model Experience

### Conversation history

**What the model sees**: Before a step whose estimated envelope and history exceed the threshold, the conversation model receives the checkpoint preamble below, a blank line, `<compacted-summary>`, the data-dependent summary, and `</compacted-summary>`. This one checkpoint replaces the selected older range and is followed by the retained recent units.

**Token effect**: The replacement reduces future input history rather than appending a second copy. The summary remains until a later compaction replaces it; one oversized indivisible unit can still exceed the budget.

#### Conversation checkpoint preamble

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

### Auxiliary summarizer user message

**What the model sees**: The summarization model receives exactly `Summarize this conversation history:` followed by a blank line, the data-dependent [`renderTranscript()`](../compact/README.md) output, another blank line, and `Summary:`. The conversation model never sees this private request or its reasoning; only returned text is stored.

**Token effect**: This is a separate model call with data-dependent input and `maxTokens`-capped output. Convergence retries can pay this cost more than once.

### Auxiliary summarizer system prompt

**What the model sees**: The summarization model receives the checkpoint-writing instruction below.

**Token effect**: Fixed auxiliary input cost plus the data-dependent transcript on every summarization attempt.

#### Auxiliary summarizer system prompt

```markdown
You are a compaction engine for an AI coding assistant. Condense the conversation transcript into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Tasks
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Preserve exact file paths, commands, error strings, identifiers, and function signatures.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization process or that the context was compacted.
- If the transcript already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

## Known Limitations and Deferred Work

- **Token estimation is the chars/`charsPerToken` heuristic** — a marked TODO schedules replacing it with an exact count (a real tokenizer, or provider `usage` fed back) so thresholds track the model's actual budget.
- **`estimatePressure()` does not count the request's `tools` field** — pressure is underestimated by the size of the serialized tool schemas the request also carries.
- **`compactRegion` requires an open turn** — a manual call on a fully-closed session throws ("no open turn") rather than compacting.
- **Summarization failure fails closed with full, over-budget history** — including truncation at the summarization `maxTokens`, which hidden reasoning tokens can consume; the auto path logs a warning and proceeds.
- **The summarization call has no transcript-snapshot coverage** — `dsh-llm-replay` derives calls from `assistant/chunk` events, so this chunk-less direct `ctx.llm.stream()` call cannot replay (named deferred replay infrastructure in [the seam RFC](../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)).
