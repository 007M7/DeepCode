/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * surface. Exports the `LlmService` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from 'cordis'
import type { GenerateOptions, StreamChunk } from './types.ts'
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
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * surface, interceptable via the `llm/stream` waterfall.
 */
export class LlmService extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Register an adapter for the given model names. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any model already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   */
  registerAdapter(models: string[], adapter: LlmAdapter): () => void {
    const dispose = this.ctx.effect(function* (this: LlmService) {
      for (const model of models) {
        if (this.adapters.has(model)) {
          throw new LlmError(`an adapter for model "${model}" is already registered`, 'DUPLICATE_ADAPTER')
        }
      }
      for (const model of models) this.adapters.set(model, adapter)
      yield () => {
        for (const model of models) this.adapters.delete(model)
      }
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
}

export default LlmService
