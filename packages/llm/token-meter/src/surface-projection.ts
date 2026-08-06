/**
 * The O(1) surface-token fold shared by the token-meter projection units.
 *
 * A projection state must stay bounded — the persisted projection cache
 * checkpoints every unit's whole state, so carrying the priced surface
 * (one node per model-visible message) would grow a checkpoint without
 * bound over the session's life. Instead, replacements ride the compact
 * seam's shadow-price protocol: the metering event immediately before a
 * surface `replace` (`compact/summary` or `compact/prune`) states the
 * heuristic price of the exact replaced range, so the fold keeps a running
 * total plus at most one pending claim and never retains per-node prices.
 * The counts are exact by construction: producers derive them from the same
 * fixed estimator this module prices appends with.
 *
 * @module @deepseek-ai/dsh-token-meter/surface-projection
 */

import { deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `compact/*` SessionEventMap merges (shadow-price events).
import type {} from '@deepseek-ai/dsh-compact'
import { estimateMessage } from './estimate.ts'

/**
 * One armed shadow price: the heuristic tokens of the surface range the
 * IMMEDIATELY following event replaces. Plain JSON — it is part of the
 * persisted unit state while armed.
 */
export interface ShadowPriceClaim {
  /** Declared inclusive first surface-node seq of the priced range. */
  start: number
  /** Declared inclusive last surface-node seq of the priced range. */
  end: number
  /** Heuristic tokens of the priced range under the fixed estimator. */
  tokens: number
}

/** One event's effect on a running surface-token total. */
export interface SurfaceTokensFold {
  /** Signed change in the surface total; 0 for events off the surface. */
  readonly deltaTokens: number
  /** Claim to carry into the next event; undefined when none survives. */
  readonly claim: ShadowPriceClaim | undefined
}

/**
 * Fold one committed event onto a running surface-token total.
 *
 * A shadow-price event arms a claim; any other event expires it, and a
 * surface `replace` must consume a claim naming its exact range — the
 * producers append the metering event and the replacement synchronously
 * adjacent, so a surviving claim always prices the very next event.
 * @param claim - the claim armed by the immediately preceding event, if any.
 * @param event - the next committed session event.
 * @returns the signed token delta and the claim state after this event.
 * @throws when a replacement arrives without a claim for its exact range —
 *   every in-repo replace producer meters its replacement, so an unpriced
 *   replacement is a shadow-price contract violation and must fail loud
 *   rather than let the total drift.
 */
export function foldSurfaceProjection(
  claim: ShadowPriceClaim | undefined,
  event: SessionEvent,
): SurfaceTokensFold {
  if (event.type === 'compact/summary' || event.type === 'compact/prune') {
    const { shadowedRange, shadowedTokenCount } = event.data
    return {
      deltaTokens: 0,
      claim: { start: shadowedRange.start, end: shadowedRange.end, tokens: shadowedTokenCount },
    }
  }
  if (!isSurfaceEvent(event)) return { deltaTokens: 0, claim: undefined }
  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  const op = event.surfaceOp
  if (op === 'append') return { deltaTokens: tokens, claim: undefined }
  if (claim === undefined || claim.start !== op.start || claim.end !== op.end) {
    throw new Error(
      `token surface: replace at seq ${event.seq} over range ${op.start}-${op.end} has no adjacent shadow price`
      + (claim === undefined ? '' : ` (armed claim covers ${claim.start}-${claim.end})`),
    )
  }
  return { deltaTokens: tokens - claim.tokens, claim: undefined }
}
