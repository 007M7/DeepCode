/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { streamSimple } from '@earendil-works/pi-ai/compat'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { resolveProfiles } from './config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** Constructor options for {@link PiAiAdapter}. */
export interface PiAiAdapterOptions {
  /** Validated provider profiles this adapter instance owns. */
  profiles: readonly PiAiProviderProfile[]
}

/**
 * Resolve a catalog model dynamically and apply only the configured endpoint
 * override, preserving the catalog's API/capability/compatibility metadata.
 */
function resolvePiModel(
  profile: Omit<PiAiProviderProfile, 'retryPolicy'>,
  modelId: string,
): Model<Api> {
  const model = getBuiltinModels(profile.provider as BuiltinProvider).find(candidate => candidate.id === modelId) as Model<Api> | undefined
  if (model === undefined) {
    throw new LlmError(`pi-ai provider "${profile.provider}" has no catalog model "${modelId}"`, 'UNKNOWN_MODEL')
  }
  return profile.baseURL === undefined ? model : { ...model, baseUrl: profile.baseURL }
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: Omit<PiAiProviderProfile, 'retryPolicy'>,
  reasoning: ModelThinkingLevel | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...profile.apiKey === undefined ? {} : { apiKey: profile.apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Model descriptors are resolved for each
 * request, so models need not be registered during the Cordis lifecycle.
 */
export class PiAiAdapter extends LlmAdapter {
  private readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>

  constructor(options: PiAiAdapterOptions) {
    super()
    this.profiles = new Map(resolveProfiles(options.profiles).map(profile => [profile.provider, profile]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profiles.get(provider)
    if (profile === undefined) {
      return Promise.reject(new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER'))
    }
    return Promise.resolve(getBuiltinModels(profile.provider as BuiltinProvider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
    })))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const profile = this.profiles.get(provider)
    if (profile === undefined) {
      return Promise.reject(new LlmError(
        `pi-ai adapter does not own provider "${provider}"`,
        'NO_ADAPTER',
      ))
    }
    return Promise.resolve().then(() => {
      const resolvedModel = resolvePiModel(profile, model)
      const levels = getSupportedThinkingLevels(resolvedModel)
      const defaultLevel = resolveReasoningLevel(resolvedModel, profile.reasoning)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        context: { contextWindow: resolvedModel.contextWindow },
        reasoning: {
          efforts: levels.map(level => ({
            id: ReasoningEffortId(level),
            name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          })),
          ...defaultLevel === undefined
            ? {}
            : { defaultEffort: ReasoningEffortId(defaultLevel) },
        },
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const profile = this.profiles.get(options.provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${options.provider}"`, 'NO_ADAPTER')
    }
    const model = resolvePiModel(profile, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const events = streamSimple(model, toPiContext(options), {
        ...profileOptions(profile, reasoning),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
