/**
 * goals domain contract. Method signatures are the source of truth:
 * unary methods take the RpcRequest<P> narrow form and the impl echoes rpcId.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Identifies one goal across its durable revisions. */
export type GoalId = Branded<'GoalId'>

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  readonly id: GoalId
  readonly revision: number
}

/** Durable continuation phase. */
export type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  readonly code: string
  readonly message: string
}

/** Whether this live process may automatically continue an active goal. */
export type GoalActivation = 'armed' | 'disarmed'

/** Current goal projection, including values derived from the session log. */
export interface GoalView {
  readonly id: GoalId
  readonly revision: number
  readonly objective: string
  readonly phase: GoalPhase
  readonly blockedReason?: GoalBlockReason
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly activation: GoalActivation
}

/** Input whose omitted round cap is resolved by the service configuration. */
export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

/** Fields changed by an edit; at least one must be present. */
export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

/** Goal-domain unary methods. */
export interface GoalsApi {
  /** Read the current goal for one session. Returns null when no goal is current. */
  get(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ goal: GoalView | null }>>

  /** Create and arm a goal. */
  create(request: RpcRequest<{ sessionId: SessionId; objective: string; maxGoalRounds?: number }>):
  Promise<RpcResponse<{ goal: GoalView }>>

  /** Edit objective and/or round cap without changing phase. */
  edit(request: RpcRequest<{ sessionId: SessionId; ref: GoalRef; objective?: string; maxGoalRounds?: number }>):
  Promise<RpcResponse<{ goal: GoalView }>>

  /** Pause an active goal and disarm automatic continuation. */
  pause(request: RpcRequest<{ sessionId: SessionId; ref: GoalRef }>):
  Promise<RpcResponse<{ goal: GoalView }>>

  /** Resume and arm a stopped goal. */
  resume(request: RpcRequest<{ sessionId: SessionId; ref: GoalRef }>):
  Promise<RpcResponse<{ goal: GoalView }>>

  /** Mark a current non-complete goal complete and disarm it. */
  complete(request: RpcRequest<{ sessionId: SessionId; ref: GoalRef }>):
  Promise<RpcResponse<{ goal: GoalView }>>

  /** Clear the current goal while retaining a durable tombstone and history. */
  clear(request: RpcRequest<{ sessionId: SessionId; ref: GoalRef }>):
  Promise<RpcResponse<{ cleared: true }>>
}
