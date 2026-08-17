/**
 * Pure flow derivation: collapse consecutive settled tool-call rows that share
 * one tool name into a single expandable group, so a run of reads or greps does
 * not repeat the same title per call. Running calls and calls whose name is
 * unknown (window cut off their call head) always stay single rows; a group
 * needs at least two members, otherwise the first member renders alone.
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isSettledTool } from '../contract/chat-nodes.ts'

/** One ordinary flow row: a single chat node. */
export interface FlowNodeRow {
  readonly kind: 'node'
  readonly key: string
}

/** One collapsed run of consecutive same-name settled tool calls. */
export interface FlowToolGroupRow {
  readonly kind: 'tool-group'
  /** First member's node key: the stable identity of the whole run. */
  readonly key: string
  readonly toolName: string
  readonly memberKeys: readonly string[]
}

/** Flow row union consumed by the chat view's render pass. */
export type FlowRow = FlowNodeRow | FlowToolGroupRow

/** Wire tool name of a root call, or undefined when the head is out of window. */
function toolRootName(root: ToolCallBlock): string | undefined {
  return 'kind' in root ? root.call?.name : root.name
}

/**
 * Derive the flow row list from the chat node order, merging runs of
 * consecutive same-name settled tool calls into groups.
 * @param order - chat node keys in flow order.
 * @param getNode - node lookup keyed by order entries.
 * @returns the flow rows, one per ordinary node or tool-call run.
 */
export function deriveFlowRows(
  order: readonly string[],
  getNode: (key: string) => ChatNode | undefined,
): FlowRow[] {
  const rows: FlowRow[] = []
  let index = 0
  while (index < order.length) {
    const key = order[index] as string
    const node = getNode(key)
    const name = node?.kind === 'tool-call' && isSettledTool(node.data.root)
      ? toolRootName(node.data.root)
      : undefined
    if (name === undefined || name === '') {
      rows.push({ kind: 'node', key })
      index += 1
      continue
    }
    let end = index + 1
    while (end < order.length) {
      const next = getNode(order[end] as string)
      if (next?.kind !== 'tool-call' || !isSettledTool(next.data.root)
        || toolRootName(next.data.root) !== name) break
      end += 1
    }
    if (end - index >= 2) {
      rows.push({
        kind: 'tool-group',
        key,
        toolName: name,
        memberKeys: order.slice(index, end),
      })
    } else {
      rows.push({ kind: 'node', key })
    }
    index = end
  }
  return rows
}
