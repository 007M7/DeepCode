/**
 * Chat flow derivation: ConversationSnapshot nodes -> render items. Tool
 * results group into consecutive-run tool groups (figma step-summary flow,
 * VERTICAL gap10) alternating with narration. Consecutive retry notices from
 * one turn reuse the first notice's row while projecting the latest attempt.
 * Item identity keys are stable across snapshots so the list parent can
 * subscribe to keys only while rows subscribe to content.
 */
import type { ConversationNode, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'

/** One renderable flow item; key is the React key and the parent's identity unit. */
export type ChatFlowItem =
  | { kind: 'node'; key: string; node: ConversationNode }
  | { kind: 'tool-group'; key: string; results: readonly ToolResultNode[] }

/**
 * Group finalized nodes into the step-summary flow.
 * @param nodes - snapshot nodes (surface order).
 * @returns flow items; consecutive tool results and same-turn retry notices reuse their first key.
 */
export function deriveChatFlow(nodes: readonly ConversationNode[]): ChatFlowItem[] {
  const items: ChatFlowItem[] = []
  let group: ToolResultNode[] | null = null
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (group === null) {
        group = [node]
        items.push({ kind: 'tool-group', key: `g${node.seq}`, results: group })
      } else {
        group.push(node)
      }
    } else if (node.kind === 'model-retry') {
      group = null
      const previous = items[items.length - 1]
      if (
        previous?.kind === 'node'
        && previous.node.kind === 'model-retry'
        && previous.node.turn === node.turn
      ) {
        items[items.length - 1] = { ...previous, node }
      } else {
        items.push({ kind: 'node', key: `n${node.seq}`, node })
      }
    } else {
      group = null
      items.push({ kind: 'node', key: `n${node.seq}`, node })
    }
  }
  return items
}

/**
 * Key projection for the list parent's selector (content-blind identity).
 * @param items - derived flow items.
 * @returns joined key string usable with Object.is short-circuiting.
 */
export function flowKeys(items: readonly ChatFlowItem[]): string {
  return items.map(i => i.key).join('|')
}
