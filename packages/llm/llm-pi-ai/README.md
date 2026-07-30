# @deepseek-ai/dsh-llm-pi-ai

English | [中文](README.zh.md)

Generic multi-provider adapter for the harness LLM seam backed by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai). One plugin instance owns a dict of provider profiles keyed by route; every request selects a profile with `GenerateOptions.provider` and resolves `GenerateOptions.model` dynamically from pi-ai's installed catalog.

The package root exposes the Cordis plugin contract and `PiAiAdapter`; profile resolution, model construction, replay conversion, and stream conversion remain package-internal.

## Config

Configure credentials and deployment-specific transport settings per provider, keyed by the provider route itself. Prefer `apiKeyEnv` — a credential *reference* resolved per request — over a literal `apiKey`, so no secret enters this file. Omitting **both** is what delegates authentication to pi-ai's provider-native ambient discovery; a configured reference that resolves to nothing fails the request with `MISSING_CREDENTIAL` instead, because falling through would authenticate with whatever unrelated key the environment happens to hold. `baseURL` overrides only the endpoint of the selected catalog model, preserving its API family and compatibility metadata, so private proxies such as `https://proxy.example.com:8443` remain supported.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        headers:
          X-Deployment: production
```

Each dict key must exist in pi-ai's installed catalog; the dict shape makes duplicates unrepresentable, and the pre-release array shape (with per-profile `provider` fields) fails load with migration directions. Composition must provide at least one route. Registration with `ctx.llm` is all-or-nothing: a collision with any route already owned by another adapter fails plugin loading without registering the remaining routes. Model ids are not lifecycle config; an unknown model fails before any provider request with `LlmError('UNKNOWN_MODEL')`.

## Dynamic configuration (settings + credentials)

The adapter reads live connection, credential, and request-transport facts through a thunk once per stream. The plugin registers the `llm-pi-ai` namespace on the optional `ctx.settings` seam with this same `Config` schema and its `cordis.yml` entry as the composition `base`. The user layer can override a composition route's endpoint, credential reference, headers, budgets, cache/transport choices, and timeouts for the next request. Provider routes, installed model capabilities, reasoning defaults, and retry policies remain composition-fixed; a settings snapshot that changes a fixed fact is rejected as one generation. Without a mounted settings service the entry config alone drives the adapter.

Credentials resolve per stream call: a non-empty literal `apiKey` wins, then `apiKeyEnv` through the optional `ctx.credentials` seam (`$DSH_HOME/.env` under the live environment; exactly that variable without a mounted seam). A profile naming no credential at all — and only that case — defers to pi-ai's ambient discovery. A live settings snapshot that changes a fixed fact, names an unknown provider, or fails another resolver bound keeps the last good profiles and logs the failure; none of its connection or credential facts leak into a request. The entry config itself fails plugin load.

The adapter exposes each configured provider's installed pi-ai models through `ctx.llm.listModels(provider)`. This is provider-neutral selector metadata derived from `getModels(provider)`; request-time resolution still performs the authoritative catalog lookup, so discovery does not create a second model registry. `ctx.llm.resolveModelInfo(provider, model)` performs that exact descriptor lookup once and returns its identity, context window, and selectable thinking levels, keeping authoritative metadata on the route-owning adapter rather than its consumers.

The `reasoning.efforts` list is pi-ai's ordered `getSupportedThinkingLevels(model)` result without filtering or normalization, including `off` and the model-specific availability of `xhigh` or `max`. The Harness exposes each canonical pi-ai level as an opaque ID; provider/model wire spellings remain inside pi-ai's `thinkingLevelMap`. A non-reasoning model therefore exposes pi-ai's `off` choice. The composition profile's `reasoning` value, including `off`, is the deployment default when configured; omitting it preserves the provider default. Per-request `GenerateOptions.reasoningEffort` takes precedence, and any explicit value absent from the exact model capability fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O instead of being clamped. pi-ai's common stream options represent `off` by omitting `reasoning`.

Supported profile fields are `apiKey`, `apiKeyEnv`, `baseURL`, `headers`, `reasoning`, `thinkingBudgets`, `cacheRetention`, `transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `streamIdleTimeoutMs`, and `retryPolicy`. `reasoning` and `retryPolicy` are composition facts; the other fields are live request facts. Each optional retry policy is captured with its provider route, and omission uses bounded normal defaults. The stream-idle interval is a positive finite Node timer delay, defaults to five minutes, and covers only an outstanding provider read, not consumer think time. Harness app attribution wins a conflicting configured header name.

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

Unit tests use pi-ai catalog models redirected to local mock servers and cover provider/profile routing, one wire request per adapter call, idle-timeout response termination, caller abort, native API selection, endpoint overrides, attribution, conversion, replay-state validation, and cross-provider/model replay within one adapter instance. `tests/dynamic-config.spec.ts` drives real settings-local and credentials-local providers: endpoint and credential changes reach later requests, while a change landing between capability resolution and dispatch cannot combine an earlier reasoning default with a newer endpoint or key. `tests/loader-composition.spec.ts` boots that chain from a test-only `cordis.yml` through the actual Loader and edits `settings.yaml`/`.env` on disk. Real-API coverage remains key-gated under `pnpm run test:e2e`.

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

- **Settings cannot change routes or model defaults** — provider ownership, installed model capabilities, reasoning defaults, and retry policy are composition facts; the user layer can only change connection, credential, and request-transport fields of existing routes.
- **`apiKey` is schema-tagged `role('secret')` but not masked by `ctx.settings.describe()`** — do not expose that envelope to an untrusted UI without redacting secret-role fields.
- **Catalog membership is required** — custom model ids that are absent from the installed pi-ai catalog fail with `UNKNOWN_MODEL`, even when a provider profile supplies a custom endpoint.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers, so the adapter rejects the field.
- **In-history `system` messages use pi-ai's common context conversion** — provider-specific placement follows pi-ai rather than a harness-owned wire override.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers; failures expose only stable harness error codes.
- **Retry policy is provider-owned, not an SDK retry** — each provider profile may configure nested `retryPolicy`, which `dsh-llm-retry` executes at the agent failed-step seam; pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.
