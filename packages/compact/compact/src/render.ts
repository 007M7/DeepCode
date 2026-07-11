/**
 * Plain-text transcript rendering over session events: the shared projection used wherever a
 * compaction-class consumer needs "what a model once saw" as readable text — a summarizer's
 * input, or a recall tool's output.
 * @module @deepseek-ai/dsh-compact/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Render content blocks to a single plain-text string.
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
 * Render a set of surface-node seqs as a `User:`/`Assistant:`/`Tool result:` transcript.
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
