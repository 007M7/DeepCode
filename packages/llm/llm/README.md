# dsh-llm

English | [中文](README.zh.md)

Provider-neutral LLM vocabulary and abstract service. This package defines the canonical language spoken by the agent loop, session logs, and every plugin.

## Service: `LlmService` (ctx key: `llm`)

An adapter registry plus a single streaming call surface, interceptable via a waterfall event.

### Public API

- `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): () => void` Register one adapter instance for the given provider routes. Registration is all-or-nothing, and is disposed with the calling fiber.
- `ctx.llm.listProviders(): LlmProviderInfo[]` Describe registered provider routes in registration order.
- `ctx.llm.listModels(provider: string): Promise<LlmModelInfo[]>` Discover the models one registered provider currently advertises.
- `ctx.llm.resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>` Resolve validated exact-model identity plus available context and reasoning metadata from the owning adapter, with optional cancellation for asynchronous adapters.
- `ctx.llm.resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>` Validate an explicit effort and materialize an adapter-configured default without clamping.
- `ctx.llm.prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>` Resolve a config and capture its current adapter registration as one cancellable, one-shot call.
- `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` Stream one model call as raw chunks (token-level deltas). Consumers assemble the chunks into blocks/messages with `BlockAssembler`.

`LlmService` preserves errors from final adapter selection, synchronous dispatch, iterator construction, and iteration, and binds their provenance to the exact stream handle returned for that model call. `isLlmAdapterFailure(stream, value)` reports only errors from that call's final adapter boundary; `llmFailureOf(stream, value)` returns the adjacent immutable `LlmFailure`. Nested model calls, `llm/stream` middleware, and downstream consumer failures remain unclassified for the outer call. Classification never replaces or mutates the adapter's original coded `Error`.

Provider and model metadata is a discovery surface, not a routing whitelist. `registerAdapter()` still owns provider exclusivity, while an adapter may accept model ids absent from `listModels()`; consumers must not reject a request because its model is unlisted. Returned metadata is detached and invalid or duplicate adapter entries fail with `INVALID_ADAPTER` or `INVALID_CATALOG`.

Exact-model metadata is a separate correctness query, not a catalog decoration or global LLM setting. `resolveModelInfo()` asks the adapter that owns the exact provider/model route once; an adapter can describe an unlisted dynamic model, and absent `context` or `reasoning` fields mean only that those capabilities are unavailable. Invalid identity, context, or reasoning metadata fails with `INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT`, or `INVALID_MODEL_REASONING`.

Reasoning identifiers are opaque adapter-owned strings rather than a core enum. An adapter publishes its ordered selectable list, including an `off` id when that model's capability API exposes one. `resolveCallConfig()` accepts only an exact advertised identifier, materializes `defaultEffort` when present, and otherwise preserves the provider default. Asynchronous model resolvers receive the caller's signal and must settle promptly after cancellation. `prepareCall()` additionally retains the exact adapter registration through header logging and terminal dispatch, so HMR cannot combine one adapter's capability result with another adapter's request; reusing its one-shot handle or changing its call-config fields fails with `INVALID_PREPARED_CALL`. An unsupported explicit or configured effort fails with `UNSUPPORTED_REASONING_EFFORT` before provider I/O.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `llm/stream` | waterfall | Intercept/wrap every streaming model call for caching, logging, or routing |

### Extension points

- Subclass `LlmAdapter` and call `ctx.llm.registerAdapter(providers, adapter)` to add one or more provider routes. `GenerateOptions.provider` selects the adapter; `GenerateOptions.model` is adapter-owned and may be resolved dynamically. Override `providerInfo()` and asynchronous `listModels()` to expose selector metadata, then implement `resolveModel()` when exact identity, capacity, or selectable reasoning efforts are available; an asynchronous resolver must honor its optional cancellation signal. The defaults use the route and model ids as names, advertise no models, and return no capacity or reasoning metadata.
- Wrap `llm/stream` via `ctx.on()` waterfall listeners for caching, logging, or routing. A wrapper that retries after emitting a chunk has no durable attempt boundary; shipped agent retry policy therefore uses `agent/request-error` instead.

### Content-block vocabulary (`types.ts`)

Messages are arrays of typed content blocks: `text`, `reasoning`, `tool-call`, `tool-result`. The union is derived from the merge-extensible `ContentBlockMap`, so plugins can add block types via declaration merging. Assistant messages produced by the loop also carry provider/model provenance and optional adapter-private replay state. Before dispatch, `LlmService` retains that state only when the historical provider route and target provider route are currently owned by the exact same adapter instance; the adapter then decides whether it can restore or convert the state across models/providers. The core block set is limited to blocks every shipping path honors — multimodal content (images, audio, …) has no core block type; a feature that needs one adds it via the map together with the adapter/UI/compaction support that honors it.

