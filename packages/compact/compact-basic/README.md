# @deepseek-ai/dsh-compact-basic

The **basic compaction backend**: a `BasicCompactService` implementing the `@deepseek-ai/dsh-compact` seam with a chars-per-token heuristic (the `charsPerToken` config, default 4), token-budget retention, and summarization as a direct one-shot `ctx.llm.stream()` call (interceptable at `llm/stream`).

This is the implementation tier of the compaction capability — see the [interface package](../compact/README.md) for the seam and the [capability-seam RFC](../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) for the design.

## What it owns

The abstract contract states only WHAT compaction does; this backend owns every HOW decision:

- **Token estimation** — `estimateContentTokens()`: chars divided by the `charsPerToken` config (default 4) with per-block structural overhead (`text`/`reasoning` = `ceil(len/charsPerToken) + 4`, `tool-call` from name + arguments, `tool-result` recursive, unknown blocks via JSON length). The pressure gate estimates the NEXT request via `estimatePressure()`: the session prefix (the `agent/session-prefix` product — composed by the loop BEFORE the pre-step seam and handed through it, so the gate counts the prefix this instance will actually send in front of the history, never a stale logged one) + the derived history + the system prompt.
- **Retention policy** — `compactIfNeeded()` walks the surface nodes tail→head summing per-node token estimates, and retains the smallest tail-run of WHOLE units (a closed step, or a single no-step node such as a pre-step `user/message` or inter-step `steering/message`) whose total reaches `retainTokens`; everything older is compacted. Retention is **turn-agnostic** — turn boundaries play no role, so a single runaway turn that alone exceeds the window compacts its OWN early closed steps rather than being retained verbatim (the failure mode that motivated dropping turn-protection: a tool-heavy turn must stay compactable or the harness dies exactly when compaction is needed). The only structural guard is **tool-pairing balance**: the compacted region's edges are balanced cuts on the surface (no unanswered tool-call crosses either edge), so it never splits a step's `assistant/message` tool-calls from their `tool/result`s. When the only compactable content left is an un-splittable open tail step, it declines (returns `null`) and retries once an older step closes. **Single-unit overflow is out of scope, by design**: if one retained unit (a single closed step, or a large pasted `user/message`) ALONE exceeds the budget, compaction cannot help and the call may go out over-budget — bounding an individual unit's size is a separate concern. `compactRegion()` enforces tool-pairing balance strictly, throwing on a boundary that would split a step. `dsh-session` exports `isToolPairingBalanced` for the check.
- **Dynamic convergence** — no static summary-length config pretends to bound what the model will write. If framing/estimator/system overhead leaves the compacted surface above threshold, `compactIfNeeded()` re-compacts the head checkpoint up to `compactionRetries` extra times; if it still cannot get below threshold, it throws. A summary whose estimated stored size is not smaller than the shadowed content fails closed before it mutates the surface.
- **Summarization** — `summarize()`: a `GenerateOptions` request assembled via `BlockAssembler` with a fixed system prompt that asks for a structured checkpoint (Primary Request and Intent · Key Technical Concepts · Files and Code · Errors and Fixes · Pending Tasks · Current Work · Next Step · Critical Context), every section mandatory, exact paths/commands/identifiers preserved. The request is a direct one-shot `ctx.llm.stream()` call — NOT a loop step, so it does not run `agent/request` (that seam shapes the loop's conversation requests); the model comes from `summarizationModel` falling back to the agent's own, and per-call routing happens at `llm/stream` like any other direct call. `maxTokens` is the provider-side generation cap; only text blocks from the model's reply are kept before the checkpoint is stored (reasoning is dropped so private chain-of-thought never leaks into the durable summary, and a stray `tool-call` is dropped so the synthesized `user/message` summary cannot land an orphaned call with no matching `tool-result`). The compacted region is flattened to a plain-text transcript first: text and reasoning contribute their text, and every non-text block (tool-call, tool-result, plugin-added types) contributes a type-tagged placeholder (`[tool-call: name(args)]`, `[tool-result: …]`, …) so the summarizer is told what existed rather than silently dropping it.
- **Checkpoint framing** — the raw summary is not landed directly. `compactRegion()` wraps it in a checkpoint preamble (so a resuming model reads it as a checkpoint, not a fresh user request, and builds on the captured context rather than restating it) plus `<compacted-summary>…</compacted-summary>` tags. Because region compaction can be invoked manually, a surface may hold several checkpoints, so the framing does not claim everything after it is recent or verbatim. The tags make a prior checkpoint detectable in the transcript on the next compaction cycle: the summarization prompt then instructs the model to merge it in place (preserve still-true facts, drop stale ones) rather than re-summarize it verbatim — a cheap incremental merge that needs no extra log/event machinery. The unframed summary stays on the `compact/summary` provenance event.
- **Surface mutation** — `compactRegion()` appends the `compact/start` → `compact/summary` → `compact/end` log records and the single `user/message` replace node carrying the framed summary (see the interface README).
- **Auto-compaction** — an `agent/pre-step` listener delegates to `compactIfNeeded()` before every step (not just a turn's first — a tool-heavy turn grows the surface mid-turn, so a runaway turn still compacts, and per-step firing is the only moment to rescue it before overflow). `agent/pre-step` is a serial (awaited, in-order) surface-mutation checkpoint that fires after `turn/start` and BEFORE the step opens (`step/start`) and its request history is derived, so compaction mutates the surface — with its log-only `compact/*` records landing cleanly outside any step — and the loop derives once from the result: no double-derive, and the listener cannot see (or need to rewrite) an already-assembled `messages` array. The listener owns no threshold logic of its own (the single token-pressure check lives in `compactIfNeeded()`); because Cordis `serial` bails early on non-void return values, the listener returns `void` and does not use the dispatcher's bail channel as a veto surface.
- **Failure handling** — the `compact/start … compact/end` bracket is a log-recorded lock: it makes a crash mid-summarization a detectable orphan (a `compact/start` with no `compact/end`), records provenance, and prevents a concurrent compaction. Two failure paths: a **crash** (the loop dies mid-summarization) leaves a dangling `compact/start` that is inert — `compact/*` events are log-only, the surface replacement never landed, so the full history derives fine and generic turn-repair closes the turn; a **recoverable** failure (summarization throws but the loop survives) appends `compact/end` with its `error` field set, leaving the surface untouched so the call proceeds with full history. Core session repair stays compaction-agnostic by design — it never learns about `compact/*`.

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
