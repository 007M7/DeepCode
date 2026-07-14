/**
 * Pi-ai-backed DeepSeek adapter and design twin of the hand-rolled adapter.
 * Both implementations must fit the same provider-neutral stream vocabulary.
 * @module dsh-llm-pi-ai/adapter
 */

import { stream as piStream } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { attributionHeaders, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toPiContext, toStreamChunks } from './convert.ts'

/** Reasoning levels surfaced by this adapter (DeepSeek wire: high|max). */
export type PiAiReasoning = 'off' | 'high' | 'xhigh'

/** Constructor options for {@link PiAiAdapter}; the plugin's `apply` resolves them from Config + environment. */
export interface PiAiAdapterOptions {
  /** Bearer token pi-ai sends on every request. */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Thinking level applied to every request ('off' disables thinking). */
  reasoning?: PiAiReasoning | undefined
}

/**
 * Build the inline pi-ai model descriptor for one DeepSeek model name.
 * @param modelId - harness model name; sent verbatim on the wire.
 * @param options - adapter options; only `baseURL` is read here (key and reasoning apply per request, not per descriptor).
 * @returns a descriptor with every DeepSeek compat flag explicit — pi-ai's URL-based auto-detection is never relied on.
 */
export function buildModel(modelId: string, options: PiAiAdapterOptions): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: options.baseURL,
    // Keep reasoning support enabled so `off` can send DeepSeek's explicit
    // disabled marker rather than falling back to the provider's enabled default.
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

type Payload = {
  tools?: { function?: { strict?: unknown } }[]
  messages?: {
    role?: unknown
    tool_calls?: { id?: unknown; function?: { arguments?: unknown } }[]
  }[]
  reasoning_effort?: unknown
  stop?: unknown
}

function rawToolArguments(options: GenerateOptions): Map<CallId, string> {
  const raw = new Map<CallId, string>()
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') raw.set(block.id, block.arguments)
    }
  }
  return raw
}

function patchPayload(payload: unknown, options: GenerateOptions, reasoning: PiAiReasoning | undefined): unknown {
  /* v8 ignore next -- pi-ai onPayload always receives an object; tolerate unusual future hooks defensively */
  if (typeof payload !== 'object' || payload === null) return payload
  const body = payload as Payload

  if (reasoning === undefined) {
    delete body.reasoning_effort
  }
  if (options.stop !== undefined) {
    body.stop = options.stop
  }

  // pi-ai stamps its own `strict` default on every serialized tool; the
  // harness tool contract has no strict field and the hand-rolled twin sends
  // none, so scrub it for wire parity.
  for (const tool of body.tools ?? []) {
    /* v8 ignore next -- malformed pi-ai payload guard: real tool entries always carry function */
    if (tool.function === undefined) continue
    delete tool.function.strict
  }

  const rawById = rawToolArguments(options)
  /* v8 ignore next -- defensive for non-chat payloads; OpenAI chat payloads always carry messages */
  for (const message of body.messages ?? []) {
    if (message.role !== 'assistant') continue
    /* v8 ignore next -- assistant messages without tool_calls need no raw-argument patch */
    for (const call of message.tool_calls ?? []) {
      /* v8 ignore next -- malformed pi-ai payload guard: real tool calls always carry a string id */
      if (typeof call.id !== 'string') continue
      const raw = rawById.get(CallId(call.id))
      /* v8 ignore next -- pi-ai always emits a function object for assistant tool_calls; guard malformed payloads defensively */
      if (raw !== undefined && call.function !== undefined) call.function.arguments = raw
    }
  }

  return body
}

/**
 * pi-ai-backed adapter. One instance serves every registered model name.
 *
 * Implementation notes:
 * - `onPayload` patches provider payload details pi-ai cannot express directly:
 *   stop sequences, scrubbing pi-ai's own per-tool `strict` default (the
 *   hand-rolled twin sends no such field), omitted reasoning effort, and raw
 *   replayed tool-call arguments.
 * - pi-ai reports request failures as in-stream error events; convert.ts
 *   maps them to `finish {kind:'error'|'aborted'}` chunks rather than
 *   throwing — both are sanctioned StreamChunk error paths.
 */
export class PiAiAdapter extends LlmAdapter {
  constructor(private readonly options: PiAiAdapterOptions) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = buildModel(options.model, this.options)
    // Undefined config means "provider default" (DeepSeek: thinking ENABLED),
    // matching llm-deepseek's omission semantics. pi-ai derives the wire
    // thinking toggle from whether reasoningEffort is passed, so undefined maps
    // internally to 'high' to get `thinking: enabled`; patchPayload then removes
    // `reasoning_effort` so the provider chooses its default effort.
    const reasoning = this.options.reasoning ?? 'high'

    // Pi-ai has no iterator-return cancellation hook. Chain an internal signal
    // and abort it when this generator exits so early consumers stop the HTTP stream.
    const controller = new AbortController()
    const onCallerAbort = (): void => { controller.abort(options.signal?.reason) }
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const events = piStream(model, toPiContext(options), {
        apiKey: this.options.apiKey,
        // pi-ai merges caller headers last over its provider defaults, so the
        // harness attribution always reaches the wire.
        headers: attributionHeaders(),
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
        signal: controller.signal,
        ...reasoning !== 'off' ? { reasoningEffort: reasoning } : {},
        onPayload: payload => patchPayload(payload, options, this.options.reasoning),
        maxRetries: 0,
      })

      yield* toStreamChunks(events)
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort)
      controller.abort('consumer stopped streaming')
    }
  }
}
