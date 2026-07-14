/**
 * Bidirectional mapping between the harness vocabulary and pi-ai's:
 * Convert harness requests to pi-ai context and pi-ai assistant events to harness stream chunks.
 * pi-ai parses tool arguments while the harness preserves raw JSON, so conversion parses inbound
 * arguments and re-stringifies outbound values while the adapter restores provider payloads.
 * In-stream pi-ai errors become harness error/aborted finishes, and its reasoning tokens remain
 * folded into output usage because it reports no separate count.
 * @module dsh-llm-pi-ai/convert
 */

import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Message as PiMessage,
  Tool as PiTool,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

/**
 * Convert harness history to a pi-ai Context. Tool results need the tool
 * NAME (pi-ai's `toolName`), which the harness doesn't carry on the result
 * block — it is recovered from the preceding assistant tool-call with the
 * same id.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @returns the pi-ai context; `tools` is omitted entirely when the request declares none.
 */
export function toPiContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = []
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            content.push({ type: 'text', text: block.text })
            break
          case 'reasoning':
            // Without this wire-field name, pi-ai replays an empty `reasoning_content`, violating
            // DeepSeek's thinking-mode passback rule on tool-call turns.
            content.push({ type: 'thinking', thinking: block.text, thinkingSignature: 'reasoning_content' })
            break
          case 'tool-call':
            toolNames.set(block.id, block.name)
            content.push({
              type: 'toolCall',
              id: block.id,
              name: block.name,
              arguments: parseArguments(block.arguments),
            })
            break
          default:
            // plugin-added block types: not representable here.
            break
        }
      }
      messages.push({
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: 'deepseek',
        model: options.model,
        usage: emptyPiUsage(),
        stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: 0,
      })
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: result.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('') || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  const tools: PiTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))

  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts; cache fields appear only when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @returns the harness reason; `error` yields `{kind: 'error'}` with a code classified from the error text.
 */
export function mapStopReason(message: AssistantMessage): FinishReason {
  switch (message.stopReason) {
    case 'stop': return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return { kind: 'aborted' }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', message: text, code: classifyPiAiError(text) }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message) }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error) }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