Streaming is a raw chunk protocol (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`). `BlockAssembler` is the single shared implementation that assembles chunks into blocks/messages.

### Call configuration (`call-config.ts`)

`LlmCallConfig` is the provider, model, optional adapter-owned reasoning effort, and sampling scalars of one conversation's requests (`provider`, `model`, `reasoningEffort`, `temperature`, `maxTokens`, `stop` — each mapping 1:1 onto the same-named `GenerateOptions` field). It is per-conversation state recorded in the session log as part of the request header (see the dsh-session `request/header` events), never a silently-adjustable per-call knob: the `agent/request` waterfall proposes a replacement, `prepareCall()` validates and defaults it under the turn signal, and the loop logs the effective value before using the prepared call's registration-bound stream. `callConfigEquals(a, b)` is the field-wise real-change detector; `deepFreeze(value)` is the ownership helper the loop applies to every built request before dispatch (`llm/stream` listeners and adapters read, never rewrite). `markAgentLoopRequest()` gives that exact object process-local loop provenance, and `isAgentLoopRequest()` lets observers distinguish it from independently logged auxiliary calls that may also be frozen and session-associated. `GenerateOptions.purpose` classifies logged auxiliary compaction and session-title calls so adapters can apply purpose-specific transport policy without changing ordinary conversation requests.

### App attribution (`attribution.ts`)

Every product adapter sends application identity on provider HTTP requests. `attributionHeaders(identity?)` builds the standard `User-Agent`, defaulting to public `APP_IDENTITY`; white-label deployments may replace but not suppress it. Adapters verify the wire header directly or through their library hook. See [the attribution Agent Note](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md).

### Classes

- `LlmAdapter` — abstract base class for provider adapters. The only required method is `stream()`.
- `BlockAssembler` — incrementally assembles raw chunks into complete content blocks and an assistant message. The agent loop feeds it raw chunks (logging them for replay) while reading the assembled blocks/message for history.
- `HarnessError` — base class for the harness error taxonomy: a stable `code` string (distinct from the human `message`) plus `cause` chaining. Lives here, in the leaf package every other imports, so a single base is shared without a new dependency edge. Per-package errors (`LlmError`, `ToolArgsError`, `InvariantError`, …) extend it. `isHarnessError(value)` narrows at seams.
- `LlmError` — extends `HarnessError`; its stable `code` string (`NO_ADAPTER`, `DUPLICATE_ADAPTER`, and adapter codes like `AUTH`/`RATE_LIMIT`) matches its frozen serializable `failure.code`. The payload may also retain validated status, `Retry-After`, and branded provider request id facts; policy remains outside the error.
- `errorChain(value)` — renders a thrown value with its full `cause` chain and AggregateError members for diagnostic surfaces (UI notices, logger lines, durable `turn/end` messages), so transport wrappers like undici's `TypeError: fetch failed` surface the underlying `ECONNREFUSED`/DNS/TLS detail instead of masking it. Rendering only — route on `code`, never by parsing the result.
- `CONTEXT_WINDOW_EXCEEDED_CODE` — the provider-neutral code both DeepSeek adapters use when a request exceeds the model context window, regardless of thrown-HTTP versus in-band finish delivery. `isContextWindowExceededError(detail)` is their shared conservative classifier for OpenAI-compatible provider detail.
- `QUOTA_EXCEEDED_CODE` — the non-transient provider-neutral code for exhausted account quota, balance, credits, budget, or usage limits. `isQuotaExceededError(detail)` keeps those failures distinct from request-rate limits.
- `EMPTY_RESPONSE_CODE` — the provider-neutral code both adapters use for a degenerate provider completion: a terminal `stop` that carried no content blocks at all. Classified as an error finish (not a successful empty message) because the attempt produced nothing durable; `dsh-llm-retry` retries it by default.

### Real adapters

Two adapters implement `LlmAdapter` on different internals: [`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) uses hand-rolled fetch/SSE for the `deepseek` route, while [`@deepseek-ai/dsh-llm-pi-ai`](../llm-pi-ai) dynamically resolves configured provider/model pairs through `@earendil-works/pi-ai`. Both follow the `StreamChunk` conventions in `types.ts`: usage precedes finish, tool arguments remain raw strings, and errors take one of two sanctioned paths. See [the twin LLM adapters](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) for the design rationale.

## Model Experience

None, as the service adds no model-bound text, schema, or message; it only materializes and logs an adapter-configured reasoning effort.

#### KV Cache effect

Pass-through; the registry preserves the assembled request prefix, while the selected adapter and provider own cache reuse and routing boundaries.

## Known Limitations and Deferred Work

- **No default retry/caching/rate-limit policy ships in this service** — `llm/stream` remains a single-attempt call-wrapper seam; the agent loop separately offers proven model-request failures to `agent/request-error`, whose default preserves the original failure. `@deepseek-ai/dsh-llm-retry` is an optional policy plugin loaded by the shared example spine.
- **`GenerateOptions` sampling is `temperature`/`maxTokens`/`stop` only** — no `tool_choice`, `top_p`, or penalty fields; the vocabulary grows when a producer lands ([dropped inert knobs](../../../.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md)).
- **Producer-gated variants stay out until produced** — `prefill`, per-tool `strict`, block `cache` hints, and the `agent` message-source variant were pruned as producerless ([Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)).
- **`BlockAssembler` handles core block kinds only** — a plugin-added block type whose stream is never closed by `block-end` makes `blocks()` throw.
- **`APP_IDENTITY.url` names a repository that does not exist yet** — `FIXME`: creating the public `deepseek-ai/deepseek-harness-sdk` repo gates the first release.
- **`GenerateOptions.sessionId` is a locally-declared brand** — importing dsh-session's `SessionId` would cycle; a future ids-owning package would dissolve the workaround.
