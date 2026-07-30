# LLM Streaming

English | [中文](llm-streaming.zh.md)

The wire-level streaming vocabulary of [dsh-llm](../../packages/llm/llm). [core.md](core.md) introduces `StreamChunk`, `Message`, and `ContentBlock`; this page owns the full chunk protocol, the adapter contract every adapter must obey, and the shared assembler.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

## `StreamChunk` — the raw protocol

A streaming response interleaves several typed blocks (text, reasoning, multiple tool calls). `index` ties each delta to its block; `block-end` carries the fully-assembled `ContentBlock` so consumers don't have to re-assemble deltas themselves. It is a **closed** discriminated union — a `switch` over `type` ends with `assertNever`, so adding a variant breaks compilation at every consumer that must handle it.

```ts type-equiv
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmService.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Adapter-private lossless-JSON state for replaying a successful response. */
    replayState?: unknown
  }
```

## `LlmFailure`

Every thrown or in-band final-adapter failure normalizes to one serializable provider-neutral payload. `providerRetryAfterMs` is a validated positive delay requested by the provider, not a retry decision; `ProviderRequestId` is an opaque branded string for diagnostics.

```ts type-equiv
/** Serializable provider-boundary facts; policy decides whether they are retryable. */
interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status observed at the provider boundary, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId
}
```

## The adapter contract

Every adapter MUST obey these, and every consumer may rely on them:

- **`usage` before `finish`, nothing after `finish`.** Defer both to the provider's end-of-stream marker so a trailing usage-only chunk can't violate the ordering.
- **Tool-call `arguments` stay raw JSON strings end-to-end.** Partial fragments stream via `argumentsDelta`; a provider that hands back parsed objects re-stringifies at `block-end`.
- **Two sanctioned error paths, one fact shape.** A failure may either THROW from `stream()` (transport/protocol errors) **or** end the stream with `finish {kind:'error'|'aborted', failure}` (provider in-band errors, for adapters that can't throw mid-stream). `LlmError.failure` carries the same `LlmFailure`. The final adapter boundary preserves the exact thrown `Error` object and associates immutable facts plus the serving registration's immutable retry policy with that call; the agent loop closes the failed step and offers the error, facts, immutable prior-retried facts, serving policy, and turn signal to `agent/request-error`. A handling listener returns `{ kind: 'retry' }` after its awaited repair; absent recovery the structured failure becomes the turn error, and no normal assistant message or tool side effect is committed for that attempt.
- **One adapter call is one provider attempt.** Adapters disable library retries. Agent-level recovery opens another durable numbered turn; direct `ctx.llm.stream()` callers remain single-attempt.
- **Provider stalls are bounded at the transport.** Both shipping remote adapters expose positive finite `streamIdleTimeoutMs` with a five-minute default. The watchdog arms only while iterator `next()` is outstanding, uses one stable signal for the whole request, maps its own expiry to `TIMEOUT`, and keeps an earlier caller abort as `ABORTED`.
- **Context overflow has one canonical code.** Both DeepSeek adapters classify explicit provider detail through `isContextWindowExceededError()` and surface `CONTEXT_WINDOW_EXCEEDED`, whether the failure arrives as a thrown HTTP `LlmError` or an in-band finish error. Consumers route on the code, never provider text.
- **An empty completion is a retryable error, not a silent success.** Both adapters map a terminal `stop` finish that carried no content blocks to `finish {kind:'error'}` with the canonical `EMPTY_RESPONSE` code, and `dsh-llm-retry` retries it by default; see [empty model responses are retryable](../../.agents/notes/implemented/bug-fix/2026-07-24-empty-model-response-is-retryable.md).
- **Every provider HTTP request carries the app-attribution header.** Adapters send `attributionHeaders()` (below), the `User-Agent` baseline.
- **Replay state is adapter-owned.** A successful `finish` may carry lossless-JSON state needed to reconstruct a native provider response. The loop stores it with the assembled assistant message. On a later request, `LlmService` passes the state only when the historical provider and target provider are currently registered to the exact same adapter instance. That adapter validates the state and owns any cross-model or cross-provider conversion; other adapters receive the provider-neutral content and provenance without the private state.

Two independent implementations obey this contract: `dsh-llm-deepseek` uses direct fetch with SSE framing through `eventsource-parser`, while `dsh-llm-pi-ai` provides a generic multi-provider adapter through `@earendil-works/pi-ai`. Both carry cancellation and the idle watchdog to the provider request.

## `ResolvedRetryPolicy`

Provider configuration resolves before route registration into an immutable discriminated union. Normal mode carries `mode: 'normal'`, finite `maxRetries`, `retryableCodes`, and required `initialDelayMs`, `maxDelayMs`, and `jitterRatio`; always mode carries `mode: 'always'` and the same required backoff fields without a finite maximum. `LlmService.providerRetryPolicy(provider)` returns the currently registered value and supplies normal defaults when the adapter omits one; `llmRetryPolicyOf(stream)` returns the exact serving registration's captured value after that call enters its final adapter boundary, so later route disposal or replacement cannot change an in-flight failure's recovery policy. The [generated config catalog](../config-catalog.md) owns the optional input shapes.

## `AppIdentity` — app attribution

The static public application identity every adapter sends to providers ([`packages/llm/llm/src/attribution.ts`](../../packages/llm/llm/src/attribution.ts)). `attributionHeaders(identity?)` maps it to the standard `User-Agent` header only; OpenRouter-specific app attribution headers are intentionally not supported by this contract. The default `APP_IDENTITY` sources its version from the package manifest; every field is a public product fact - no secrets, paths, session ids, or per-user identifiers, and nothing per-request may influence the values. Rationale: [Mandatory `User-Agent` attribution](../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md).

```ts type-equiv
/**
 * Static public application identity sent to LLM providers.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Public home URL of the app, used as the `User-Agent` comment. */
  url: string
}
```

## `TokenUsage`

Per-call token accounting. Counts are **disjoint**: `inputTokens` is uncached input only; cached input is reported separately, and billed input is the sum of the three. Adapters whose providers fold cache hits into a single prompt total (DeepSeek's `prompt_tokens`) subtract them back out. `reasoningTokens`, when present, is informational detail already included in `outputTokens`; totals must not add it again.

```ts type-equiv
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

## `BlockAssembler`

`BlockAssembler` ([`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)) is the single shared implementation that folds a `StreamChunk` stream back into `ContentBlock`s, usage, finish reason, and replay state. The loop logs the raw chunks while feeding the same chunks through an assembler, then stores the assembled assistant content with its provider/model provenance. A consumer that needs the assembled result without re-implementing the fold uses this.

