import type {
  ConversationLocation, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode,
} from './trajectory-contract.ts'

/**
 * Resolve the best loaded Location for one target-local Context.
 *
 * @param context - Context whose loaded matches provide the Location.
 * @returns The start Location, first-match Location, or unresolved fallback.
 */
export function trajectoryContextLocation(
  context: ConversationNodeContext,
): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * Wrap one contribution in the Engine-owned target envelope.
 *
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param data - Trajectory-specific contribution payload.
 * @returns The contribution wrapped as a Trajectory view node.
 */
export function trajectoryNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'trajectory',
    anchorSeq,
    data,
  }
}
