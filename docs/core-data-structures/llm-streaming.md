# LLM Streaming

The wire-level streaming vocabulary of [dsh-llm](../../packages/llm/llm). [core.md](core.md) introduces `StreamChunk`, `Message`, and `ContentBlock`; this page owns the full chunk protocol, the adapter contract every adapter must obey, and the shared assembler.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

## `StreamChunk` — the raw protocol

A streaming response interleaves several typed blocks (text, reasoning, multiple tool calls). `index` ties each delta to its block; `block-end` carries the fully-assembled `ContentBlock` so consumers don't have to re-assemble deltas themselves. It is a **closed** discriminated union — a `switch` over `type` ends with `assertNever`, so adding a variant breaks compilation at every consumer that must handle it.

```ts type-equiv
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. Failures either throw or
 * end with `error`/`aborted`, and consumers must handle both paths.
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
- **Two sanctioned error paths, one fact shape.** A failure may either THROW from `stream()` (transport/protocol errors) **or** end the stream with `finish {kind:'error'|'aborted', failure}` (provider in-band errors, for adapters that can't throw mid-stream). `LlmError.failure` carries the same `LlmFailure`. The final adapter boundary preserves the exact thrown `Error` object and associates immutable facts with that call; the agent loop closes the failed step and offers the error, facts, and immutable prior-retried facts to `agent/request-error`. Absent recovery the structured failure becomes the turn error, and no normal assistant message or tool side effect is committed for that attempt.
- **One adapter call is one provider attempt.** Adapters disable library retries. Agent-level recovery opens another durable numbered step; direct `ctx.llm.stream()` callers remain single-attempt.
- **Provider stalls are bounded at the transport.** Both shipping remote adapters expose positive finite `streamIdleTimeoutMs` with a five-minute default. The watchdog arms only while iterator `next()` is outstanding, uses one stable signal for the whole request, maps its own expiry to `TIMEOUT`, and keeps an earlier caller abort as `ABORTED`.
- **Context overflow has one canonical code.** Both DeepSeek adapters classify explicit provider detail through `isContextWindowExceededError()` and surface `CONTEXT_WINDOW_EXCEEDED`, whether the failure arrives as a thrown HTTP `LlmError` or an in-band finish error. Consumers route on the code, never provider text.
- **Every provider HTTP request carries the app-attribution header.** Adapters send `attributionHeaders()` (below) - the `User-Agent` baseline - and prove it with a wire-level test (mock server asserting the received header, or the library's header hook for a library-backed adapter).
- **Replay state is adapter-owned.** A successful `finish` may carry lossless-JSON state needed to reconstruct a native provider response. The loop stores it with the assembled assistant message unless an `agent/step-result` listener rewrote the content. On a later request, `LlmService` passes the state only when the historical provider and target provider are currently registered to the exact same adapter instance. That adapter validates the state and owns any cross-model or cross-provider conversion; other adapters receive the provider-neutral content and provenance without the private state.

This contract is pinned down by two deliberately independent implementations: `dsh-llm-deepseek` (hand-rolled fetch/SSE) and `dsh-llm-pi-ai` (a generic multi-provider adapter through `@earendil-works/pi-ai`). The library-backed adapter exercises the finish-chunk error path, while transport-boundary tests prove each idle watchdog stops its actual request.

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
   * @returns one block per seen index; an open block assembles from its
   *   accumulated deltas (an unknown block type never closed by `block-end` throws).
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
   * @returns an assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(): Message;
}
```

## The seam

`LlmAdapter` is the provider seam: subclass, implement `stream()`, and register one adapter instance with `ctx.llm.registerAdapter(providers, adapter)`. `GenerateOptions.provider` selects the registered adapter; `GenerateOptions.model` is passed to that adapter and need not be registered at lifecycle start. Duplicate provider routes fail atomically. Optional `providerInfo()` and asynchronous `listModels()` methods feed `LlmService.listProviders()` / `listModels()` with detached selector metadata. That catalog is advisory rather than a request whitelist: the adapter remains authoritative and may accept unlisted model ids. The separate `resolveModelContext()` query exposes correctness-sensitive capacity for an exact route without making catalog membership authoritative; absence means unknown metadata, not invalid routing. Adapter lookup happens at the terminal continuation of the `llm/stream` waterfall, so a listener may short-circuit the call or route a mutable one-shot request before lookup. The `block-start` / `block-end` `index` correlation and the assembler together mean an adapter only has to emit well-formed chunks — block reassembly is not each adapter's problem. The consumer surface (`ctx.llm.stream()`) and the `llm/stream` waterfall are described in [architecture.md § Content blocks and streaming](../architecture.md#content-blocks-and-streaming-dsh-llm).

```ts public-api
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove that at the wire or library header-hook boundary. The hand-rolled
 * DeepSeek and pi-ai adapters intentionally exercise this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve context capacity for one model accepted by this adapter. Absence
   * means the adapter does not know the capacity, not that routing is invalid.
   * @param _provider - one provider route owned by this adapter.
   * @param _model - exact model id passed to {@link GenerateOptions.model}.
   * @returns provider-owned context metadata, or `undefined` when unavailable.
   */
  resolveModelContext(
    _provider: string,
    _model: string,
  ): Promise<LlmModelContext | undefined>;
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