```ts public-api
/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * The agent loop feeds it while logging raw chunks for replay fidelity, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
declare class BlockAssembler {
  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void;
  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index, except that max-token truncation drops
   *   tool calls that cannot be executed safely; an open block assembles from
   *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[];
  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined;
  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason;
  /** Adapter-private replay state from the terminal finish chunk, if any. */
  get replayState(): unknown;
  /**
   * The assembled assistant message.
   * @param source - producer attribution for the assembled message.
   * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(source: MessageSource = { kind: 'plugin', plugin: 'dsh-llm/assembler' }): Message;
}
```

## The seam

`LlmAdapter` is the provider seam: subclass, implement `stream()`, and register one adapter instance with `ctx.llm.registerAdapter(providers, adapter)`. `GenerateOptions.provider` selects the registered adapter; `GenerateOptions.model` is passed to that adapter and need not be registered at lifecycle start. Duplicate provider routes fail atomically. Optional `providerRetryPolicy()` is captured per route with normal defaults, while `providerInfo()` and asynchronous `listModels()` feed `LlmService.listProviders()` / `listModels()` with detached selector metadata. That catalog is advisory rather than a request whitelist: the adapter remains authoritative and may accept unlisted model ids. One asynchronous `resolveModel()` query returns exact model identity plus optional correctness-sensitive context capacity, an adapter-configured `defaultMaxTokens`, and ordered model-owned reasoning ids with an optional deployment default; absent fields mean unavailable metadata or provider-owned behavior, not invalid catalog membership. The resolver receives optional cancellation and must settle promptly after abort. `LlmService.resolveModelInfo()` validates and detaches the aggregate. At the final adapter boundary, `resolveCallConfig()` materializes the output default only when `maxTokens` is absent and validates and materializes reasoning, so direct calls cannot bypass either configured behavior; direct dispatch captures one registration before awaiting that resolution. The agent loop instead uses `prepareCall()` to keep the same registration across model resolution, durable header logging, and dispatch, retain detached context metadata from that exact lookup, and report which config fields the adapter defaulted. Adapter lookup happens at the terminal continuation of the `llm/stream` waterfall, so a listener may short-circuit the call or route a mutable one-shot request before lookup. AgentLoop observes a request attempt once the outer waterfall returns a stream handle; that limited boundary does not prove a lazy terminal adapter was constructed or began provider I/O. The `block-start` / `block-end` `index` correlation and the assembler together mean an adapter only has to emit well-formed chunks — block reassembly is not each adapter's problem. The consumer surface (`ctx.llm.stream()`) and the `llm/stream` waterfall are described in [architecture.md § Content blocks and streaming](../architecture.md#content-blocks-and-streaming-dsh-llm).

