/** Typed settlement policy for one admitted same-session goal round. */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Driver action derived from one closed goal-owned turn. */
export type GoalRoundOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'pause'; readonly reason: string }
  | { readonly kind: 'usage-limited'; readonly message: string }
  | {
    readonly kind: 'blocked'
    readonly reason: 'error' | 'max-tokens' | 'rejected' | 'unknown'
    readonly detail: string
  }
  | { readonly kind: 'disarm'; readonly reason: 'durability-failed' | 'disposed' | 'interrupted' }

/**
 * Classify one closed goal round without mutating goal state.
 * @param reason - durable reason from the round's `turn/end`.
 * @param durable - whether the closing flush reached its durability checkpoint.
 * @returns the single driver action; no abnormal outcome requests an automatic retry.
 */
export function classifyGoalRound(reason: TurnEndReason, durable: boolean): GoalRoundOutcome {
  if (!durable) return { kind: 'disarm', reason: 'durability-failed' }
  const extensibleReason: { readonly kind: string } = reason
  switch (reason.kind) {
    case 'completed':
      return { kind: 'continue' }
    case 'aborted':
      return { kind: 'pause', reason: reason.reason ?? 'cancelled' }
    case 'error':
      return reason.code === 'RATE_LIMIT'
        ? { kind: 'usage-limited', message: reason.message }
        : { kind: 'blocked', reason: 'error', detail: reason.message }
    case 'max-tokens':
      return { kind: 'blocked', reason: 'max-tokens', detail: 'model output reached max tokens' }
    case 'rejected':
      return { kind: 'blocked', reason: 'rejected', detail: reason.reason }
    case 'disposed':
      return { kind: 'disarm', reason: 'disposed' }
    case 'interrupted':
      return { kind: 'disarm', reason: 'interrupted' }
    // TurnEndReason is merge-extensible. An unknown producer cannot opt into
    // automatic retry merely by adding a tag; stop for inspection instead.
    default:
      return { kind: 'blocked', reason: 'unknown', detail: `unknown turn outcome: ${extensibleReason.kind}` }
  }
}
