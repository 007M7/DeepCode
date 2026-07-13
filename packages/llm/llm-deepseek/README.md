# @deepseek-ai/dsh-llm-deepseek

DeepSeek chat-completions adapter for the harness LLM seam: hand-rolled `fetch` + SSE translation from the official wire format (source of truth: the API docs — guides/thinking_mode, guides/tool_calls, api/create-chat-completion) into the `StreamChunk` protocol.

A second, independent implementation of the same seam exists in `@deepseek-ai/dsh-llm-pi-ai` (library-backed). Same Config shape — pick one per context (registering both for the same model names throws by design).

## Config

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY    # or rely on the env fallback
    baseURL: !!js process.env.DEEPSEEK_BASE_URL  # default: https://api.deepseek.com
    models: [deepseek-v4-flash, deepseek-v4-pro] # one adapter, registered for each name
    thinking: enabled        # optional; provider default is enabled
    reasoningEffort: high    # optional; high | max — omitted ⇒ not sent
```

`models` lists every model name this one adapter instance serves: the adapter registers itself for each (the harness model name IS the wire `model` string), so a `generate`/`stream` call routes to it whenever `options.model` is any of them. Registering a second adapter for a name already taken throws `LlmError('DUPLICATE_ADAPTER')` (the LLM service enforces one adapter per model, all-or-nothing).

`reasoningEffort` is **omitted by default** — when unset, the `reasoning_effort` wire field is not sent and the server applies its own default for the model. The only accepted values are `high` and `max` (DeepSeek's official effort levels). It is meaningful only with thinking enabled (the provider default).

`thinking`/`reasoningEffort` are adapter-level request defaults serialized as the official top-level `thinking: {type}` / `reasoning_effort` wire fields. They live in adapter config (not `GenerateOptions`) to keep the core vocabulary provider-neutral.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` - the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). Direct DeepSeek requests and OpenAI-compatible gateway requests get no provider-specific app-attribution headers under this adapter contract; OpenRouter app attribution is deferred to a future explicit OpenRouter adapter or mode.

## Wire-format notes (verified live + against the official docs)

- Streaming only (`stream_options.include_usage` always on). `usage` may arrive attached to the finish chunk or as a trailing usage-only chunk — the translator defers both to `[DONE]`, so `usage` always precedes `finish` and nothing follows `finish`.
- The first thinking-mode chunk carries `reasoning_content: ""` — handled (no spurious reasoning block).
- **Reasoning passback rule**: on assistant turns that carried tool calls, `reasoning_content` is serialized back in history (required by the API in thinking mode); on tool-call-free turns it is dropped (ignored anyway — saves tokens).
- Cache accounting: `cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`; DeepSeek reports no cache-write metric.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `RATE_LIMIT` (429), `INVALID_REQUEST` (400), `SERVER` (5xx), `HTTP_<status>` otherwise. Protocol violations throw `STREAM_CLOSED` (no `[DONE]`) or `MALFORMED_RESPONSE` (bad JSON payload). Unknown wire `finish_reason`s (e.g. `content_filter`, `insufficient_system_resource`) become `finish {kind: 'error', code: <REASON>}` chunks.

## Testing

Unit suites run against a local `node:http` mock SSE server (no network). Real-API coverage lives in `tests/adapter.e2e.ts` (`pnpm run test:e2e`, key-gated): V4 Flash + V4 Pro across thinking enabled/disabled and both official effort levels, including the thinking+tools round trip with reasoning passback.

## Model Experience

### DeepSeek request

**What the model sees**: The selected DeepSeek model receives the harness system prompt, message history, tool schemas, stop sequences, and call config without adapter-authored prompt prose. On a prior assistant turn with tool calls, its reasoning content is passed back as required; reasoning from tool-call-free turns is omitted.

**Token effect**: Provider tokenization governs exact input. Conditional reasoning passback increases tool-round-trip context, while dropping other reasoning avoids paying those tokens again; cache-read usage is reported when available.

### DeepSeek response

**What the model sees**: Reasoning, text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble.

**Token effect**: Generated tokens follow provider thinking and effort settings plus the request's `maxTokens`; only loop-retained blocks affect later input.

## Known Limitations and Deferred Work

- **`tool_choice` is not mapped** — not part of the core vocabulary (MVP cut, shared with the pi-ai twin).
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).
- **Serialization flattens user and tool-result content to text blocks** — plugin-added block types are skipped, and empty tool output crosses the wire as the literal `(no output)`.
