# dsh-llm

Provider-neutral LLM vocabulary and abstract service. This package defines the canonical language spoken by the agent loop, session logs, and every plugin.

## Service: `LlmService` (ctx key: `llm`)

An adapter registry plus streaming / non-streaming call surfaces. Both call surfaces are interceptable via waterfall events.

### Public API

- `ctx.llm.registerAdapter(models: string[], adapter: LlmAdapter): () => void` Register an adapter for the given model names. Disposed with the calling fiber.
- `ctx.llm.models(): string[]` — model names with a registered adapter.
- `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` Stream one model call as raw chunks (token-level deltas).
- `ctx.llm.streamBlocks(options: GenerateOptions): AsyncIterable<ContentBlock>` Stream as completed content blocks (convenience view).
- `ctx.llm.generate(options: GenerateOptions): Promise<GenerateResult>` One model call, fully assembled.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `llm/stream` | waterfall | Intercept/wrap every streaming model call (retry, caching, routing) |
| `llm/generate` | waterfall | Intercept/wrap every non-streaming model call |
| `llm/adapter-change` | emit | An adapter was registered or unregistered |

### Extension points

- Subclass `LlmAdapter` and call `ctx.llm.registerAdapter(models, adapter)` to add a new model provider.
- Wrap `llm/stream` or `llm/generate` via `ctx.on()` waterfall listeners for caching, retry, logging, rate-limiting, etc.

### Content-block vocabulary (`types.ts`)

Messages are arrays of typed content blocks: `text`, `reasoning`, `tool-call`, `tool-result`, `image`. The union is derived from the merge-extensible `ContentBlockMap`, so plugins can add block types via declaration merging.

Streaming is a raw chunk protocol (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`). `BlockAssembler` is the single shared implementation that assembles chunks into blocks/messages.

### Classes

- `LlmAdapter` — abstract base class for provider adapters. The only required method is `stream()`.
- `BlockAssembler` — incrementally assembles raw chunks into complete content blocks and an assistant message. Used by the agent loop (raw chunks for replay
  + assembled for history) and by `streamBlocks()`/`generate()`.
- `HarnessError` — base class for the harness error taxonomy: a stable `code` string (distinct from the human `message`) plus `cause` chaining. Lives here, in the leaf package every other imports, so a single base is shared without a new dependency edge. Per-package errors (`LlmError`, `ToolArgsError`, `InvariantError`, …) extend it. `isHarnessError(value)` narrows at seams.
- `LlmError` — extends `HarnessError`; `code` string (`NO_ADAPTER`, `DUPLICATE_ADAPTER`, and adapter codes like `AUTH`/`RATE_LIMIT`) plus an optional numeric `status` when the failure came from a non-2xx provider response.

### Real adapters

Two adapters implement `LlmAdapter` against this vocabulary, deliberately built on different internals to keep the contract honest (see [ADR 0010](../../docs/adr/0010-twin-llm-adapters.md)): [`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) (hand-rolled fetch/SSE) and [`@deepseek-ai/dsh-llm-pi-ai`](../llm-pi-ai) (via `@earendil-works/pi-ai`). The pair pinned down the `StreamChunk` conventions now documented in `types.ts` (usage before finish, raw-string tool arguments, the two sanctioned error paths).
