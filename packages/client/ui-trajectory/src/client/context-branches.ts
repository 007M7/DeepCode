/** Rewind-delimited trajectory branches assembled across surface rewrites. */

import type {
  ConversationContext, ConversationNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One continuous context branch; compactions stay inline while rewinds start a successor branch. */
export interface TrajectoryContextBranch {
  id: number
  contexts: readonly ConversationContext[]
  latest: ConversationContext
  nodes: readonly ConversationNode[]
  ranges: readonly TrajectoryBranchRange[]
}

/** One half-open session-event range carried by a rewind branch. */
export interface TrajectoryBranchRange {
  start: number
  end: number
}

interface MutableBranch {
  id: number
  contexts: ConversationContext[]
  latest: ConversationContext
  nodes: Map<number, ConversationNode>
  ranges: TrajectoryBranchRange[]
}

function isCompactionCheckpoint(node: ConversationNode): boolean {
  if (node.kind !== 'context') return false
  const source = node.source
  return typeof source === 'object'
    && source !== null
    && 'kind' in source
    && source.kind === 'plugin'
    && 'plugin' in source
    && source.plugin === 'compact'
}

/**
 * Join context generations across compaction/rewrite operations and split only at rewind.
 * @param contexts - Append-only context generations from the runtime fold.
 * @returns Rewind-delimited branches in creation order.
 */
export function deriveTrajectoryContextBranches(
  contexts: readonly ConversationContext[],
): readonly TrajectoryContextBranch[] {
  const mutable: MutableBranch[] = []
  for (const context of contexts) {
    const startsBranch = mutable.length === 0 || context.origin === 'rewind'
    if (startsBranch) {
      const previous = mutable.at(-1)
      const originSeq = context.originSeq ?? Number.POSITIVE_INFINITY
      if (previous !== undefined) {
        const openRange = previous.ranges.at(-1)
        if (openRange === undefined) {
          throw new Error('trajectory branch must contain an open event range')
        }
        openRange.end = originSeq
      }
      const retainedCutoff = Math.max(
        Number.NEGATIVE_INFINITY,
        ...context.nodes
          .filter(node => node.seq < originSeq)
          .map(node => node.seq),
      )
      const inheritedNodes = previous === undefined
        ? []
        : [...previous.nodes.values()].filter(node => node.seq <= retainedCutoff)
      const inheritedRanges = previous === undefined
        ? []
        : previous.ranges.flatMap((range) => {
          const end = Math.min(range.end, retainedCutoff + 1)
          return end <= range.start ? [] : [{ start: range.start, end }]
        })
      mutable.push({
        id: context.id,
        contexts: [context],
        latest: context,
        nodes: new Map(
          [...inheritedNodes, ...context.nodes.filter(node => !isCompactionCheckpoint(node))]
            .map(node => [node.seq, node]),
        ),
        ranges: [
          ...inheritedRanges,
          {
            start: context.originSeq ?? Number.NEGATIVE_INFINITY,
            end: Number.POSITIVE_INFINITY,
          },
        ],
      })
      continue
    }
    const branch = mutable.at(-1)
    if (branch === undefined) continue
    branch.contexts.push(context)
    branch.latest = context
    for (const node of context.nodes) {
      if (!isCompactionCheckpoint(node)) branch.nodes.set(node.seq, node)
    }
  }
  return mutable.map(branch => ({
    id: branch.id,
    contexts: branch.contexts,
    latest: branch.latest,
    nodes: [...branch.nodes.values()].sort((left, right) => left.seq - right.seq),
    ranges: branch.ranges,
  }))
}

/**
 * Test whether a session event belongs to one rewind branch's continuous history.
 * @param branch - Branch carrying inherited and post-rewind log ranges.
 * @param seq - Session event sequence.
 * @returns Whether the event belongs to the branch.
 */
export function trajectoryBranchContainsSeq(
  branch: TrajectoryContextBranch,
  seq: number,
): boolean {
  return branch.ranges.some(range => seq >= range.start && seq < range.end)
}
