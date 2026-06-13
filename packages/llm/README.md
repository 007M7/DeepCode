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
- `LlmError` — typed error with a `code` string (`NO_ADAPTER`, `DUPLICATE_ADAPTER`).

### What is NOT here (TODO)

- **DeepSeek V4 adapter** — the first real adapter lands in a later phase.
- **Streaming protocol review** — the chunk protocol has `TODO(review)` markers and needs careful review before the first real adapter (DeepSeek V4 wire format, partial JSON arguments, interleaved reasoning signatures, ...).
