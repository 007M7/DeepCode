/** Typed settlement policy for one admitted same-session goal round. */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Driver action derived from one closed goal-owned turn. */
export type GoalRoundOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'pause'; readonly reason: string }
  | {
    readonly kind: 'blocked'
    readonly code: 'usage-limited' | 'turn-error' | 'max-tokens' | 'unknown-turn-outcome'
    readonly message: string
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
      return { kind: 'pause', reason: 'cancelled' }
    case 'error': {
      const { code, message } = reason.failure ?? reason
      return code === 'RATE_LIMIT' || code === 'QUOTA'
        ? { kind: 'blocked', code: 'usage-limited', message }
        : { kind: 'blocked', code: 'turn-error', message }
    }
    case 'max-tokens':
      return { kind: 'blocked', code: 'max-tokens', message: 'model output reached max tokens' }
    case 'disposed':
      return { kind: 'disarm', reason: 'disposed' }
    case 'interrupted':
      return { kind: 'disarm', reason: 'interrupted' }
    // TurnEndReason is merge-extensible. An unknown producer cannot opt into
    // automatic retry merely by adding a tag; stop for inspection instead.
    default:
      return {
        kind: 'blocked',
        code: 'unknown-turn-outcome',
        message: `unknown turn outcome: ${extensibleReason.kind}`,
      }
  }
}
