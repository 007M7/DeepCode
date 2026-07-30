/**
 * Chat flow derivation: ConversationSnapshot nodes -> render items. Tool
 * results group into consecutive-run tool groups (figma step-summary flow,
 * VERTICAL gap10) alternating with narration; everything else passes through.
 * Item identity keys are stable across snapshots so the list parent can
 * subscribe to keys only while rows subscribe to content. IconActions ownership
 * (last content assistant per turn) is derived here too so ChatView and the
 * flow share one gate.
 */
import type {
  AssistantBlock, ConversationNode, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One renderable flow item; key is the React key and the parent's identity unit. */
export type ChatFlowItem =
  | { kind: 'node'; key: string; node: ConversationNode }
  | { kind: 'tool-group'; key: string; results: readonly ToolResultNode[] }

/** True when the node has model-visible text content worth IconActions chrome. */
function hasContentText(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some(block => block.kind === 'text' && block.text.trim() !== '')
}

/** An assistant node that renders nothing: only tool-call heads (rows render
 *  via the grouping pass) and blank text/reasoning. Skipped by the flow so it
 *  neither costs column gaps nor splits a tool-row run. Interrupted nodes
 *  always render (the 已停止 marker). */
function rendersNothing(node: ConversationNode): boolean {
  return node.kind === 'assistant' && node.interrupted !== true
    && node.blocks.every(b => b.kind === 'tool-call'
      || ((b.kind === 'text' || b.kind === 'reasoning') && b.text.trim() === ''))
}

/**
 * Turn whose content assistants must stay chrome-free while the turn is still
 * running. Prefers the streaming partial, else the first in-flight tool call;
 * returns null when `running` is false or neither signal exists yet (a brand-new
 * turn before the first step must not strip a prior settled answer's seat).
 * @param running - snapshot `running` bit.
 * @param partial - in-flight assistant partial, or null.
 * @param runningCalls - in-flight tool rows (same turn while tools execute).
 * @returns Turn to withhold, or null.
 */
export function withholdActionsTurn(
  running: boolean,
  partial: { turn: number } | null,
  runningCalls: readonly { turn: number }[],
): number | null {
  if (!running) return null
  if (partial !== null) return partial.turn
  return runningCalls[0]?.turn ?? null
}

/**
 * Seq set of assistants that own IconActions: the last content-text assistant
 * in each *settled* turn. Mid-turn narration and every content assistant of a
 * still-running turn stay chrome-free (no flash while tools run or the next
 * step streams).
 * @param nodes - snapshot nodes (surface order).
 * @param withholdTurn - active turn from {@link withholdActionsTurn}, or null.
 * @returns Seq values ChatView may pass as `time` into AssistantMarkdown.
 */
export function assistantActionsSeqs(
  nodes: readonly ConversationNode[],
  withholdTurn: number | null = null,
): ReadonlySet<number> {
  const lastByTurn = new Map<number, number>()
  for (const node of nodes) {
    if (node.kind !== 'assistant' || !hasContentText(node.blocks)) continue
    if (withholdTurn !== null && node.turn === withholdTurn) continue
    lastByTurn.set(node.turn, node.seq)
  }
  return new Set(lastByTurn.values())
}

/**
 * Group finalized nodes into the step-summary flow.
 * @param nodes - snapshot nodes (surface order).
 * @returns flow items; consecutive tool-results merged into one group keyed by the first seq.
 */
export function deriveChatFlow(nodes: readonly ConversationNode[]): ChatFlowItem[] {
  const items: ChatFlowItem[] = []
  let group: ToolResultNode[] | null = null
  for (const node of nodes) {
    if (rendersNothing(node)) continue
    if (node.kind === 'tool-result') {
      if (group === null) {
        group = [node]
        items.push({ kind: 'tool-group', key: `g${node.seq}`, results: group })
      } else {
        group.push(node)
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
