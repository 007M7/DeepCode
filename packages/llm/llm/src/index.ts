/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * surface. Exports the `LlmService` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from 'cordis'
import type { GenerateOptions, Message, StreamChunk } from './types.ts'
import { HarnessError } from './error.ts'
import { deepFreeze } from './call-config.ts'

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
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove that at the wire or library header-hook boundary. The hand-rolled
 * DeepSeek and pi-ai adapters intentionally exercise this contract through different internals.
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
   * Register an adapter for the given provider routes. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that streams calls for those providers.
   * @returns the disposer that unregisters all of them.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): () => void {
    const dispose = this.ctx.effect(function* (this: LlmService) {
      if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
      const unique = new Set<string>()
      for (const provider of providers) {
        if (provider.length === 0) throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
        if (unique.has(provider) || this.adapters.has(provider)) {
          throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER')
        }
        unique.add(provider)
      }
      for (const provider of providers) this.adapters.set(provider, adapter)
      yield () => {
        for (const provider of providers) this.adapters.delete(provider)
      }
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Provider routes with a registered adapter.
   * @returns the registered provider names, in registration order.
   */
  providers(): string[] {
    return [...this.adapters.keys()]
  }

  private adapter(provider: string): LlmAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return adapter
  }

  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const provenance = message.provenance
      if (message.role !== 'assistant' || provenance?.replayState === undefined) return message
      if (this.adapters.get(provenance.provider) === adapter) return message
      return {
        ...message,
        provenance: { provider: provenance.provider, model: provenance.model },
      }
    })
    if (messages.every((message, index) => message === options.messages[index])) return options
    const filtered = { ...options, messages }
    return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
  }

  /**
   * Stream one model call as raw chunks (token-level deltas). Throws
   * `LlmError` with code `NO_ADAPTER` if no adapter is registered for
   * `options.provider`. Replay state is retained only when the same adapter
   * instance owns its historical provider and the target provider. Dispatches
   * through the `llm/stream` waterfall.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(this, 'llm/stream', options, () => {
      const adapter = this.adapter(options.provider)
      return adapter.stream(this.forAdapter(options, adapter))
    })
  }
}

export default LlmService
