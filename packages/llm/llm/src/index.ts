/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * surface. Exports the `LlmService` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Context, Service } from 'cordis'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmProviderInfo,
  StreamChunk,
} from './types.ts'
import { freezeMessage, type Message } from './message.ts'
import { resolveRetryPolicy } from './retry-policy.ts'
import type { ResolvedRetryPolicy } from './retry-policy.ts'
import type { ProviderRequestId } from './brand.ts'
import { callConfigEquals, deepFreeze } from './call-config.ts'
import type { LlmCallConfig } from './call-config.ts'
import { HarnessError } from './error.ts'
import { bindAdapterFailureScope, markLlmAdapterFailure } from './adapter-failure.ts'
import type { AdapterFailureScope } from './adapter-failure.ts'

export * from './attribution.ts'
export * from './brand.ts'
export * from './never.ts'
export * from './error.ts'
export * from './types.ts'
export * from './message.ts'
export * from './retry-policy.ts'
export { BlockAssembler } from './assembler.ts'
export { callConfigEquals, deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from './call-config.ts'
export type { LlmCallConfig } from './call-config.ts'
export { isLlmAdapterFailure, llmFailureOf, llmRetryPolicyOf } from './adapter-failure.ts'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
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

/** One model call whose config and adapter registration were resolved together. */
export interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove that at the wire or library header-hook boundary. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters intentionally exercise this contract through different internals.
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
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
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
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
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
  private adapters = new Map<string, AdapterRegistration>()

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
      const registrations: AdapterRegistration[] = []
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
        const retryPolicy = adapter.providerRetryPolicy(provider)
          ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`)
        registrations.push({
          adapter,
          provider: { id: info.id, name: info.name },
          retryPolicy,
        })
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
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.registration(provider).retryPolicy
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

  /**
   * Resolve and validate all metadata from the adapter that owns one exact
   * route. The result is detached from adapter-owned objects; catalog
   * membership remains advisory and does not control request routing.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id passed to the adapter.
   * @param signal - optional cancellation for adapter-owned asynchronous lookup.
   * @returns exact model identity plus available context and reasoning metadata.
   */
  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolveModelInfoFor(this.registration(provider), model, signal)
  }

  private async resolveModelInfoFor(
    registration: AdapterRegistration,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const provider = registration.provider.id
    const resolved = await registration.adapter.resolveModel(provider, model, signal)
    if (
      typeof resolved.provider !== 'string'
      || resolved.provider !== provider
      || typeof resolved.id !== 'string'
      || resolved.id !== model
      || typeof resolved.name !== 'string'
      || resolved.name.length === 0
      || (resolved.description !== undefined && typeof resolved.description !== 'string')
    ) {
      throw new LlmError(
        `adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    const context = resolved.context
    if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
      throw new LlmError(
        `adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_CONTEXT',
      )
    }
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: resolved.name,
      ...resolved.description === undefined ? {} : { description: resolved.description },
      ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
    }
    const reasoning = resolved.reasoning
    if (reasoning === undefined) return info
    if (reasoning.efforts.length === 0) {
      throw new LlmError(
        `adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    const seen = new Set<string>()
    const efforts = reasoning.efforts.map((effort) => {
      if (
        typeof effort.id !== 'string'
        || effort.id.length === 0
        || typeof effort.name !== 'string'
        || effort.name.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')
        || seen.has(effort.id)
      ) {
        throw new LlmError(
          `adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`,
          'INVALID_MODEL_REASONING',
        )
      }
      seen.add(effort.id)
      return {
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      }
    })
    if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
      throw new LlmError(
        `adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    return {
      ...info,
      reasoning: {
        efforts,
        ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
      },
    }
  }

  /**
   * Validate a conversation call config against its exact model capability and
   * materialize an adapter-configured default. Unsupported explicit efforts
   * reject before provider I/O; no clamping or aliasing is performed. This
   * standalone query does not bind a later dispatch; use {@link prepareCall}
   * when logging and streaming must share one adapter registration.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a detached config only when a default must be materialized.
   */
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    return this.resolveCallConfigFor(this.registration(config.provider), config, signal)
  }

  private async resolveCallConfigFor(
    registration: AdapterRegistration,
    config: LlmCallConfig,
    signal?: AbortSignal,
  ): Promise<LlmCallConfig> {
    const reasoning = (await this.resolveModelInfoFor(registration, config.model, signal)).reasoning
    const requested = config.reasoningEffort
    if (reasoning === undefined) {
      if (requested !== undefined) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      return config
    }
    const effective = requested ?? reasoning.defaultEffort
    if (effective === undefined) return config
    if (!reasoning.efforts.some(effort => effort.id === effective)) {
      throw new LlmError(
        `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return requested === effective ? config : { ...config, reasoningEffort: effective }
  }

  /**
   * Resolve one call under its current adapter registration. The returned
   * one-shot handle keeps that registration across header logging and dispatch,
   * so HMR cannot combine one adapter's capability result with another adapter.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a prepared config and its registration-bound stream entry point.
   */
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> {
    const registration = this.registration(config.provider)
    const resolvedConfig = deepFreeze(structuredClone(
      await this.resolveCallConfigFor(registration, config, signal),
    ))
    let dispatched = false
    return Object.freeze({
      config: resolvedConfig,
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched) {
          throw new LlmError('a prepared LLM call can only be dispatched once', 'INVALID_PREPARED_CALL')
        }
        dispatched = true
        return this.streamWithRegistration(options, { registration, config: resolvedConfig })
      },
    })
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const source = message.source
      if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
      if (this.adapters.get(source.provider)?.adapter === adapter) return message
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      })
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
    prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      const registration = prepared?.registration ?? this.registration(options.provider)
      failures.retryPolicy = registration.retryPolicy
      const resolvedConfig = prepared === undefined
        ? await this.resolveCallConfigFor(registration, options, options.signal)
        : prepared.config
      if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
        throw new LlmError(
          'prepared LLM call config changed before adapter dispatch',
          'INVALID_PREPARED_CALL',
        )
      }
      const resolvedOptions = prepared !== undefined || callConfigEquals(options, resolvedConfig)
        ? options
        : Object.isFrozen(options)
          ? deepFreeze({ ...options, ...resolvedConfig })
          : { ...options, ...resolvedConfig }
      const adapter = registration.adapter
      const stream = adapter.stream(this.forAdapter(resolvedOptions, adapter))
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
   * adapter selection remains fixed through asynchronous exact-model resolution
   * and dispatch. Selection, dispatch, and iteration failures retain their
   * original Error identity and are tagged in a call-local scope for narrow
   * agent-loop request recovery; middleware and nested-call failures remain
   * untagged for the outer call.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
  ): AsyncIterable<StreamChunk> {
    const failures: AdapterFailureScope = { failures: new WeakMap<Error, LlmFailure>() }
    const stream = this.ctx.waterfall(
      this,
      'llm/stream',
      options,
      () => this.adapterStream(options, failures, prepared),
    )
    return bindAdapterFailureScope(stream, failures)
  }
}

interface AdapterRegistration {
  readonly adapter: LlmAdapter
  readonly provider: LlmProviderInfo
  readonly retryPolicy: ResolvedRetryPolicy
}

export default LlmService
