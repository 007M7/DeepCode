# LLM Streaming

The wire-level streaming vocabulary of [dsh-llm](../../packages/llm/llm). [core.md](core.md) introduces `StreamChunk`, `Message`, and `ContentBlock`; this page owns the full chunk protocol, the adapter contract every adapter must obey, and the shared assembler.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

## `StreamChunk` — the raw protocol

A streaming response interleaves several typed blocks (text, reasoning, multiple tool calls). `index` ties each delta to its block; `block-end` carries the fully-assembled `ContentBlock` so consumers don't have to re-assemble deltas themselves. It is a **closed** discriminated union — a `switch` over `type` ends with `assertNever`, so adding a variant breaks compilation at every consumer that must handle it.

```ts type-equiv
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
```

## The adapter contract

Every adapter MUST obey these, and every consumer may rely on them:

- **`usage` before `finish`, nothing after `finish`.** Defer both to the provider's end-of-stream marker so a trailing usage-only chunk can't violate the ordering.
- **Tool-call `arguments` stay raw JSON strings end-to-end.** Partial fragments stream via `argumentsDelta`; a provider that hands back parsed objects re-stringifies at `block-end`.
- **Two sanctioned error paths.** A failure may either THROW from `stream()` (transport/protocol errors) **or** end the stream with `finish {kind:'error'|'aborted'}` (provider in-band errors, for adapters that can't throw mid-stream). Consumers must handle *both*. The agent loop translates a finish-error/aborted into a turn error — it never logs a normal completed assistant message for a failed step.

This contract is why two adapters exist as a deliberate pair: `dsh-llm-deepseek` (hand-rolled fetch/SSE) and `dsh-llm-pi-ai` (the same endpoint through `@earendil-works/pi-ai`). Two independent internals over one contract is what pinned the protocol down — the library-backed adapter can't throw mid-stream, so it exercises the finish-chunk error path the hand-rolled one might not.

## `TokenUsage`

Per-call token accounting. Counts are **disjoint**: `inputTokens` is uncached input only; cached input is reported separately, and billed input is the sum of the three. Adapters whose providers fold cache hits into a single prompt total (DeepSeek's `prompt_tokens`) subtract them back out.

```ts type-equiv
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

## `BlockAssembler`

`BlockAssembler` ([`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)) is the single shared implementation that folds a `StreamChunk` stream back into `ContentBlock`s and a final `Message`. The loop logs the raw chunks (for replay fidelity) while feeding the same chunks through an assembler — so the canonical log keeps token-level detail and the derived message is rebuilt deterministically. A consumer that needs the assembled result without re-implementing the fold uses this.

## The seam

`LlmAdapter` is the provider seam: subclass, implement `stream()`, register with `ctx.llm.registerAdapter(models, adapter)`. The `block-start` / `block-end` `index` correlation and the assembler together mean an adapter only has to emit well-formed chunks — block reassembly is not each adapter's problem. The consumer surface (`ctx.llm.stream()`) and the `llm/stream` waterfall are described in [architecture.md § The vocabulary](../architecture.md#the-vocabulary-dsh-llm).

`ContentBlockType` (the key set the `index`-correlated blocks carry) derives from `ContentBlockMap`:

```ts type-equiv
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
  'image': ImageBlock
}
```

See [core.md § Content blocks and messages](core.md#content-blocks-and-messages) for the block interfaces.
