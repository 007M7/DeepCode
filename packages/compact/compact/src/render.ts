/**
 * Pure shared transcript projection for summarization and recall, so both
 * render the same log span byte-for-byte under replay.
 * @module @deepseek-ai/dsh-compact/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Render text directly, reasoning as a tagged span, and every other block as a
 * type-tagged placeholder. Tool results recurse into nested content; empty
 * blocks contribute nothing and rendered blocks join with newlines.
 *
 * @param blocks - the content blocks to render.
 * @returns the newline-joined plain-text rendering; empty string when nothing renders.
 */
export function renderContentBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text)
        break
      case 'reasoning':
        if (block.text) parts.push(`[reasoning: ${block.text}]`)
        break
      case 'tool-call':
        parts.push(`[tool-call: ${block.name}(${block.arguments})]`)
        break
      case 'tool-result': {
        const inner = renderContentBlocks(block.content)
        parts.push(inner ? `[tool-result: ${inner}]` : '[tool-result]')
        break
      }
      // ContentBlockMap is merge-extensible — render an unknown block as a
      // bare type-tagged placeholder so a plugin-added block type is still
      // signalled to the reader rather than dropped.
      default:
        parts.push(`[${(block as ContentBlock).type}]`)
    }
  }
  return parts.join('\n')
}

/**
 * Render message-producing events as a role-labeled transcript. `seqs` are
 * walked in caller-supplied surface order, which may differ from numeric log
 * order after replacement; non-surface and unknown merged events are skipped.
 *
 * @param events - the session log the seqs index into (`session.events`).
 * @param seqs - the surface-node seqs to render, in surface order.
 * @returns the transcript, entries joined by blank lines; empty string when nothing renders.
 */
export function renderTranscript(events: readonly SessionEvent[], seqs: readonly number[]): string {
  const lines: string[] = []

  for (const seq of seqs) {
    const event = events[seq]
    if (!event) continue

    switch (event.type) {
      case 'user/message': {
        const text = renderContentBlocks(event.data.content)
        if (text) lines.push(`User: ${text}`)
        break
      }
      case 'assistant/message': {
        const text = renderContentBlocks(event.data.content)
        if (text) lines.push(`Assistant: ${text}`)
        break
      }
      case 'tool/result': {
        const text = renderContentBlocks(event.data.content)
        const label = event.data.isError ? 'Tool error' : 'Tool result'
        if (text) lines.push(`${label} (call ${event.data.callId}): ${text}`)
        break
      }
      case 'context/message': {
        const text = renderContentBlocks(event.data.content)
        if (text) lines.push(`[Context: ${text}]`)
        break
      }
      case 'steering/message': {
        const text = renderContentBlocks(event.data.content)
        if (text) lines.push(`[Steering: ${text}]`)
        break
      }
      default:
        break
    }
  }

  return lines.join('\n\n')
}
