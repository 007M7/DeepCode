/** Package-owned compaction log-stream invariants. @module @deepseek-ai/dsh-compact/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-compact'

/** Cordis companion plugin name. */
export const name = 'compact-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface CompactionTrace {
  turn: number
  summarized: boolean
}

interface SessionTrace {
  openTurn: number | null
  compaction: CompactionTrace | undefined
}

type CompactionTransition =
  | { kind: 'start'; turn: number }
  | { kind: 'summary'; turn: number }
  | { kind: 'end' }

/** Validate one compaction event without advancing committed trace state. */
function validateCompactionEvent(
  trace: SessionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): CompactionTransition | undefined {
  if (event.type !== 'compact/start' && event.type !== 'compact/summary' && event.type !== 'compact/end') {
    return undefined
  }
  if (trace.openTurn === null) fail(`${event.type} appended outside any open turn`)
  const open = trace.compaction
  if (event.type === 'compact/start') {
    if (open !== undefined) fail(`compact/start for turn ${event.data.turn} while turn ${open.turn} is still compacting`)
    if (event.data.turn !== trace.openTurn) {
      fail(`compact/start names turn ${event.data.turn} but open turn is ${trace.openTurn}`)
    }
    return { kind: 'start', turn: event.data.turn }
  }
  if (event.type === 'compact/summary') {
    if (open === undefined) fail('compact/summary has no matching compact/start')
    if (open.turn !== trace.openTurn) {
      fail(`compact/summary belongs to turn ${open.turn} but open turn is ${trace.openTurn}`)
    }
    if (open.summarized) fail('compact/summary repeated within one compaction')
    const seqs = event.data.shadowedSeqs
    if (seqs.length === 0) fail('compact/summary shadowedSeqs must be non-empty')
    if (seqs[0] !== event.data.shadowedRange.start || seqs.at(-1) !== event.data.shadowedRange.end) {
      fail('compact/summary shadowedRange must match the first and last shadowedSeqs')
    }
    if (!Number.isSafeInteger(event.data.shadowedTokenCount) || event.data.shadowedTokenCount < 0) {
      fail('compact/summary shadowedTokenCount must be a non-negative safe integer')
    }
    return { kind: 'summary', turn: open.turn }
  }
  if (open === undefined) fail('compact/end has no matching compact/start')
  if (event.data.turn !== open.turn) {
    fail(`compact/end turn ${event.data.turn} does not match compact/start turn ${open.turn}`)
  }
  if (event.data.turn !== trace.openTurn) {
    fail(`compact/end names turn ${event.data.turn} but open turn is ${trace.openTurn}`)
  }
  if (event.data.error === undefined && !open.summarized) {
    fail('successful compact/end requires one compact/summary')
  }
  return { kind: 'end' }
}

/** Apply one committed compaction transition. */
function applyCompactionTransition(
  transition: CompactionTransition,
): CompactionTrace | undefined {
  if (transition.kind === 'start') return { turn: transition.turn, summarized: false }
  if (transition.kind === 'summary') return { turn: transition.turn, summarized: true }
  return undefined
}

/** Install compaction start/summary/end checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, SessionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: CompactionTransition }>()
  const seed = (session: Session): SessionTrace => {
    const trace: SessionTrace = { openTurn: null, compaction: undefined }
    traces.set(session, trace)
    for (const event of session.events) {
      if (event.type === 'turn/start') trace.openTurn = event.data.turn
      else if (event.type === 'turn/end') trace.openTurn = null
      const transition = validateCompactionEvent(trace, event, fail)
      if (transition !== undefined) trace.compaction = applyCompactionTransition(transition)
    }
    return trace
  }
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    if (event.type === 'turn/start') {
      trace.openTurn = event.data.turn
      return
    }
    if (event.type === 'turn/end') {
      trace.openTurn = null
      return
    }
    if (event.type !== 'compact/start' && event.type !== 'compact/summary' && event.type !== 'compact/end') return
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every compaction event */
    if (candidate === undefined || candidate.session !== session) return fail('compaction event published without pre-commit validation')
    staged.delete(event)
    trace.compaction = applyCompactionTransition(candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateCompactionEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the compact invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