```ts type-equiv
/** One model call whose config and adapter registration were resolved together. */
interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

```ts public-api
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove that at the wire or library header-hook boundary. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters intentionally exercise this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>;
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

`ContentBlockType` (the key set the `index`-correlated blocks carry) derives from `ContentBlockMap`:

```ts type-equiv
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

See [core.md § Content blocks and messages](core.md#content-blocks-and-messages) for the block interfaces.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis surface

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` surface lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxllm--llmservice"></a>

### `ctx.llm` — `LlmService`

The abstract `llm` service: an adapter registry plus a streaming model-call surface, interceptable via the `llm/stream` waterfall.

```ts cordis-catalog
/**
 * Register an adapter for the given provider routes. Throws `LlmError` with code
 * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
 * Disposed with the fiber.
 * @param providers - every provider route this adapter should serve.
 * @param adapter - the adapter that streams calls for those providers.
 * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
 */
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle

/**
 * Describe provider routes with a registered adapter.
 * @returns detached provider metadata in registration order.
 */
listProviders(): LlmProviderInfo[]

/**
 * Declare provider routes an adapter plugin can activate through
 * configuration. Registration is all-or-nothing: an empty list, invalid
 * entry, or a provider already declared by any registration throws
 * `LlmError` without registering the rest. Disposed with the fiber.
 * @param entries - every configurable provider this plugin owns.
 * @returns a handle that withdraws all of them, and can atomically replace them.
 */
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle

/**
 * List every declared configurable provider, registered or dormant.
 * @returns detached directory entries in declaration order.
 */
listConfigurableProviders(): LlmConfigurableProvider[]

/**
 * Offer to interrogate provider endpoints on behalf of the settings
 * namespace this plugin owns. The namespace is the key because that is what
 * a configuration surface already holds from the configurable-provider
 * directory, and because a provider being *added* has no route to name yet.
 * Disposed with the fiber.
 * @param settingsNs - the namespace whose profiles this discovery serves.
 * @param discover - interrogates one endpoint; must honor `request.signal`.
 * @returns the disposer that withdraws the offer.
 */
registerModelDiscovery( settingsNs: string, discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>, ): () => void

/**
 * Interrogate one provider endpoint for the models it advertises. The
 * request describes a draft, not a stored route, so nothing here reads or
 * writes settings or credentials — the caller owns both, and the reply is
 * candidate metadata a surface may offer for adoption.
 * @param settingsNs - namespace whose registered discovery serves this draft.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @returns the advertised models, deduplicated in endpoint order.
 */
async discoverModels( settingsNs: string, request: LlmModelDiscoveryRequest, ): Promise<LlmDiscoveredModel[]>

/**
 * Resolve the retry policy captured when one provider route was registered.
 * @param provider - registered provider route to inspect.
 * @returns the provider-owned policy, with normal defaults already resolved.
 */
providerRetryPolicy(provider: string): ResolvedRetryPolicy

/**
 * Discover models advertised by one registered provider. Catalog membership
 * is advisory and never changes routing or request validation.
 * @param provider - registered provider route to inspect.
 * @returns detached model metadata in adapter-preferred order.
 */
async listModels(provider: string): Promise<LlmModelInfo[]>

/**
 * Resolve and validate all metadata from the adapter that owns one exact
 * route. The result is detached from adapter-owned objects; catalog
 * membership remains advisory and does not control request routing.
 * @param provider - registered provider route to inspect.
 * @param model - exact model id passed to the adapter.
 * @param signal - optional cancellation for adapter-owned asynchronous lookup.
 * @returns exact model identity plus available context and reasoning metadata.
 */
async resolveModelInfo( provider: string, model: string, signal?: AbortSignal, ): Promise<LlmResolvedModelInfo>

/**
 * Validate a conversation call config against its exact model capability and
 * materialize adapter-configured defaults. Unsupported explicit efforts
 * reject before provider I/O; no clamping or aliasing is performed. This
 * standalone query does not bind a later dispatch; use {@link prepareCall}
 * when logging and streaming must share one adapter registration.
 * @param config - provider/model route and optional request controls.
 * @param signal - optional cancellation for adapter-owned capability lookup.
 * @returns a detached config only when a default must be materialized.
 */
async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>

/**
 * Resolve one call under its current adapter registration. The returned
 * one-shot handle keeps that registration across header logging and dispatch,
 * so HMR cannot combine one adapter's capability result with another adapter.
 * @param config - provider/model route and optional request controls.
 * @param signal - optional cancellation for adapter-owned capability lookup.
 * @returns a prepared config and its registration-bound stream entry point.
 */
async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>

/**
 * Stream one model call as raw chunks (token-level deltas). Replay state is
 * retained only when the same adapter instance owns its historical provider
 * and the target provider. Final adapter selection remains fixed through
 * asynchronous exact-model resolution and dispatch. Adapter selection,
 * dispatch, and iteration failures become terminal `error` or `aborted`
 * finish chunks; middleware, nested-call, cleanup, and consumer failures
 * remain thrown.
 * @param options - the full request; `options.provider` selects the adapter.
 * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
 */
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

Types: [AdapterRegistrationHandle](core.md) · [DirectoryRegistrationHandle](core.md) · [GenerateOptions](core.md) · [LlmCallConfig](core.md) · [LlmConfigurableProvider](core.md) · [LlmDiscoveredModel](core.md) · [LlmModelDiscoveryRequest](core.md) · [LlmModelInfo](core.md) · [LlmProviderInfo](core.md) · [LlmResolvedModelInfo](core.md)

Source: [`packages/llm/llm/src/index.ts:292`](../../packages/llm/llm/src/index.ts)

<a id="llm-events"></a>

### `llm/*` events

<a id="llmadapters-updated--emit"></a>

#### `llm/adapters-updated` — emit

The provider topology changed: an adapter registered or unregistered routes, or the configurable-provider directory gained or lost entries. This is a payload-free registry notification fired at each commit point (including registration disposal); consumers re-read `listProviders()`, `listModels()`, or `listConfigurableProviders()` for the new state. Observer failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * The provider topology changed: an adapter registered or unregistered
 * routes, or the configurable-provider directory gained or lost entries.
 * This is a payload-free registry notification fired at each commit point
 * (including registration disposal); consumers re-read `listProviders()`,
 * `listModels()`, or `listConfigurableProviders()` for the new state.
 * Observer failures are contained and cannot veto the registry mutation.
 * @mode emit
 */
'llm/adapters-updated'(): void
```

Source: [`packages/llm/llm/src/index.ts:73`](../../packages/llm/llm/src/index.ts)

<a id="llmstream--waterfall"></a>

#### `llm/stream` — waterfall

Waterfall around every streaming model call (retry, replay, routing). Bound to the LlmService; call `next()` to reach the resolved adapter's stream, or yield your own chunks to short-circuit.

```ts cordis-catalog
/**
 * Waterfall around every streaming model call (retry, replay, routing).
 * Bound to the {@link LlmService}; call `next()` to reach the resolved
 * adapter's stream, or yield your own chunks to short-circuit.
 * @param options - the full request. A LOOP-built request carries the
 *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
 *   (mutation throws): its content is a pure function of the session log (the
 *   reconstructability Agent Note), so listeners read it, never rewrite it.
 *   Hand-built calls do not carry that marker; their messages already obey
 *   the immutable creation contract.
 * @mode waterfall
 */
'llm/stream'(this: LlmService, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

Types: [GenerateOptions](core.md)

Source: [`packages/llm/llm/src/index.ts:62`](../../packages/llm/llm/src/index.ts)
<!-- END GENERATED cordis-surface -->
