/**
 * Canonical selection of a child's final assistant output. Every surface that
 * reports "the child's answer" — backend run results and
 * `subagent/end.lastAssistantMessage` — applies this one rule so observers
 * agree: the last NON-EMPTY assistant message wins; an empty-content message
 * hosts only usage (the loop appends one when a max-tokens step assembled no
 * executable blocks) and never erases real output; without any non-empty
 * message, the text streamed so far is the answer (a partial surviving
 * cancel, error, and truncation paths).
 *
 * @module @deepseek-ai/dsh-subagent/assistant-output
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Incremental fold of the selection rule, for backends that observe a child's
 * output as it streams: session-event backends {@link push} each event, and
 * transports without session events (ACP content chunks) {@link pushText} raw
 * text into the same streamed fallback.
 */
export class AssistantOutputFold {
  private message: ContentBlock[] | undefined
  private partial: string[] = []

  /**
   * Fold one session event: a non-empty assistant message becomes the
   * candidate final answer, and a `text-delta` chunk extends the streamed
   * fallback; every other event contributes nothing.
   * @param event - the next observed session event.
   */
  push(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) this.message = content
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      this.partial.push(event.data.chunk.text)
    }
  }

  /**
   * Extend the streamed fallback with text observed outside session events.
   * @param text - the next streamed text piece (an empty piece is a no-op).
   */
  pushText(text: string): void {
    this.partial.push(text)
  }

  /**
   * Select the final output folded so far.
   * @returns the last non-empty assistant message, else the accumulated
   *   streamed text, or `undefined` when the child produced neither.
   */
  collect(): ContentBlock[] | undefined {
    if (this.message !== undefined) return this.message
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text }] : undefined
  }
}

/**
 * Apply the selection rule to one complete child-owned event suffix.
 * @param events - the child-owned events (after any seed or epoch boundary).
 * @returns the selected output, or `undefined` when the child produced none.
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  const fold = new AssistantOutputFold()
  for (const event of events) fold.push(event)
  return fold.collect()
}
