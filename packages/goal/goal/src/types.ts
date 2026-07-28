/**
 * Durable and live vocabulary for one same-session goal.
 * @module @deepseek-ai/dsh-goal/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Identifies one goal across its durable revisions. */
export type GoalId = Branded<'GoalId'>

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  /** Stable goal identity. */
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Durable continuation phase. Activation is process-local and separate. */
export type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Full durable state written by every non-clear goal mutation. */
export interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/** Whether this live process may automatically continue an active goal. */
export type GoalActivation = 'armed' | 'disarmed'

/** Current goal projection, including values derived from the session log. */
export interface GoalView extends GoalSnapshot {
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}

/** Goal state-changing verbs recorded in the durable source change. */
export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

/** Full-snapshot goal mutation retained in a model-visible context event. */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current goal is cleared. */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

/** Durable change union carried by a goal-owned round-zero message source. */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** Message attribution for durable goal state and continuation rounds. */
export interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalId
  readonly revision: number
  /** Zero for state changes; positive for admitted continuation rounds. */
  readonly round: number
  /** Complete durable mutation carried only by round-zero state-change messages. */
  readonly change?: GoalChangeMeta
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    goal: GoalMessageSource
  }
}

/** Pure replay fold of durable goal facts. */
export interface FoldedGoal {
  /** Current goal, absent after a clear or before the first create. */
  readonly goal?: GoalSnapshot
  /** Highest admitted round for the current goal. */
  readonly roundsStarted: number
  /** Current goal creation time, absent without a current goal. */
  readonly createdAt?: number
  /** Current goal mutation time, absent without a current goal. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: GoalRef
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

/** Live notification after one goal mutation has been accepted for logging. */
export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** Absent for a clear tombstone. */
  readonly goal?: GoalView
}

/** Stable error codes for rejected goal reads and mutations. */
export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'

declare module 'cordis' {
  interface Events {
    /**
     * Goal mutation accepted by one live agent. The matching context event is
     * already appended or queued in that agent's active tool-batch FIFO.
     * Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param agent - agent whose session owns the goal.
     * @param change - fresh current projection or clear tombstone.
     * @mode emit
     */
    'goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, agent: Agent, change: GoalChanged): void
  }
}
