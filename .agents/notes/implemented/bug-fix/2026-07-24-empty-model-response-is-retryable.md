# Agent Note: Empty model completions are retryable EMPTY_RESPONSE failures

Status: implemented

English | [中文](2026-07-24-empty-model-response-is-retryable.zh.md)

## Problem

Providers occasionally return a degenerate completion: a well-formed stream that carries a terminal `stop` finish and zero content blocks — no text, no reasoning, no tool calls. Before this change both adapters mapped it to a successful `{kind: 'stop'}` finish, so the loop logged an empty `assistant/message` and ended the turn as `completed`. Nothing retried, nothing failed loud, and a driver like goal-session counted the silent no-op as a consumed round. A live incident showed an openrouter-served model burning three of six goal rounds on empty completions before the goal blocked on its round limit.

## Decision

An adapter classifies a completed empty response as a provider-boundary failure, and retry policy treats it as transient:

- `dsh-llm` exports the canonical code `EMPTY_RESPONSE_CODE` (`'EMPTY_RESPONSE'`) beside `CONTEXT_WINDOW_EXCEEDED_CODE`/`QUOTA_EXCEEDED_CODE`.
- `dsh-llm-pi-ai` (`mapStopReason`): a terminal `stop` whose assistant message has no content blocks becomes a `finish {kind: 'error'}` with that code. Context-overflow detection still wins where it applies (it is checked first and is the more actionable classification).
- `dsh-llm-deepseek` (`translate`): at `[DONE]`, a `stop` (or absent) finish with no opened blocks becomes the same error finish. Reasoning-only streams count as content and stay successful.
- `dsh-llm-retry` adds `EMPTY_RESPONSE` to `DEFAULT_RETRYABLE_CODES`: the attempt produced nothing durable, so repeating it is safe; deployments can still remove it via `retryableCodes`.

Detection is scoped to `stop` finishes only. `max-tokens` with empty content keeps its existing meaning (pi-ai already normalizes the zero-output overflow case), `tool-calls` cannot be block-empty in practice, and error/aborted finishes already fail.

The classification rides the existing loop machinery — `finishError` → `agent/request-error` → `dsh-llm-retry` — so no `agent-loop` change was needed, and after the retry budget exhausts, the turn fails loud with `EMPTY_RESPONSE` instead of silently completing empty.

## Alternatives considered

**Detect in the loop or `BlockAssembler`.** One shared implementation, but it moves provider-response judgment into the loop, against "plugins, not loop changes", and the assembler is a pure assembly algorithm. The adapter is where wire facts become harness classification, with the overflow reclassification as exact precedent.

**A stream-transform plugin on the `llm/stream` waterfall.** Provider-neutral and one implementation, but it adds a package plus wiring for what is a boundary fact each adapter can state in a few lines, and default-on behavior would still require touching every bundle.

**Treat whitespace-only or reasoning-only responses as empty too.** Rejected as overreach: those carry model-produced content, and misclassifying a legitimate (if useless) response as a transport-class failure risks retry loops on models that intentionally stop after reasoning. The scope is exactly "zero content blocks".

## Consequences

- A transiently misbehaving provider now costs a bounded retry instead of a silently wasted turn; a persistently empty model surfaces as a loud `EMPTY_RESPONSE` turn failure users can act on.
- A model that genuinely intends to say nothing (rare, but possible after a tool result) is now retried and, if consistently empty, fails the turn. This trade was accepted deliberately: an empty assistant message is indistinguishable from the provider defect and has no value to the user.
- The `empty-response-retry` ACP snapshot (an authored keyless scenario with a deterministic 1 ms zero-jitter retry overlay, `examples/acp-agent/retry.cordis.yml`) pins the product-visible arc: durable `llm/retry` event, the discarded-attempt marker, and a clean completed turn.
