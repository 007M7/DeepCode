# `@deepseek-ai/dsh-llm-retry`

English | [中文](README.zh.md)

Function plugin that retries selected transient model-request failures through the `agent/request-error` waterfall. It does not wrap `ctx.llm.stream()`: every adapter call remains one provider attempt, and every retry opens a fresh numbered turn.

The default policy permits two retries for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, using bounded exponential backoff from 500 ms to 10 seconds with 10 percent jitter. `EMPTY_RESPONSE` is the adapters' classification of a degenerate provider completion (a terminal stop with zero content blocks); the attempt produced nothing durable, so repeating it is safe. Delay bounds must fit Node's supported timer range. A valid `providerRetryAfterMs` replaces local backoff when it is within the configured cap; an over-cap instruction delegates to the next recovery policy instead.

The recovery listener appends a non-surface `llm/retry` event after the failed step, waits for the backoff while the failed turn's signal remains live, then returns `{ kind: 'retry' }`. The loop closes that failed turn and opens a retry turn over the same durable history. The policy keeps its own retry count across that uninterrupted recovery chain and clears it at terminal `agent/settled`. Turn cancellation and plugin disposal abort the wait.

The separately published `./invariant` companion checks that every retry record appears inside an open turn after its failed step, matches its position in the current retry chain, and carries a positive bounded retry budget and non-negative bounded timer delay. Full jitter may schedule zero milliseconds at its lower boundary.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
  config:
    maxTransientRetries: 2
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

## Model Experience

### Transient request recovery

#### What the model sees

No retry event, delay, or failure prose is model-visible. The retry turn reconstructs the same explicit provider/model request from durable session history; failed chunks never enter derived messages.

#### Token effect

Each retry is a new provider request and may repeat input-token billing. The finite budget caps attempts; `llm/retry` itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for provider cache reuse under that provider's rules. The non-surface status event does not change cache identity.

## Known Limitations and Deferred Work

- **Agent turns are the only retry boundary** — direct `ctx.llm.stream()` consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.
- **Finite plugin budgets add** — this policy counts only configured transient codes; context-overflow compaction counts only its own code. A future policy with overlapping codes must document and test registration-order behavior.
- **`llm/retry` records completed backoff, not request completion** — later step and turn events establish success, exhaustion, or cancellation.
