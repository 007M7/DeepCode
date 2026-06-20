/**
 * LLM service: adapter registry with waterfall-interceptable streaming and
 * non-streaming call surfaces. Exports the `LlmService` default, the abstract
 * `LlmAdapter` for provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from 'cordis'
import type { ContentBlock, GenerateOptions, GenerateResult, StreamChunk } from './types.ts'
import { BlockAssembler } from './assembler.ts'
import { HarnessError } from './error.ts'

export * from './brand.ts'
export * from './never.ts'
export * from './error.ts'
export * from './types.ts'
export { BlockAssembler } from './assembler.ts'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    /**
     * Waterfall around every streaming model call (retry, caching, routing).
     * Bound to the {@link LlmService}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @mode waterfall
     */
    'llm/stream'(this: LlmService, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
    /**
     * Waterfall around every non-streaming model call. Bound to the
     * {@link LlmService}; call `next()` to delegate to the adapter.
     * @mode waterfall
     */
    'llm/generate'(this: LlmService, options: GenerateOptions, next: () => Promise<GenerateResult>): Promise<GenerateResult>
    /**
     * An adapter was registered or unregistered (the model→adapter map changed).
     * @mode emit
     */
    'llm/adapter-change'(): void
  }
}

/**
 * Typed error for LLM-related failures. Extends {@link HarnessError}, so the
 * `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy;
 * `status` carries the HTTP status when the error originated from a non-2xx
 * provider response (absent for protocol/usage errors that have no HTTP status).
 */
export class LlmError extends HarnessError {
  constructor(message: string, code: string, public status?: number, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'LlmError'
  }
}

/**
 * Base class for LLM provider adapters.
 *
 * An adapter translates between the harness vocabulary (Message/ContentBlock/
 * StreamChunk) and one provider's wire format. Adapters register themselves
 * via `ctx.llm.registerAdapter(models, adapter)`.
 *
 * Real implementations: `@deepseek-ai/dsh-llm-deepseek` (hand-rolled
 * fetch/SSE) and `@deepseek-ai/dsh-llm-pi-ai` (pi-ai-backed) — two
 * deliberately different internals over the same contract; see the
 * adapter contract documented on `StreamChunk` in `./types.ts`.
 */
export abstract class LlmAdapter {
  /** Stream one model call as raw chunks. The only required method. */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * The abstract `llm` service: an adapter registry plus streaming /
 * non-streaming call surfaces, both interceptable via waterfall events.
 */
export class LlmService extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Register an adapter for the given model names. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any model already has an adapter (all-or-nothing).
   * Emits `llm/adapter-change` on registration and disposal. Disposed with the
   * fiber.
   */
  registerAdapter(models: string[], adapter: LlmAdapter): () => void {
    const dispose = this.ctx.effect(function* (this: LlmService) {
      for (const model of models) {
        if (this.adapters.has(model)) {
          throw new LlmError(`an adapter for model "${model}" is already registered`, 'DUPLICATE_ADAPTER')
        }
      }
      for (const model of models) this.adapters.set(model, adapter)
      // Yield the rollback BEFORE emitting the change event: a generator effect
      // collects each yielded disposer before running the next step, so a
      // throwing `llm/adapter-change` listener rolls the mutation back instead
      // of leaking the entry (which would wedge the duplicate check until
      // restart). The duplicate throws above fire before any mutation, so they
      // correctly leak nothing.
      yield () => {
        for (const model of models) this.adapters.delete(model)
        this.ctx.emit('llm/adapter-change')
      }
      this.ctx.emit('llm/adapter-change')
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /** Model names with a registered adapter. */
  models(): string[] {
    return [...this.adapters.keys()]
  }

  private adapter(model: string): LlmAdapter {
    const adapter = this.adapters.get(model)
    if (!adapter) throw new LlmError(`no adapter registered for model "${model}"`, 'NO_ADAPTER')
    return adapter
  }

  /**
   * Stream one model call as raw chunks (token-level deltas). Throws
   * `LlmError` with code `NO_ADAPTER` if no adapter is registered for
   * `options.model`. Dispatches through the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(this, 'llm/stream', options, () => {
      return this.adapter(options.model).stream(options)
    })
  }

  /**
   * Stream one model call as completed content blocks — a convenience view
   * for consumers that don't care about token-level deltas. Blocks are
   * yielded strictly in stream order as soon as they (and everything before
   * them) complete; blocks left open at end of stream (delta-only protocols)
   * are assembled and flushed last, so the sequence always equals
   * `generate()`'s `message.content`.
   */
  async * streamBlocks(options: GenerateOptions): AsyncIterable<ContentBlock> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.stream(options)) {
      assembler.push(chunk)
      yield * assembler.flushReady()
    }
    yield * assembler.flushRemaining()
  }

  /**
   * One model call, fully assembled (drains the chunk stream). Dispatches
   * through the `llm/generate` waterfall (and the inner stream through
   * `llm/stream`). Same completion guarantees as `streamBlocks()`.
   */
  generate(options: GenerateOptions): Promise<GenerateResult> {
    return this.ctx.waterfall(this, 'llm/generate', options, async () => {
      const assembler = new BlockAssembler()
      for await (const chunk of this.stream(options)) assembler.push(chunk)
      return assembler.result()
    })
  }
}

export default LlmService
