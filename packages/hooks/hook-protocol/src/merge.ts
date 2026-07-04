/**
 * Merge the outcomes of MULTIPLE hooks that matched one hook point into a single
 * most-restrictive {@link MergedHookOutcome}. Both reference engines run matched
 * hooks concurrently and fold their results; the precedence rules here are the
 * intersection both dialects agree on (and the strictest interpretation where
 * they differ), so a bridge gets one decision to map onto its seam:
 *
 * - **permission precedence `deny > ask > allow`**: any `deny`/`block` wins; an
 *   `ask` overrides `allow`; `allow`/`approve` only stands if nothing stricter
 *   appeared. (Claude Code's explicit precedence; Codex only ever blocks, so the
 *   rule degenerates correctly for it.)
 * - **halt is sticky**: the first hook with `continue:false` sets `stop` and its
 *   `stopReason`.
 * - **reasons accumulate**: block/deny reasons are joined with `\n\n` (Codex's
 *   `join_text_chunks`), so the model sees every objection, not just the first.
 * - **context accumulates**: `additionalContext` from every hook is collected in
 *   order (CC concatenates; Codex keeps them as separate developer messages —
 *   either way the bridge gets the ordered list).
 * - **systemMessages accumulate** likewise.
 *
 * @module @deepseek-ai/dsh-hook-protocol/merge
 */

import type { HookOutput } from './types.ts'

/** The single decision a hook point resolves to after merging all matched hooks. */
export type MergedDecision = 'allow' | 'ask' | 'deny' | 'none'

/** The folded outcome of every hook that matched one point. */
export interface MergedHookOutcome {
  /**
   * The most-restrictive permission decision across all hooks (`deny` > `ask` >
   * `allow`), or `none` when no hook expressed one. `block`/`deny` both fold to
   * `deny`; `approve`/`allow` both fold to `allow`.
   */
  decision: MergedDecision
  /** Joined (`\n\n`) reasons from every blocking/denying hook, or `undefined`. */
  reason?: string
  /** `true` when any hook asked to halt (`continue:false`). */
  stop: boolean
  /** The first halting hook's `stopReason`, when one halted. */
  stopReason?: string
  /** Every hook's `additionalContext`, in hook order (no joining — the bridge decides). */
  additionalContext: string[]
  /** Every hook's `systemMessage`, in hook order. */
  systemMessages: string[]
}

/** Rank a single hook's decision for the deny>ask>allow precedence (higher = stricter). */
function rank(decision: HookOutput['decision']): number {
  switch (decision) {
    case 'deny': case 'block': return 3
    case 'ask': return 2
    case 'approve': case 'allow': return 1
    default: return 0 // no decision
  }
}

/** Collapse a ranked decision back to the merged enum. */
function decisionForRank(maxRank: number): MergedDecision {
  switch (maxRank) {
    case 3: return 'deny'
    case 2: return 'ask'
    case 1: return 'allow'
    default: return 'none'
  }
}

/**
 * Fold `outputs` (the results of every hook that matched a point, in hook order)
 * into one {@link MergedHookOutcome} by the precedence rules above. An empty list
 * yields a neutral outcome (`decision: 'none'`, no stop, empty context) — the
 * caller treats that as "no hook had anything to say".
 */
export function mergeHookOutputs(outputs: HookOutput[]): MergedHookOutcome {
  let maxRank = 0
  // Reasons collected PER RANK, so the merged reason can be the one explaining
  // the WINNING decision (a deny-winning outcome surfaces deny reasons; an
  // ask-winning outcome surfaces ask reasons). An `allow`'s reason is never an
  // objection the model needs, so rank 1 collects none.
  const reasonsByRank = new Map<number, string[]>()
  let stop = false
  let stopReason: string | undefined
  const additionalContext: string[] = []
  const systemMessages: string[] = []

  for (const out of outputs) {
    const r = rank(out.decision)
    if (r > maxRank) maxRank = r
    if ((r === 3 || r === 2) && out.reason !== undefined && out.reason.length > 0) {
      const list = reasonsByRank.get(r) ?? []
      list.push(out.reason)
      reasonsByRank.set(r, list)
    }
    if (out.continue === false && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }
    if (out.additionalContext !== undefined && out.additionalContext.length > 0) {
      additionalContext.push(out.additionalContext)
    }
    if (out.systemMessage !== undefined && out.systemMessage.length > 0) {
      systemMessages.push(out.systemMessage)
    }
  }

  const reasons = reasonsByRank.get(maxRank) ?? []
  return {
    decision: decisionForRank(maxRank),
    ...reasons.length > 0 ? { reason: reasons.join('\n\n') } : {},
    stop,
    ...stopReason !== undefined ? { stopReason } : {},
    additionalContext,
    systemMessages,
  }
}
