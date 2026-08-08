import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationNode, RunningToolCall, ToolCallBlock, ToolResultNode,
} from './conversation.ts'

interface ProjectedBlock {
  source: ToolCallBlock
  children: readonly ToolCallBlock[]
  value: ToolCallBlock
}

function sameBlocks(
  left: readonly ToolCallBlock[],
  right: readonly ToolCallBlock[],
): boolean {
  return left.length === right.length
    && left.every((block, index) => block === right[index])
}

/**
 * Owns Code Dispatch pairing and projects its private parent index into the
 * recursive Tool call contract exposed by conversation snapshots.
 */
export class ToolCallTree {
  private readonly childrenByParent = new Map<string, readonly ToolCallBlock[]>()
  private readonly projectedByCall = new Map<string, ProjectedBlock>()
  private revision = 0
  private nodesCache: {
    source: readonly ConversationNode[]
    revision: number
    value: readonly ConversationNode[]
  } | null = null
  private runningCache: {
    source: readonly RunningToolCall[]
    revision: number
    value: readonly RunningToolCall[]
  } | null = null

  /** Forget all event-derived child calls before replaying a new window. */
  reset(): void {
    this.childrenByParent.clear()
    this.projectedByCall.clear()
    this.revision++
  }

  /**
   * Fold one event when it belongs to the Code Dispatch lifecycle.
   * @param event - Session event from the current live or history window.
   * @returns Whether the event was consumed as a child-call lifecycle event.
   */
  apply(event: SessionEvent): boolean {
    if ((event.type as string) === 'tool/code-dispatch-start') {
      const data = event.data as unknown as {
        parentCallId: string
        subCallId: string
        name: string
        arguments: unknown
      }
      const running: RunningToolCall = {
        callId: data.subCallId,
        name: data.name,
        argsRaw: JSON.stringify(data.arguments),
        turn: 0,
        step: 0,
        time: event.time,
        callView: null,
        subCalls: [],
      }
      const siblings = this.childrenByParent.get(data.parentCallId) ?? []
      this.childrenByParent.set(data.parentCallId, [...siblings, running])
      this.revision++
      return true
    }
    if ((event.type as string) !== 'tool/code-dispatch') return false
    const data = event.data as unknown as {
      parentCallId: string
      subCallId: string
      name: string
      arguments: unknown
      isError: boolean
      content: ContentBlock[]
    }
    const siblings = this.childrenByParent.get(data.parentCallId) ?? []
    const at = siblings.findIndex(sub => sub.callId === data.subCallId)
    const started = at === -1 ? undefined : siblings[at]
    const settled: ToolResultNode = {
      kind: 'tool-result',
      seq: event.seq,
      time: event.time,
      callId: data.subCallId,
      call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
      callTime: started?.time ?? null,
      content: data.content,
      isError: data.isError,
      callView: null,
      resultView: null,
      subCalls: [],
    }
    this.childrenByParent.set(
      data.parentCallId,
      at === -1
        ? [...siblings, settled]
        : siblings.map((sub, index) => index === at ? settled : sub),
    )
    this.revision++
    return true
  }

  /**
   * Attach recursively projected children to all settled roots in a node list.
   * @param nodes - Cache-stable base conversation nodes.
   * @returns The original list when no root changed, otherwise a structurally shared list.
   */
  projectNodes(nodes: readonly ConversationNode[]): readonly ConversationNode[] {
    if (this.nodesCache?.source === nodes && this.nodesCache.revision === this.revision) {
      return this.nodesCache.value
    }
    let changed = false
    const projected = nodes.map((node): ConversationNode => {
      if (node.kind !== 'tool-result') return node
      const value = this.projectBlock(node) as ToolResultNode
      changed ||= value !== node
      return value
    })
    const value = changed ? projected : nodes
    this.nodesCache = { source: nodes, revision: this.revision, value }
    return value
  }

  /**
   * Attach recursively projected children to all running root calls.
   * @param calls - Cache-stable base running calls.
   * @returns The original list when no root changed, otherwise a structurally shared list.
   */
  projectRunningCalls(calls: readonly RunningToolCall[]): readonly RunningToolCall[] {
    if (this.runningCache?.source === calls && this.runningCache.revision === this.revision) {
      return this.runningCache.value
    }
    let changed = false
    const projected = calls.map((call): RunningToolCall => {
      const value = this.projectBlock(call) as RunningToolCall
      changed ||= value !== call
      return value
    })
    const value = changed ? projected : calls
    this.runningCache = { source: calls, revision: this.revision, value }
    return value
  }

  private projectBlock(block: ToolCallBlock): ToolCallBlock {
    const children = this.childrenByParent.get(block.callId) ?? block.subCalls
    const projectedChildren = children.map(child => this.projectBlock(child))
    const childValue = sameBlocks(children, projectedChildren)
      ? children
      : projectedChildren
    const cached = this.projectedByCall.get(block.callId)
    if (cached?.source === block && sameBlocks(cached.children, childValue)) {
      return cached.value
    }
    const value: ToolCallBlock = block.subCalls === childValue
      ? block
      : { ...block, subCalls: childValue }
    this.projectedByCall.set(block.callId, {
      source: block,
      children: childValue,
      value,
    })
    return value
  }
}
