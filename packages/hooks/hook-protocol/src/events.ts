/**
 * Append helpers for the log-only `hook/*` session events — the durable record
 * that a hook ran and what it decided. Thin wrappers over `session.append` so a
 * bridge does not hand-build the payloads (and so the `turn`-enclosure +
 * invoked/result pairing stay consistent across both bridges).
 *
 * `hook/*` events are log-only (not {@link SurfaceEventType}), so they carry no
 * `surfaceOp` and append with no surface intent — but, like every event, they
 * must sit inside an OPEN turn (the invariants oracle rejects an un-enclosed
 * event). The mid-turn hook points (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/
 * `Stop`) fire inside the loop's open turn by construction; `SessionStart` is the
 * exception (its injected `context/message` is the durable evidence instead), so
 * a bridge does NOT write `hook/*` for session-start — see the hooks RFC.
 *
 * @module @deepseek-ai/dsh-hook-protocol/events
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { HookDialect, HookOutput } from './types.ts'

/** What identifies a hook invocation across its invoked/result pair. */
export interface HookInvocation {
  /** The open turn the invocation lives inside. */
  turn: number
  /** The hook point (`PreToolUse`, `Stop`, …). */
  point: string
  /** The bridge dialect that ran it. */
  dialect: HookDialect
  /** A stable id correlating the invoked event with its result. */
  handlerId: string
  /** The matcher-group pattern that selected it (absent for match-all). */
  matcher?: string
}

/** The decided outcome half of the pair. */
export interface HookResultRecord {
  turn: number
  point: string
  handlerId: string
  /**
   * The decoded outcome the run produced. {@link appendHookResult} derives the
   * durable `decision`/`exitCode`/`stderrSummary` fields from it, so the shared
   * event's semantics live here, in the lib that declares it, not per-bridge.
   */
  output: HookOutput
  /**
   * Character cap for the derived `stderrSummary`. The bound is the bridge's
   * to own (its `stderrSummaryMaxChars` config) and is passed in explicitly —
   * {@link DEFAULT_STDERR_SUMMARY_MAX_CHARS} is the reference default.
   */
  stderrSummaryMaxChars: number
  /** Wall-clock duration of the run (from `runHook`) — durable audit timing. */
  durationMs: number
}

/**
 * The reference default for {@link HookResultRecord.stderrSummaryMaxChars}
 * (both bridges' config default). It lives here, once, next to the truncation
 * rule it bounds, so the bridges cannot drift apart on the shared event's
 * default cap.
 */
export const DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500

/**
 * Truncate a hook's stderr for {@link HookResultRecord.stderrSummary}: trimmed,
 * `undefined` when empty, cut at `maxChars` with an ellipsis when over. The
 * bound is a parameter — like `runHook`'s `defaultTimeoutMs`, each bridge owns
 * the config default and passes it in.
 */
export function summarizeStderr(stderr: string, maxChars: number): string | undefined {
  const t = stderr.trim()
  if (t.length === 0) return undefined
  return t.length > maxChars ? t.slice(0, maxChars) + '…' : t
}

/** Append a `hook/invoked` provenance event to `session`. */
export function appendHookInvoked(session: Session, invocation: HookInvocation): void {
  session.append('hook/invoked', {
    turn: invocation.turn,
    point: invocation.point,
    dialect: invocation.dialect,
    handlerId: invocation.handlerId,
    ...invocation.matcher !== undefined ? { matcher: invocation.matcher } : {},
  })
}

/**
 * Append a `hook/result` outcome event to `session` (pairs with a prior
 * `hook/invoked`). Owns the durable event's semantics: `decision` is the hook's
 * parsed decision, else `'stop'` when it asked to halt (`continue: false`),
 * else `'pass'`; `stderrSummary` is the trimmed stderr truncated to
 * `record.stderrSummaryMaxChars` characters (omitted when empty); `exitCode`
 * is omitted when the hook never ran.
 */
export function appendHookResult(session: Session, record: HookResultRecord): void {
  const { output } = record
  const stderrSummary = summarizeStderr(output.stderr, record.stderrSummaryMaxChars)
  session.append('hook/result', {
    turn: record.turn,
    point: record.point,
    handlerId: record.handlerId,
    decision: output.decision ?? (output.continue === false ? 'stop' : 'pass'),
    ...output.exitCode !== undefined ? { exitCode: output.exitCode } : {},
    ...stderrSummary !== undefined ? { stderrSummary } : {},
    durationMs: record.durationMs,
  })
}
