/**
 * `PiAiAdapter`: the `@earendil-works/pi-ai`-backed implementation of the
 * harness LLM seam, pointed at a DeepSeek (OpenAI-compatible) endpoint.
 *
 * This adapter exists as a design-verification twin of
 * `@deepseek-ai/dsh-llm-deepseek`: same models, same wire protocol,
 * completely different internals (a unified LLM library with its own event
 * vocabulary vs hand-rolled fetch/SSE). Anything the StreamChunk protocol
 * cannot express for BOTH implementations is a core-vocabulary bug.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { stream as piStream } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toPiContext, toStreamChunks } from './convert.ts'

/** Reasoning levels surfaced by this adapter (DeepSeek wire: high|max). */
export type PiAiReasoning = 'off' | 'high' | 'xhigh'

export interface PiAiAdapterOptions {
  apiKey: string
  baseURL: string
  /** Thinking level applied to every request ('off' disables thinking). */
  reasoning?: PiAiReasoning | undefined
}

/** Build the inline pi-ai model descriptor for one DeepSeek model name. */
export function buildModel(modelId: string, options: PiAiAdapterOptions): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: options.baseURL,
    // Always true: pi-ai only emits the DeepSeek `thinking` field for
    // reasoning-capable models, deriving enabled/disabled from whether a
    // reasoningEffort option is passed. DeepSeek's provider default is
    // ENABLED, so 'off' must send an explicit {type: 'disabled'} — which
    // requires this flag to stay on.
    reasoning: true,
    // DeepSeek's official effort levels: high|max (xhigh maps to max).
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 64_000,
    compat: {
      // Auto-detection only fires for *.deepseek.com base URLs; the internal
      // endpoint (and test mocks) need these set explicitly.
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
      supportsReasoningEffort: true,
      // DeepSeek documents max_tokens (not OpenAI's max_completion_tokens).
      maxTokensField: 'max_tokens',
    },
  }
}

/**
 * pi-ai-backed adapter. One instance serves every registered model name.
 *
 * Implementation notes:
 * - `GenerateOptions.stop` is injected via pi-ai's `onPayload` hook (its
 *   public options omit stop sequences).
 * - `prefill` throws UNSUPPORTED (same contract as dsh-llm-deepseek).
 * - pi-ai reports request failures as in-stream error events; convert.ts
 *   maps them to `finish {kind:'error'|'aborted'}` chunks rather than
 *   throwing — both are sanctioned StreamChunk error paths.
 */
export class PiAiAdapter extends LlmAdapter {
  constructor(private readonly options: PiAiAdapterOptions) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.prefill !== undefined) {
      throw new LlmError(
        'prefill is not supported by the pi-ai adapter',
        'UNSUPPORTED',
      )
    }

    const model = buildModel(options.model, this.options)
    // Undefined config means "provider default" (DeepSeek: thinking ENABLED),
    // matching llm-deepseek's omission semantics. pi-ai derives the wire
    // thinking toggle from whether reasoningEffort is passed, so undefined
    // maps to 'high' here; only an explicit 'off' disables thinking.
    const reasoning = this.options.reasoning ?? 'high'

    // pi-ai's event stream has no iterator-return cancellation hook: if our
    // consumer stops early (break / loop abort), the underlying HTTP stream
    // would keep draining. Chain an internal controller onto the caller's
    // signal and abort it when this generator exits for any reason.
    const controller = new AbortController()
    const onCallerAbort = (): void => { controller.abort(options.signal?.reason) }
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const events = piStream(model, toPiContext(options), {
        apiKey: this.options.apiKey,
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
        signal: controller.signal,
        ...reasoning !== 'off' ? { reasoningEffort: reasoning } : {},
        ...options.stop !== undefined ? {
          // pi-ai's options omit stop sequences; inject them into the raw body.
          onPayload: (payload: unknown) => {
            (payload as Record<string, unknown>).stop = options.stop
            return payload
          },
        } : {},
        maxRetries: 0,
      })

      yield* toStreamChunks(events)
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort)
      controller.abort('consumer stopped streaming')
    }
  }
}
