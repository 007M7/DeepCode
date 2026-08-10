import type {
  ConversationLocation, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode,
} from './trajectory-contract.ts'

/** Resolve the best loaded Location for one target-local Context. */
export function trajectoryContextLocation(
  context: ConversationNodeContext,
): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** Wrap one contribution in the Engine-owned target envelope. */
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
