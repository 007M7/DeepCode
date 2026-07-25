# Agent Note: Per-provider request retry policies

Status: implemented

English | [中文](2026-07-24-provider-retry-policies.zh.md)

## Problem

One process may route model requests to providers with different reliability and cost constraints. A single transient classifier and finite retry budget cannot express a deployment that wants bounded recovery for most providers but requires one provider to keep retrying every model-request failure until the request succeeds or the caller cancels it.

Provider policy must follow the request that actually failed, including a route selected by `agent/request`, rather than the agent's initial options. Unbounded policy also cannot store JavaScript `Infinity` in the durable session event, and neither provider error text nor discarded partial output may enter the next model request.

## Decision

Each concrete adapter accepts an optional `retryPolicy` inside its provider configuration. The adapter validates and resolves the policy, and `ctx.llm` captures it when that exact provider route registers. `@deepseek-ai/dsh-llm-retry` reads the registered policy for the provider whose step failed. A provider without `retryPolicy` uses the normal defaults.

```yaml
providers:
  - provider: deepseek
    retryPolicy:
      mode: normal
      maxRetries: 2
      retryableCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
  - provider: internal
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2
```

The listener selects the policy from the durable `request/header` in force when the failed step closed, excluding later recovery mutations. Normal mode retains the bounded transient behavior: it retries configured codes up to `maxRetries`, counts retries scheduled by the same provider policy in the current consecutive failure sequence, and otherwise delegates.

Always mode asks downstream recovery first so a specialized policy such as context-overflow compaction can make progress. A downstream retry wins. A downstream failure decision or thrown recovery error falls back to an unbounded retry of the same provider request; the thrown error is logged. Success, turn cancellation, and plugin disposal are the only termination paths.

Both modes use exponential local delays from `initialDelayMs` to `maxDelayMs`. `jitterRatio` multiplies each target by a uniform sample in `[1 - jitterRatio, 1 + jitterRatio]`, then applies the cap. A positive provider `Retry-After` within the cap remains exact and unjittered. An over-cap provider delay makes normal mode delegate; always mode retains its guarantee by using the configured local backoff.

Each scheduled retry appends a non-surface `llm/retry` event with the failed provider, policy mode, provider-policy retry number, delay, and failure facts. Normal events carry finite `maxRetries`; always events omit it, and UIs render the limit as `∞`. The event and failed `assistant/chunk` records do not contribute surface messages, so the next request contains the same derived context as the failed request unless another recovery policy deliberately changes the surface.

## Alternatives considered

**One global `always` switch** — rejected because it cannot isolate the unbounded cost and latency risk to the provider that needs it and can silently apply after runtime rerouting.

**A separate exact-provider list on `dsh-llm-retry`** — rejected because it duplicates provider route names outside their owning adapter configuration and lets provider registration drift from recovery policy.

**A very large finite retry count** — rejected because it eventually violates the requested keep-retrying contract and serializes an arbitrary operational limit as if it were meaningful.

**Provider-SDK retries** — rejected because hidden attempts multiply agent-level budgets, cannot use the closed-step durability boundary, and may splice or discard streamed output without a reconstructable retry record.

**Put the error into model context** — rejected because a transport or provider diagnostic is operational state, not conversation content. It can expose sensitive provider details and changes the retried request instead of repeating the failed request.

## Verification

Adapter tests validate nested policies at provider load and prove registration captures configured and default policies. Unit and real-Loader composition tests select policies from the failed request's provider, exercise always mode beyond the normal budget, pin jitter and delay caps, prove downstream recovery ordering, prove cancellation interrupts stalled downstream recovery, and prove cancellation and disposal stop active backoff waits. Request-level coverage compares the complete messages of failed and retried attempts and rejects both provider error text and discarded partial output. JSONL and SQLite tests round-trip an always event without `Infinity`; invariant tests bind its provider to the request header and its retry number to the active provider policy; ACP and TUI tests render finite and infinite limits.

## Consequences

Normal mode remains a finite default, while an explicit always policy can spend unbounded requests and time on permanent authentication, quota, invalid-request, protocol, or context failures. Operators must pair always mode with a cancellable caller and provider-specific cost controls. Retry state stays observable and durable without becoming model-visible, and exact-provider selection keeps one provider's exceptional policy from changing another provider's recovery behavior.

This decision extends the closed-step recovery, single visible adapter attempt, structured failure, and durable status design in [bounded recovery for transient LLM request failures](../architecture/2026-06-21-bounded-llm-request-recovery.md).
