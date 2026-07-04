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
import type { HookDialect } from './types.ts'

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
  /** The dialect-neutral decision the bridge resolved (`deny`/`allow`/`block`/…). */
  decision: string
  /** The process exit code (absent when the hook could not run). */
  exitCode?: number
  /** A truncated stderr summary (the block-reason source on exit 2). */
  stderrSummary?: string
  /** Wall-clock duration of the run. */
  durationMs: number
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

/** Append a `hook/result` outcome event to `session` (pairs with a prior `hook/invoked`). */
export function appendHookResult(session: Session, record: HookResultRecord): void {
  session.append('hook/result', {
    turn: record.turn,
    point: record.point,
    handlerId: record.handlerId,
    decision: record.decision,
    ...record.exitCode !== undefined ? { exitCode: record.exitCode } : {},
    ...record.stderrSummary !== undefined ? { stderrSummary: record.stderrSummary } : {},
    durationMs: record.durationMs,
  })
}
