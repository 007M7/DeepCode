/**
 * Pure translation between harness vocabulary and ACP wire types.
 * @module @deepseek-ai/dsh-acp/codec
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock as AcpContentBlock, StopReason } from '@agentclientprotocol/sdk'

/**
 * Map a harness {@link TurnEndReason} to the ACP `StopReason` wire enum.
 *
 * @param reason - the harness turn-end reason to translate.
 * @returns the legal ACP wire value per the mapping above.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
      return 'cancelled'
    case 'disposed':
      return 'cancelled'
    case 'rejected':
      return 'cancelled'
    case 'error':
      return 'end_turn'
    // Merge-extensible: an unknown future TurnEndReason kind still has to produce a legal wire
    // value (the SDK rejects unknown stopReason), so default to end_turn rather than
    // assertNever.
    default:
      return 'end_turn'
  }
}

/**
 * Translate a harness {@link ContentBlock} from a prompt into ACP content for
 * replay, or `undefined` for block kinds the bridge does not surface to the
 * client as message content. Today only `text` maps; `resource_link` is an
 * ACP prompt-only input rendered into text by {@link acpPromptToText};
 * `reasoning` is surfaced via `agent_thought_chunk`
 * streaming rather than as a message block, and `tool-call`/`tool-result`
 * are handled by the tool-call update path.
 * @param block - the harness content block to translate.
 * @returns the ACP block, or `undefined` for a kind with no message-content mapping.
 */
export function harnessBlockToAcpContent(block: ContentBlock): AcpContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    // reasoning → streamed as agent_thought_chunk, not a message block
    // tool-call / tool-result → the tool_call / tool_call_update path
    // plugin-added block types → not surfaced
    default:
      return undefined
  }
}

/**
 * Extract plain text from an ACP prompt's content blocks. Text blocks are
 * concatenated verbatim; resource links become explicit textual references so
 * baseline ACP clients can point at files without the bridge silently dropping
 * that context.
 * @param prompt - the ACP prompt blocks to flatten.
 * @returns the concatenated text, with resource links rendered as bracketed references.
 */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt
    .flatMap((block): string[] => {
      switch (block.type) {
        case 'text':
          return [block.text]
        case 'resource_link':
          return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
        default:
          return []
      }
    })
    .join('')
}

/**
 * Whether an ACP prompt contains content the bridge cannot accept. Baseline ACP
 * requires `text` and `resource_link`; richer inline payloads (`resource`,
 * image, audio, …) are rejected rather than silently dropped.
 * @param prompt - the ACP prompt blocks to inspect.
 * @returns `true` when any block is neither `text` nor `resource_link`.
 */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text' && block.type !== 'resource_link')
}
