# @deepseek-ai/dsh-llm-deepseek

DeepSeek chat-completions adapter for the harness LLM seam: hand-rolled `fetch` + SSE translation from the official wire format (source of truth: the API docs — guides/thinking_mode, guides/tool_calls, api/create-chat-completion) into the `StreamChunk` protocol.

A second, library-backed implementation of the same seam exists in `@deepseek-ai/dsh-llm-pi-ai`. This package always owns the `deepseek` provider route; mounting a pi-ai profile with `provider: deepseek` in the same context throws `LlmError('DUPLICATE_ADAPTER')` by design.

The package root exposes the Cordis plugin contract and `DeepSeekAdapter`; wire serialization, SSE parsing, and chunk translation helpers are not part of that root contract.

## Config

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY    # or rely on the env fallback
    baseURL: !!js process.env.DEEPSEEK_BASE_URL  # default: https://api.deepseek.com
    thinking: enabled        # optional; provider default is enabled
    reasoningEffort: high    # optional; high | max — omitted ⇒ not sent
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    models:                  # optional; defaults to V4 Flash and V4 Pro
      - id: deepseek-v4-flash
        name: DeepSeek V4 Flash
        contextWindow: 128000
      - id: private-reasoner
        description: Company-hosted reasoning model
        contextWindow: 64000
```

The plugin registers the single provider route `deepseek`. A request selects it with `provider: deepseek`; its `model` is passed through as the wire `model` string, so changing DeepSeek models does not require lifecycle-time registration. Omitting `models` advertises `deepseek-v4-flash` and `deepseek-v4-pro`, each with a 128,000-token context window; an explicit list replaces those defaults, while `models: []` advertises none. Catalog entries are exposed through `ctx.llm.listModels('deepseek')` for clients such as ACP editors, but remain advisory: unlisted model ids still pass through unchanged. An omitted entry name defaults to its id.

`contextWindow` is optional per configured model and is not exposed through the advisory catalog. `ctx.llm.resolveModelContext('deepseek', model)` returns it only for an exact configured id; omission or an unlisted pass-through model returns `undefined` without invalidating routing. Pressure-sensitive plugins therefore get deployment-owned capacity without treating the model selector as authoritative. Registering another adapter for `deepseek` throws `LlmError('DUPLICATE_ADAPTER')`.

`reasoningEffort` is **omitted by default** — when unset, the `reasoning_effort` wire field is not sent and the server applies its own default for the model. The only accepted values are `high` and `max` (DeepSeek's official effort levels). It is meaningful only with thinking enabled (the provider default).

`thinking`/`reasoningEffort` are adapter-level request defaults serialized as the official top-level `thinking: {type}` / `reasoning_effort` wire fields. They live in adapter config (not `GenerateOptions`) to keep the core vocabulary provider-neutral. A request with `GenerateOptions.purpose: 'session-title'` forces thinking disabled and omits `reasoning_effort`, reserving its bounded output for visible title text without changing conversation or compaction defaults.

`streamIdleTimeoutMs` bounds each outstanding provider read, including the initial `fetch`, without counting time the consumer spends between chunks. One stable abort signal reaches the request and body reader for the whole call; expiry stops the transport and throws `LlmError('TIMEOUT')`, while an earlier caller abort throws `LlmError('ABORTED')`. The adapter makes exactly one provider request per `stream()` call; agent-level retry is a separate plugin policy.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` - the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). Direct DeepSeek requests and OpenAI-compatible gateway requests get no provider-specific app-attribution headers under this adapter contract; OpenRouter app attribution is deferred to a future explicit OpenRouter adapter or mode. A request whose `GenerateOptions.purpose` is `compaction` (dsh-compact-basic's auxiliary summarization call) additionally carries `x-deepseek-harness-compact: 1`, so the host can separate compaction traffic from conversation requests.

## Wire-format notes (verified live + against the official docs)

- Streaming only (`stream_options.include_usage` always on). `usage` may arrive attached to the finish chunk or as a trailing usage-only chunk — the translator defers both to `[DONE]`, so `usage` always precedes `finish` and nothing follows `finish`.
- The first thinking-mode chunk carries `reasoning_content: ""` — handled (no spurious reasoning block).
- **Reasoning passback rule**: on assistant turns that carried tool calls, `reasoning_content` is serialized back in history (required by the API in thinking mode); on tool-call-free turns it is dropped (ignored anyway — saves tokens).
- Cache accounting: `cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`; DeepSeek reports no cache-write metric.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `QUOTA` (a response whose provider details identify exhausted quota, balance, or credits), `RATE_LIMIT` (other 429s), `CONTEXT_WINDOW_EXCEEDED` (a 400 whose provider code, type, or message identifies context overflow), `INVALID_REQUEST` (other 400s), `SERVER` (5xx), `HTTP_<status>` otherwise. Its serializable `failure` retains the HTTP status plus a valid positive `Retry-After` seconds/date delay and `x-request-id` / `x-deepseek-request-id` when present. A pre-response transport failure (DNS, refused connection, TLS, proxy) throws `TRANSPORT` naming the configured endpoint and chaining the original rejection as `cause`; caller aborts throw `ABORTED`, and the loop's cancellation signal remains authoritative. Protocol violations throw `STREAM_CLOSED` (no `[DONE]`) or `MALFORMED_RESPONSE` (bad JSON payload). Unknown wire `finish_reason`s (e.g. `content_filter`, `insufficient_system_resource`) become `finish {kind: 'error', failure}` chunks.

## Testing

Unit suites run against a local `node:http` mock SSE server (no network), including structured HTTP facts, malformed/truncated streams, caller abort, connection failure, and proof that idle timeout aborts the actual body. Real-API coverage lives in `tests/adapter.e2e.ts` (`pnpm run test:e2e`, key-gated): V4 Flash + V4 Pro across thinking enabled/disabled and both official effort levels, including the thinking+tools round trip with reasoning passback.

## Model Experience

### DeepSeek request

#### What the model sees

The selected DeepSeek model receives the harness system prompt, message history, tool schemas, stop sequences, and call config without adapter-authored prompt prose. On a prior assistant turn with tool calls, its reasoning content is passed back as required; reasoning from tool-call-free turns is omitted.

#### Token effect

Provider tokenization governs exact input. Conditional reasoning passback increases tool-round-trip context, while dropping other reasoning avoids paying those tokens again; cache-read usage is reported when available.

#### KV Cache effect

An unchanged assembled prefix is eligible for DeepSeek cache reuse, which this adapter reports in usage. A model-route change or any upstream prompt, schema, prefix, or history change may prevent reuse from the first changed token; reasoning passback appends during tool round trips.

### DeepSeek response

#### What the model sees

Reasoning, text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble.

#### Token effect

Generated tokens follow provider thinking and effort settings plus the request's `maxTokens`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- **`tool_choice` is not mapped** — not part of the core vocabulary (MVP cut, shared with the pi-ai twin).
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).
- **Serialization flattens user and tool-result content to text blocks** — plugin-added block types are skipped, and empty tool output crosses the wire as the literal `(no output)`.
