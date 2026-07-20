/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * surface. Exports the `LlmService` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from 'cordis'
import type { GenerateOptions, LlmFailure, LlmModelInfo, LlmProviderInfo, Message, StreamChunk } from './types.ts'
import type { ProviderRequestId } from './brand.ts'
import { deepFreeze } from './call-config.ts'
import { HarnessError } from './error.ts'
import { bindAdapterFailureScope, markLlmAdapterFailure } from './adapter-failure.ts'
import type { AdapterFailureScope } from './adapter-failure.ts'

export * from './attribution.ts'
export * from './brand.ts'
export * from './never.ts'
export * from './error.ts'
export * from './types.ts'
export { BlockAssembler } from './assembler.ts'
export { callConfigEquals, deepFreeze } from './call-config.ts'
export type { LlmCallConfig } from './call-config.ts'
export { isLlmAdapterFailure, llmFailureOf } from './adapter-failure.ts'

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
     *   session log (the reconstructability Agent Note), so listeners read it, never
     *   rewrite it. A hand-built one-shot (compaction summarize) is the
     *   caller's own object and stays mutable here.
     * @mode waterfall
     */
    'llm/stream'(this: LlmService, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}

/** Structured provider facts and cause accepted by {@link LlmError}. */
export interface LlmErrorOptions extends ErrorOptions {
  /** Valid HTTP status observed at the provider boundary. */
  status?: number
  /** Positive finite provider-requested delay in milliseconds. */
  providerRetryAfterMs?: number
  /** Non-empty opaque provider request id. */
  requestId?: ProviderRequestId
}

/**
 * Typed error for LLM-related failures. Extends {@link HarnessError}, so the
 * `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
 */
export class LlmError extends HarnessError {
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable provider-neutral machine code.
   * @param options - optional cause and validated serializable provider facts.
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) throw new Error('LlmError message must be a non-empty string')
    if (typeof code !== 'string' || code.length === 0) throw new Error('LlmError code must be a non-empty string')
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, code, options)
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
    })
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
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

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
  private adapters = new Map<string, { adapter: LlmAdapter; provider: LlmProviderInfo }>()

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
      const registrations: { adapter: LlmAdapter; provider: LlmProviderInfo }[] = []
      for (const provider of providers) {
        if (provider.length === 0) throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
        if (unique.has(provider) || this.adapters.has(provider)) {
          throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER')
        }
        const info = adapter.providerInfo(provider)
        if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
          throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER')
        }
        unique.add(provider)
        registrations.push({ adapter, provider: { id: info.id, name: info.name } })
      }
      for (const registration of registrations) this.adapters.set(registration.provider.id, registration)
      yield () => {
        for (const provider of providers) this.adapters.delete(provider)
      }
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Describe provider routes with a registered adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /**
   * Discover models advertised by one registered provider. Catalog membership
   * is advisory and never changes routing or request validation.
   * @param provider - registered provider route to inspect.
   * @returns detached model metadata in adapter-preferred order.
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const adapter = this.registration(provider).adapter
    const models = await adapter.listModels(provider)
    const seen = new Set<string>()
    return models.map((model) => {
      if (
        typeof model.provider !== 'string'
        || model.provider !== provider
        || typeof model.id !== 'string'
        || model.id.length === 0
        || typeof model.name !== 'string'
        || model.name.length === 0
        || (model.description !== undefined && typeof model.description !== 'string')
        || seen.has(model.id)
      ) {
        throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, 'INVALID_CATALOG')
      }
      seen.add(model.id)
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
      }
    })
  }

  private registration(provider: string): { adapter: LlmAdapter; provider: LlmProviderInfo } {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const provenance = message.provenance
      if (message.role !== 'assistant' || provenance?.replayState === undefined) return message
      if (this.adapters.get(provenance.provider)?.adapter === adapter) return message
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
   * Final adapter boundary. It tags only failures from adapter selection,
   * synchronous dispatch, iterator construction, or iteration while preserving
   * the original Error object. Middleware outside this generator remains
   * distinguishable as plugin work. An iteration failure skips adapter cleanup
   * so it cannot suppress the primary provider error. A downstream close awaits
   * adapter cleanup, whose failures remain ordinary untagged work.
   */
  private async * adapterStream(
    options: GenerateOptions,
    failures: AdapterFailureScope,
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      const adapter = this.registration(options.provider).adapter
      const stream = adapter.stream(this.forAdapter(options, adapter))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
      throw markLlmAdapterFailure(failures, error)
    }

    let completed = false
    let iterationFailed = false
    try {
      while (true) {
        let value: StreamChunk
        try {
          const item = await iterator.next()
          if (item.done) {
            completed = true
            return
          }
          value = item.value
        } catch (error: unknown) {
          iterationFailed = true
          throw markLlmAdapterFailure(failures, error)
        }
        // End the adapter-owned try before yielding: consumer/middleware
        // failures resumed into this generator must remain untagged.
        yield value
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the iteration catch sets its latch before entering finally.
      if (!completed && !iterationFailed) {
        const close = iterator.return?.bind(iterator)
        if (close) await close()
      }
    }
  }

  /**
   * Stream one model call as raw chunks (token-level deltas). Throws
   * `LlmError` with code `NO_ADAPTER` if no adapter is registered for
   * `options.provider`. Replay state is retained only when the same adapter
   * instance owns its historical provider and the target provider. Final
   * adapter selection, dispatch, and iteration failures retain their original
   * Error identity and are tagged in a call-local scope for narrow agent-loop
   * request recovery; middleware and nested-call failures remain untagged for
   * the outer call.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const failures: AdapterFailureScope = new WeakMap<Error, LlmFailure>()
    const stream = this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, failures))
    return bindAdapterFailureScope(stream, failures)
  }
}

export default LlmService
