# @deepseek-ai/dsh-llm-pi-ai

English | [中文](README.zh.md)

Generic multi-provider adapter for the harness LLM seam backed by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai). One plugin instance owns an explicit list of provider profiles; every request selects a profile with `GenerateOptions.provider` and resolves `GenerateOptions.model` dynamically from pi-ai's installed catalog.

The package root exposes the Cordis plugin contract and `PiAiAdapter`; profile resolution, model construction, replay conversion, and stream conversion remain package-internal.

## Config

Configure credentials and deployment-specific transport settings per provider. Omitting `apiKey` delegates authentication to pi-ai's provider-native ambient discovery. `baseURL` overrides only the endpoint of the selected catalog model, preserving its API family and compatibility metadata, so private proxies such as `https://proxy.example.com:8443` remain supported.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      - provider: openai
        apiKey: !!js process.env.OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      - provider: anthropic
        apiKey: !!js process.env.ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
      - provider: openrouter
        apiKey: !!js process.env.OPENROUTER_API_KEY
        headers:
          X-Deployment: production
```

Each provider name must exist in pi-ai's installed catalog and may appear only once in this plugin instance. Registration with `ctx.llm` is atomic: a collision with any provider route already owned by another adapter fails plugin loading without registering the remaining routes. Model ids are not lifecycle config; an unknown model fails before any provider request with `LlmError('UNKNOWN_MODEL')`.

The adapter exposes each configured provider's installed pi-ai models through `ctx.llm.listModels(provider)`. This is provider-neutral selector metadata derived from `getModels(provider)`; request-time resolution still performs the authoritative catalog lookup, so discovery does not create a second model registry. `ctx.llm.resolveModelInfo(provider, model)` performs that exact descriptor lookup once and returns its identity, context window, and selectable thinking levels, keeping authoritative metadata on the route-owning adapter rather than its consumers.

The `reasoning.efforts` list is pi-ai's ordered `getSupportedThinkingLevels(model)` result without filtering or normalization, including `off` and the model-specific availability of `xhigh` or `max`. The Harness exposes each canonical pi-ai level as an opaque ID; provider/model wire spellings remain inside pi-ai's `thinkingLevelMap`. A non-reasoning model therefore exposes pi-ai's `off` choice. The profile `reasoning` value, including `off`, is the deployment default when configured; omitting it preserves the provider default. Per-request `GenerateOptions.reasoningEffort` takes precedence, and any explicit value absent from the exact model capability fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O instead of being clamped. pi-ai's common stream options represent `off` by omitting `reasoning`.

Supported profile fields are `provider`, `apiKey`, `baseURL`, `headers`, `reasoning`, `thinkingBudgets`, `cacheRetention`, `transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `streamIdleTimeoutMs`, and `retryPolicy`. Each profile's optional retry policy is captured with that provider route; omission uses bounded normal defaults. The stream-idle interval is a positive finite Node timer delay, defaults to five minutes, and covers only an outstanding provider read, not consumer think time. Harness app attribution wins a conflicting configured header name.

The adapter forces pi-ai's SDK `maxRetries` to zero so one `stream()` call makes one provider request. The removed profile fields `maxRetries` and `maxRetryDelayMs` fail load instead of silently multiplying or hiding the separately composed agent-level retry budget. Idle expiry aborts the SDK's stable request signal and surfaces `TIMEOUT`; an earlier caller abort remains `ABORTED`.

## Provider/model routing and replay

The selected pi-ai catalog descriptor supplies the protocol implementation. This includes native API differences such as OpenAI models whose descriptor uses the Responses API rather than Chat Completions; the harness adapter does not hardcode endpoint selection by model name.

Successful assistant responses store a versioned, lossless-JSON replay state beside their durable provider/model provenance. At request time, `LlmService` passes replay state only when the historical provider route and target provider route are currently owned by this same `PiAiAdapter` instance. The adapter validates the state and restores pi-ai response ids and provider signatures even when the target provider or model changes; pi-ai then decides which metadata its target API can reuse. History without replay state is translated as foreign provider-neutral content and never impersonates a native pi-ai response.

If a listener rewrites assembled assistant content, the loop drops replay state before logging the message because its provider metadata no longer describes the content. Invalid versions, malformed metadata, provenance provider/model mismatches, and content/block mismatches fail explicitly with `LlmError('INVALID_REPLAY_STATE')`.

## Vocabulary differences

- pi-ai tool-call arguments are parsed objects; the harness stores raw JSON strings. The adapter parses input and re-stringifies output.
- pi-ai reports failures as in-stream error events; these map to `finish {kind:'error'|'aborted', failure}` chunks. Provider-specific error text distinguishes terminal `QUOTA` from transient `RATE_LIMIT`, while text and usage signals evaluated against the resolved model's context window normalize overflow to `CONTEXT_WINDOW_EXCEEDED`. A terminal `stop` whose message carries no content blocks maps to a `finish {kind:'error'}` with code `EMPTY_RESPONSE` (retried by default policy) instead of a successful empty message.
- pi-ai folds reasoning tokens into output usage; there is no separate reasoning count to map.
- pi-ai's `off` thinking level crosses the Harness capability seam unchanged and becomes an omitted pi-ai common `reasoning` option at dispatch.
- `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION` because pi-ai's common streaming surface cannot guarantee it across providers.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()`, merged through pi-ai's `headers` stream option. Provider-specific app-attribution headers are not synthesized. See [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts).

## Dependency weight

pi-ai installs several provider SDKs and lazy-loads the one selected by the catalog model. The dependency weight is isolated to this opt-in adapter package.

## Testing

Unit tests use pi-ai catalog models redirected to local mock servers and cover provider/profile routing, one wire request per adapter call, idle-timeout response termination, caller abort, native API selection, endpoint overrides, attribution, conversion, replay-state validation, and cross-provider/model replay within one adapter instance. Real-API coverage remains key-gated under `pnpm run test:e2e`.

## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected catalog model receives `GenerateOptions.system`, history, tools, and sampling fields supported by pi-ai's common streaming API. This package adds no prompt prose. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

Provider tokenization governs exact input. Conversion adds no model-visible text; replay metadata may let a native API reuse provider-side state.

#### KV Cache effect

Conversion preserves logical request order without adding text, while the selected provider's serialization and replay state determine reuse. Changing adapter instance, provider, model, or any upstream request token may prevent reuse from the first difference.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. Parsed tool arguments cross the harness boundary as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage when the provider does not report them separately.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

- **Catalog membership is required** — custom model ids that are absent from the installed pi-ai catalog fail with `UNKNOWN_MODEL`, even when a provider profile supplies a custom endpoint.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers, so the adapter rejects the field.
- **In-history `system` messages use pi-ai's common context conversion** — provider-specific placement follows pi-ai rather than a harness-owned wire override.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers; failures expose only stable harness error codes.
- **Retry policy is provider-owned, not an SDK retry** — each provider profile may configure nested `retryPolicy`, which `dsh-llm-retry` executes at the agent failed-step seam; pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.
