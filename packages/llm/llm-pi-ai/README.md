# @deepseek-ai/dsh-llm-pi-ai

DeepSeek adapter for the harness LLM seam backed by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (the LLM library behind the pi agent).

## Why a second adapter exists

`@deepseek-ai/dsh-llm-deepseek` already talks to the same endpoint. This package is its **design-verification twin**: same models, same wire protocol, completely different internals — a unified LLM library with its own event vocabulary versus hand-rolled fetch/SSE. Anything the harness `StreamChunk` protocol cannot express for BOTH implementations is a core-vocabulary bug. The differences it exercised on purpose:

- pi-ai hands tool-call `arguments` around as **parsed objects**; the harness keeps raw JSON strings. The adapter patches replay payloads back to the original raw strings before sending them, and re-stringifies parsed output tool calls at `block-end`.
- pi-ai reports failures as **in-stream error events** (it never throws mid-stream); these map to `finish {kind:'error'|'aborted'}` chunks — the protocol's other sanctioned error path besides throwing (which llm-deepseek uses).
- pi-ai folds reasoning tokens into `usage.output`; there is no separate reasoning count to map.
- pi-ai's options omit some DeepSeek/OpenAI-compatible details; the adapter uses its `onPayload` hook to preserve the harness contract (`stop`, scrubbing pi-ai's own per-tool `strict` default — the hand-rolled twin sends no such field — omitted reasoning effort, raw replayed tool arguments).

## Config

Same shape as llm-deepseek (one-line swap in cordis.yml), with pi-ai's thinking-level vocabulary:

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    baseURL: !!js process.env.DEEPSEEK_BASE_URL
    models: [deepseek-v4-flash, deepseek-v4-pro]
    reasoning: high   # off | high | xhigh (xhigh → wire 'max')
```

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()`, passed through pi-ai's `headers` stream option (pi-ai merges caller headers last, so it always reaches the wire - the unit suite asserts arrival on the mock server, same as llm-deepseek). OpenRouter-specific app attribution headers are intentionally not sent by this adapter contract; they are deferred to a future explicit OpenRouter adapter or mode. See [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts).

## Dependency weight

pi-ai declares the openai/anthropic/google/mistral/AWS SDKs as install-time dependencies. They are lazy-loaded — only the openai SDK actually loads for this adapter — but they do land in `node_modules`. Accepted for a package whose purpose is design verification.

## Limitations

Same MVP contract as llm-deepseek: `tool_choice` is not mapped.

## Testing

Unit suites run against a local `node:http` mock SSE server (pi-ai's openai SDK happily talks to any base URL). Real-API coverage in `tests/adapter.e2e.ts` (`pnpm run test:e2e`, key-gated): V4 Flash + V4 Pro across all exposed reasoning levels (off/high/xhigh), the thinking+tools round trip, and a cross-adapter structural-equivalence check against llm-deepseek.
