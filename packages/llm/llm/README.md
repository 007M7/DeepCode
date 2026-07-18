# dsh-llm

Provider-neutral LLM vocabulary and abstract service. This package defines the canonical language spoken by the agent loop, session logs, and every plugin.

## Service: `LlmService` (ctx key: `llm`)

An adapter registry plus a single streaming call surface, interceptable via a waterfall event.

### Public API

- `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): () => void` Register one adapter instance for the given provider routes. Registration is all-or-nothing, and is disposed with the calling fiber.
- `ctx.llm.listProviders(): LlmProviderInfo[]` Describe registered provider routes in registration order.
- `ctx.llm.listModels(provider: string): Promise<LlmModelInfo[]>` Discover the models one registered provider currently advertises.
- `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` Stream one model call as raw chunks (token-level deltas). Consumers assemble the chunks into blocks/messages with `BlockAssembler`.

Provider and model metadata is a discovery surface, not a routing whitelist. `registerAdapter()` still owns provider exclusivity, while an adapter may accept model ids absent from `listModels()`; consumers must not reject a request because its model is unlisted. Returned metadata is detached and invalid or duplicate adapter entries fail with `INVALID_ADAPTER` or `INVALID_CATALOG`.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `llm/stream` | waterfall | Intercept/wrap every streaming model call (retry, caching, routing) |

### Extension points

- Subclass `LlmAdapter` and call `ctx.llm.registerAdapter(providers, adapter)` to add one or more provider routes. `GenerateOptions.provider` selects the adapter; `GenerateOptions.model` is adapter-owned and may be resolved dynamically. Override `providerInfo()` and asynchronous `listModels()` to expose selector metadata; their defaults use the route id as its name and advertise no models.
- Wrap `llm/stream` via `ctx.on()` waterfall listeners for caching, retry, logging, rate-limiting, etc.

### Content-block vocabulary (`types.ts`)

Messages are arrays of typed content blocks: `text`, `reasoning`, `tool-call`, `tool-result`. The union is derived from the merge-extensible `ContentBlockMap`, so plugins can add block types via declaration merging. Assistant messages produced by the loop also carry provider/model provenance and optional adapter-private replay state. Before dispatch, `LlmService` retains that state only when the historical provider route and target provider route are currently owned by the exact same adapter instance; the adapter then decides whether it can restore or convert the state across models/providers. The core block set is limited to blocks every shipping path honors — multimodal content (images, audio, …) has no core block type; a feature that needs one adds it via the map together with the adapter/UI/compaction support that honors it.

Streaming is a raw chunk protocol (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`). `BlockAssembler` is the single shared implementation that assembles chunks into blocks/messages.

### Call configuration (`call-config.ts`)

`LlmCallConfig` is the provider + model + sampling scalars of one conversation's requests (`provider`, `model`, `temperature`, `maxTokens`, `stop` — each mapping 1:1 onto the same-named `GenerateOptions` field). It is per-conversation state recorded in the session log as part of the request header (see the dsh-session `request/header` events), never a silently-adjustable per-call knob: the `agent/request` waterfall proposes a replacement and the loop logs a real change. `callConfigEquals(a, b)` is the field-wise real-change detector; `deepFreeze(value)` is the ownership helper the loop applies to every built request before dispatch (`llm/stream` listeners and adapters read, never rewrite).

### App attribution (`attribution.ts`)

Every product adapter sends application identity on provider HTTP requests. `attributionHeaders(identity?)` builds the standard `User-Agent`, defaulting to public `APP_IDENTITY`; white-label deployments may replace but not suppress it. Adapters verify the wire header directly or through their library hook. See [the attribution RFC](../../../docs/rfc/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md).

### Classes

- `LlmAdapter` — abstract base class for provider adapters. The only required method is `stream()`.
- `BlockAssembler` — incrementally assembles raw chunks into complete content blocks and an assistant message. The agent loop feeds it raw chunks (logging them for replay) while reading the assembled blocks/message for history.
- `HarnessError` — base class for the harness error taxonomy: a stable `code` string (distinct from the human `message`) plus `cause` chaining. Lives here, in the leaf package every other imports, so a single base is shared without a new dependency edge. Per-package errors (`LlmError`, `ToolArgsError`, `InvariantError`, …) extend it. `isHarnessError(value)` narrows at seams.
- `LlmError` — extends `HarnessError`; its stable `code` string (`NO_ADAPTER`, `DUPLICATE_ADAPTER`, and adapter codes like `AUTH`/`RATE_LIMIT`) is the programmatic failure contract.

### Real adapters

Two adapters implement `LlmAdapter` on different internals: [`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) uses hand-rolled fetch/SSE for the `deepseek` route, while [`@deepseek-ai/dsh-llm-pi-ai`](../llm-pi-ai) dynamically resolves configured provider/model pairs through `@earendil-works/pi-ai`. Both follow the `StreamChunk` conventions in `types.ts`: usage precedes finish, tool arguments remain raw strings, and errors take one of two sanctioned paths. See [the twin LLM adapters](../../../docs/rfc/implemented/architecture/2026-06-13-twin-llm-adapters.md) for the design rationale.

## Model Experience

None, as this adapter registry forwards an already assembled request without adding or changing any model-bound text, schema, or message.

## Known Limitations and Deferred Work

- **No retry/caching/rate-limit layer ships** — `llm/stream` is the intended wrap seam and has no production listener, so provider 429/5xx failures surface immediately.
- **`GenerateOptions` sampling is `temperature`/`maxTokens`/`stop` only** — no `tool_choice`, `top_p`, or penalty fields; the vocabulary grows when a producer lands ([dropped inert knobs](../../../docs/rfc/implemented/simplification/2026-07-04-drop-inert-request-knobs.md)).
- **Producer-gated variants stay out until produced** — `prefill`, per-tool `strict`, block `cache` hints, and the `agent` message-source variant were pruned as producerless ([RFC](../../../docs/rfc/implemented/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)).
- **`BlockAssembler` handles core block kinds only** — a plugin-added block type whose stream is never closed by `block-end` makes `blocks()` throw.
- **`APP_IDENTITY.url` names a repository that does not exist yet** — `FIXME`: creating the public `deepseek-ai/deepseek-harness-sdk` repo gates the first release.
- **`GenerateOptions.sessionId` is a locally-declared brand** — importing dsh-session's `SessionId` would cycle; a future ids-owning package would dissolve the workaround.
