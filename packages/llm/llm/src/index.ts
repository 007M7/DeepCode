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

export * from './attribution.ts'
export * from './brand.ts'
export * from './never.ts'
export * from './error.ts'
export * from './types.ts'
export { BlockAssembler } from './assembler.ts'
export { callConfigEquals, deepFreeze } from './call-config.ts'
export type { LlmCallConfig } from './call-config.ts'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmService}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request arrives
     *   deep-frozen (mutation throws): its content is a pure function of the
     *   session log (the reconstructability RFC), so listeners read it, never
     *   rewrite it. A hand-built one-shot (compaction summarize) is the
     *   caller's own object and stays mutable here.
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
 *
 * App attribution is part of the adapter contract: every HTTP request to a
 * provider carries the headers from `attributionHeaders()` (`./attribution.ts`)
 * — the standard `User-Agent` baseline everywhere. An adapter proves it with
 * a wire-level test (a mock server asserting the received header), or, for a
 * library-backed adapter, by asserting the library's header hook delivers the
 * same value to the wire.
 */
export abstract class LlmAdapter {
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
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
   * @param models - every model name this adapter should serve.
   * @param adapter - the adapter that streams calls for those models.
   * @returns the disposer that unregisters all of them.
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

  /**
   * Model names with a registered adapter.
   * @returns the registered names, in registration order.
   */
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
   * @param options - the full request; `options.model` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(this, 'llm/stream', options, () => {
      return this.adapter(options.model).stream(options)
    })
  }
}

export default LlmService
