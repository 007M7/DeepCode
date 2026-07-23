/**
 * Pure translation between the harness lifecycle and the automation-only ACP wire.
 * @module @deepseek-ai/dsh-acp/codec
 */

import type { ContentBlock as AcpContentBlock, StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
    case 'disposed':
    case 'rejected':
    case 'interrupted':
      return 'cancelled'
    case 'error':
      return 'end_turn'
    // TurnEndReason is merge-extensible; future variants still need a legal wire value.
    default:
      return 'end_turn'
  }
}

/**
 * Concatenate an ACP prompt's text blocks.
 * @param prompt - supported ACP prompt blocks.
 * @returns text in wire order.
 */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Whether a prompt asks the automation bridge to carry non-text content.
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is not text.
 */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text')
}
