# @deepseek-ai/dsh-llm-pi-ai

DeepSeek adapter for the harness LLM seam backed by
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
(the LLM library behind the pi agent).

## Why a second adapter exists

`@deepseek-ai/dsh-llm-deepseek` already talks to the same endpoint. This
package is its **design-verification twin**: same models, same wire
protocol, completely different internals — a unified LLM library with its
own event vocabulary versus hand-rolled fetch/SSE. Anything the harness
`StreamChunk` protocol cannot express for BOTH implementations is a
core-vocabulary bug. The differences it exercised on purpose:

- pi-ai hands back tool-call `arguments` as **parsed objects**; the harness
  keeps raw JSON strings (re-stringified at `block-end`).
- pi-ai reports failures as **in-stream error events** (it never throws
  mid-stream); these map to `finish {kind:'error'|'aborted'}` chunks — the
  protocol's other sanctioned error path besides throwing (which
  llm-deepseek uses).
- pi-ai folds reasoning tokens into `usage.output`; there is no separate
  reasoning count to map.
- pi-ai's options omit stop sequences; `GenerateOptions.stop` is injected
  via its `onPayload` hook.

## Config

Same shape as llm-deepseek (one-line swap in cordis.yml), with pi-ai's
thinking-level vocabulary:

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    baseURL: !!js process.env.DEEPSEEK_BASE_URL
    models: [deepseek-v4-flash, deepseek-v4-pro]
    reasoning: high   # off | high | xhigh (xhigh → wire 'max')
```

## Dependency weight

pi-ai declares the openai/anthropic/google/mistral/AWS SDKs as install-time
dependencies. They are lazy-loaded — only the openai SDK actually loads for
this adapter — but they do land in `node_modules`. Accepted for a package
whose purpose is design verification.

## Limitations

Same MVP contract as llm-deepseek: `prefill` throws `UNSUPPORTED`, images
are not representable, `tool_choice` is not mapped.

## Testing

Unit suites run against a local `node:http` mock SSE server (pi-ai's openai
SDK happily talks to any base URL). Real-API coverage in
`tests/adapter.e2e.ts` (`yarn test:e2e`, key-gated): V4 Flash + V4 Pro across
all exposed reasoning levels (off/high/xhigh), the thinking+tools round trip,
and a cross-adapter structural-equivalence check against llm-deepseek.
