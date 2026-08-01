/**
 * Chat flow derivation: ConversationSnapshot nodes -> render items. Tool
 * results group into consecutive-run tool groups (figma step-summary flow,
 * VERTICAL gap10) alternating with narration. Consecutive retry notices
 * reuse the first notice's row while projecting the latest retry turn.
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
 * Paths a call view reports having created or changed, by render intent rather
 * than tool name: a diff card, or a generic card whose kind is `edit` (the
 * shape `str_replace_editor`'s insert presents). Every other card produces
 * nothing to open — a read looked, a delete removed, a terminal ran.
 */
function producedPaths(view: ToolResultNode['callView']): readonly string[] {
  if (view === null) return []
  if (view.card === 'diff') return (view.locations ?? []).map(location => location.path)
  if (view.card === 'generic' && view.kind === 'edit') {
    return (view.locations ?? []).map(location => location.path)
  }
  return []
}

/**
 * Seq set of assistants that own IconActions: the last content-text assistant
 * in each turn. Mid-turn narration (text before tools) stays chrome-free.
 * @param nodes - snapshot nodes (surface order).
 * @returns Seq values ChatView may pass as `time` into AssistantMarkdown.
 */
export function assistantActionsSeqs(nodes: readonly ConversationNode[]): ReadonlySet<number> {
  const lastByTurn = new Map<number, number>()
  for (const node of nodes) {
    if (node.kind !== 'assistant' || !hasContentText(node.blocks)) continue
    lastByTurn.set(node.turn, node.seq)
  }
  return new Set(lastByTurn.values())
}

/**
 * Files each turn produced, keyed by the assistant seq that closes it — the
 * same anchor {@link assistantActionsSeqs} elects, so the row lands under the
 * message that reports the work rather than after some mid-turn narration.
 *
 * The source is the mutation tools' own follow-along `locations`, not the
 * closing prose: a produced file must be listed whether or not the model
 * remembered to name it. A mutation is recognized by render intent, not by
 * tool name — a diff card, or a generic card whose `kind` is `edit` (the shape
 * `str_replace_editor`'s insert presents) — so a new mutation tool joins by
 * declaring what it does. Reads contribute nothing (looking at a file does not
 * produce it), and neither do deletes (there is nothing left to open) or
 * failed calls. Paths keep first-seen order and appear once, so a file written
 * and then edited in the same turn is one entry.
 *
 * Accumulation resets on the turn boundary, not merely at the closing
 * assistant: a turn that mutates files and then ends without content text
 * (interrupted mid-tool, or a turn whose last text precedes its last tool
 * result) must not spill its paths into the next turn's row, nor leave `seen`
 * suppressing a file the next turn legitimately rewrites.
 * @param nodes - snapshot nodes (surface order).
 * @returns Per-closing-seq produced paths; a turn that produced none is absent.
 */
export function turnDeliverables(nodes: readonly ConversationNode[]): ReadonlyMap<number, readonly string[]> {
  const closing = assistantActionsSeqs(nodes)
  const byClosingSeq = new Map<number, readonly string[]>()
  let pending: string[] = []
  let seen = new Set<string>()
  let turn: number | undefined
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.isError) continue
      for (const path of producedPaths(node.callView)) {
        if (seen.has(path)) continue
        seen.add(path)
        pending.push(path)
      }
      continue
    }
    // Tool results carry no turn of their own, so the boundary is read off the
    // nodes that do. A user message opens a turn without reporting a number,
    // which is why the tracked turn goes back to undefined there: the next
    // node to report one is stating the current turn, not entering a new one.
    if (node.kind === 'user') {
      turn = undefined
      pending = []
      seen = new Set()
    } else if ('turn' in node) {
      if (turn !== undefined && node.turn !== turn) {
        pending = []
        seen = new Set()
      }
      turn = node.turn
    }
    if (node.kind !== 'assistant' || !closing.has(node.seq)) continue
    if (pending.length > 0) byClosingSeq.set(node.seq, pending)
    pending = []
    seen = new Set()
  }
  return byClosingSeq
}

/**
 * Group finalized nodes into the step-summary flow.
 * @param nodes - snapshot nodes in human-transcript and durable-notice order.
 * @returns flow items; consecutive tool results group and retry notices reuse their first key.
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
    } else if (node.kind === 'model-retry') {
      group = null
      const previous = items[items.length - 1]
      if (
        previous?.kind === 'node'
        && previous.node.kind === 'model-retry'
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
