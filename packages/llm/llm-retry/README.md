# `@deepseek-ai/dsh-llm-retry`

Function plugin that retries selected transient model-request failures on the agent loop's closed-step recovery seam. It does not wrap `ctx.llm.stream()`: every adapter call remains one provider attempt, and every retry opens a fresh numbered step.

The default policy permits two retries for `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, using bounded exponential backoff from 500 ms to 10 seconds with 10 percent jitter. Delay bounds must fit Node's supported timer range. A valid `providerRetryAfterMs` replaces local backoff when it is within the configured cap; an over-cap instruction delegates to the next recovery policy instead.

Before waiting, the plugin appends a non-surface `llm/retry` event with the failure and scheduled delay. Cancellation and plugin disposal abort the wait; disposal drains the plugin's active backoffs, and a callback captured before disposal fails closed if invoked afterward.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
  config:
    maxTransientRetries: 2
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
    retryableCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

## Model Experience

### Transient request recovery

#### What the model sees

No retry event, delay, or failure prose is model-visible. After a retry, the next numbered step reconstructs the same explicit provider/model request from durable session history; failed chunks never enter derived messages.

#### Token effect

Each retry is a new provider request and may repeat input-token billing. The finite budget caps attempts; `llm/retry` itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for provider cache reuse under that provider's rules. The non-surface status event does not change cache identity.

## Known Limitations and Deferred Work

- **Agent steps are the only retry boundary** — direct `ctx.llm.stream()` consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.
- **Finite plugin budgets add** — this policy counts only configured transient codes; context-overflow compaction counts only its own code. A future policy with overlapping codes must document and test registration-order behavior.
- **`llm/retry` records scheduling, not completion** — later step and turn events establish success, exhaustion, or cancellation.
