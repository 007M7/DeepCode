/**
 * Dev-mode invariants: a pure-listener plugin that asserts the harness event
 * contract at runtime, and (optionally) freezes logged session-event data so
 * any code that mutates history throws instead of corrupting silently.
 *
 * Everything is a plugin — this is just listeners on `session/created`,
 * `session/event`, and `agent/status`. It is **off in production**: enable it
 * in tests and the demos, where a contract violation should be a loud failure,
 * not a subtle one. It doubles as executable documentation of the event
 * taxonomy: the assertions below ARE the contract.
 *
 * Why runtime assertions instead of compile-time deep-readonly types? See
 * ADR 0012. Briefly: a `DeepReadonly<SessionEvent>` is high type-noise across
 * every log consumer and a plugin casts straight through it; a dev-mode freeze
 * + assertions catch real corruption at zero production cost and zero type
 * noise. The always-on half of that defense (cloning derived messages) lives
 * in dsh-session; this package is the dev-mode tripwire.
 *
 * @module @deepseek-ai/dsh-invariants
 */

import type { Context } from 'cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'invariants'

/**
 * Thrown when a harness event-contract invariant is violated. Plain `Error`
 * with a `code` for now; a later change promotes the harness error taxonomy.
 */
export class InvariantError extends Error {
  readonly code = 'INVARIANT'
  constructor(message: string) {
    super(`invariant violated: ${message}`)
    this.name = 'InvariantError'
  }
}

/** Plugin config. */
export interface Config {
  /**
   * Deep-freeze logged session-event data so mutating a logged event throws.
   * Default true — this plugin only runs in dev/test, where freezing is the
   * point. Set false to assert the event contract without freezing.
   */
  freeze?: boolean
}

/** Per-session bookkeeping for the session-log invariants. */
interface SessionTrace {
  /** Highest `seq` seen so far (must strictly increase). */
  lastSeq: number
  /** Open turn number, or null between turns. */
  openTurn: number | null
  /** Open step within the current turn, or null between steps. */
  openStep: number | null
  /** Outstanding tool-call ids awaiting a result (a result needs a prior call). */
  pendingCalls: Set<string>
}

/** Deep-freeze a value and everything reachable from it. Idempotent. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
}

/** Assert one appended event against the per-session invariants. */
function checkEvent(trace: SessionTrace, event: SessionEvent): void {
  // seq is strictly monotonic — the spine of replay equivalence. lastSeq
  // starts at -1, so the first event (seq 0) passes.
  if (event.seq <= trace.lastSeq) {
    throw new InvariantError(`seq must strictly increase: saw ${event.seq} after ${trace.lastSeq}`)
  }
  trace.lastSeq = event.seq

  // Intentionally non-exhaustive: only events that carry ordering structure
  // are checked; the rest are trace/replay data with no nesting contract.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (event.type) {
    case 'turn/start': {
      if (trace.openTurn !== null) {
        throw new InvariantError(`turn/start ${event.data.turn} while turn ${trace.openTurn} is still open`)
      }
      trace.openTurn = event.data.turn
      break
    }
    case 'turn/end': {
      if (trace.openTurn !== event.data.turn) {
        throw new InvariantError(`turn/end ${event.data.turn} does not match open turn ${trace.openTurn}`)
      }
      trace.openTurn = null
      trace.openStep = null
      break
    }
    case 'step/start': {
      if (trace.openTurn !== event.data.turn) {
        throw new InvariantError(`step/start in turn ${event.data.turn} but open turn is ${trace.openTurn}`)
      }
      trace.openStep = event.data.step
      break
    }
    case 'step/end': {
      if (trace.openStep !== event.data.step) {
        throw new InvariantError(`step/end ${event.data.step} does not match open step ${trace.openStep}`)
      }
      trace.openStep = null
      break
    }
    case 'assistant/chunk': {
      // A chunk belongs to an open step — step/start must precede it.
      if (trace.openStep === null) {
        throw new InvariantError('assistant/chunk outside an open step (step/start must precede its chunks)')
      }
      break
    }
    case 'tool/call': {
      trace.pendingCalls.add(event.data.callId)
      break
    }
    case 'tool/result': {
      // A result needs a prior matching call. (The converse does NOT hold: a
      // call may have no result — a thrown tools/execute waterfall ends the
      // step with no tool/result, which is legal.)
      if (!trace.pendingCalls.delete(event.data.callId)) {
        throw new InvariantError(`tool/result for ${event.data.callId} with no prior tool/call`)
      }
      break
    }
  }
}

/** Legal agent status transitions (the only state machine the loop guarantees). */
function checkTransition(from: AgentStatus | undefined, to: AgentStatus): void {
  // First observation: any status is a valid starting point.
  if (from === undefined) return
  // A no-op transition is illegal — setStatus dedups, so we never see it.
  if (from === to) {
    throw new InvariantError(`agent/status repeated ${to} (no-op transition)`)
  }
  // Leaving `disposed` is illegal — disposal is terminal.
  if (from === 'disposed') {
    throw new InvariantError(`agent/status left terminal state disposed → ${to}`)
  }
  // idle↔running and (idle|running)→disposed are all legal; nothing else exists.
}

/**
 * Register the dev-mode invariants. Returns nothing — contributions are
 * effect-scoped, so disposing the plugin fiber removes all listeners and
 * stops freezing (HMR-safe).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const freeze = config.freeze ?? true
  const traces = new WeakMap<Session, SessionTrace>()
  const lastStatus = new WeakMap<Agent, AgentStatus>()

  const traceFor = (session: Session): SessionTrace => {
    let trace = traces.get(session)
    if (!trace) {
      trace = { lastSeq: -1, openTurn: null, openStep: null, pendingCalls: new Set() }
      traces.set(session, trace)
    }
    return trace
  }

  ctx.on('session/created', (session) => {
    // A seeded/forked session arrives with events already in its log — the
    // constructor copies the seed WITHOUT emitting session/event, so replay
    // them through the checker here and freeze the existing entries.
    const trace = traceFor(session)
    for (const event of session.events) {
      checkEvent(trace, event)
      if (freeze) deepFreeze(event)
    }
  })

  ctx.on('session/event', (session, event) => {
    checkEvent(traceFor(session), event)
    if (freeze) deepFreeze(event)
  })

  ctx.on('agent/status', (agent, status) => {
    checkTransition(lastStatus.get(agent), status)
    lastStatus.set(agent, status)
  })
}

export default apply
