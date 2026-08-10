/**
 * Canonical selection of a child's final assistant output from its session
 * events. Every surface that reports "the child's answer" — backend run
 * results and `subagent/end.lastAssistantMessage` — applies this one rule so
 * observers agree: the last NON-EMPTY assistant message wins; an empty-content
 * message hosts only usage (the loop appends one when a max-tokens step
 * assembled no executable blocks) and never erases real output; without any
 * non-empty message, the text streamed so far is the answer (a partial
 * surviving cancel, error, and truncation paths).
 *
 * @module @deepseek-ai/dsh-subagent/assistant-output
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The content one event contributes as a candidate final answer: an
 * `assistant/message` with non-empty content. An empty-content message hosts
 * only usage and contributes none.
 * @param event - any session event.
 * @returns the message content, or `undefined` when this event is not a
 *   non-empty assistant message.
 */
export function assistantMessageOutput(event: SessionEvent): ContentBlock[] | undefined {
  if (event.type !== 'assistant/message') return undefined
  const content = event.data.message.content
  return content.length > 0 ? content : undefined
}

/**
 * Select the final assistant output from one child-owned event suffix: the
 * last non-empty assistant message, else the accumulated `text-delta` stream.
 * @param events - the child-owned events (after any seed or epoch boundary).
 * @returns the selected output, or `undefined` when the child produced none.
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  let message: ContentBlock[] | undefined
  const partial: string[] = []
  for (const event of events) {
    const content = assistantMessageOutput(event)
    if (content !== undefined) {
      message = content
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      partial.push(event.data.chunk.text)
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}
