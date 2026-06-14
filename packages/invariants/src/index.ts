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
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'invariants'
export const inject = ['sessions']

/**
 * Thrown when a harness event-contract invariant is violated. Extends
 * {@link HarnessError} (`code: 'INVARIANT'`) so a violation is routable like
 * any other harness failure.
 */
export class InvariantError extends HarnessError {
  constructor(message: string) {
    super(`invariant violated: ${message}`, 'INVARIANT')
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
  /**
   * Tool-call ids issued in the OPEN step awaiting a result. Cleared at
   * `step/end` — a result must arrive in the same step as its call.
   */
  pendingCalls: Set<string>
}

/**
 * Deep-freeze a value and everything reachable from it.
 *
 * Walks every object's own properties even when the object itself is already
 * frozen: `Session.append()` accepts event data from arbitrary plugins/tools,
 * so a caller can hand us a SHALLOW-frozen object whose descendants are still
 * mutable. Skipping an already-frozen node (the obvious idempotence shortcut)
 * would leave exactly the kind of mutable history ADR 0012 means to catch. A
 * `WeakSet` of visited objects keeps it terminating on cycles and avoids
 * re-walking shared subtrees / already-processed seed events.
 */
function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  // Freeze the node (no-op if a caller pre-froze it), then ALWAYS descend —
  // a frozen container can still hold mutable children.
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
}

/** Assert that a step-scoped event names the currently open turn and step. */
function requireOpenStep(trace: SessionTrace, kind: string, turn: number, step: number): void {
  if (trace.openTurn !== turn || trace.openStep !== step) {
    throw new InvariantError(
      `${kind} names turn ${turn}/step ${step} but open is turn ${trace.openTurn}/step ${trace.openStep}`,
    )
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
  // SessionEventMap is merge-extensible, so no assertNever — unknown event
  // types fall through untouched.
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
      if (trace.openStep !== null) {
        throw new InvariantError(`turn/end ${event.data.turn} while step ${trace.openStep} is still open`)
      }
      trace.openTurn = null
      break
    }
    case 'step/start': {
      if (trace.openTurn !== event.data.turn) {
        throw new InvariantError(`step/start in turn ${event.data.turn} but open turn is ${trace.openTurn}`)
      }
      if (trace.openStep !== null) {
        throw new InvariantError(`step/start ${event.data.step} while step ${trace.openStep} is still open`)
      }
      trace.openStep = event.data.step
      break
    }
    case 'step/end': {
      requireOpenStep(trace, 'step/end', event.data.turn, event.data.step)
      // A result must arrive in the step that issued the call; orphan calls
      // (a step that errored before its result) do not carry to the next step.
      trace.pendingCalls.clear()
      trace.openStep = null
      break
    }
    case 'assistant/chunk': {
      requireOpenStep(trace, 'assistant/chunk', event.data.turn, event.data.step)
      break
    }
    case 'assistant/message': {
      requireOpenStep(trace, 'assistant/message', event.data.turn, event.data.step)
      break
    }
    case 'tool/call': {
      requireOpenStep(trace, 'tool/call', event.data.turn, event.data.step)
      trace.pendingCalls.add(event.data.callId)
      break
    }
    case 'tool/result': {
      requireOpenStep(trace, 'tool/result', event.data.turn, event.data.step)
      // A result needs a prior matching call in the same step. (The converse
      // does NOT hold: a call may have no result — a throwing tools/execute
      // waterfall ends the step with no tool/result, which is legal.)
      if (!trace.pendingCalls.delete(event.data.callId)) {
        throw new InvariantError(`tool/result for ${event.data.callId} with no prior tool/call in this step`)
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
 * Register the dev-mode invariants. Contributions are effect-scoped, so
 * disposing the plugin fiber removes all listeners and stops freezing
 * (HMR-safe). On (re-)apply the trace state is rebuilt by replaying each
 * existing session's log, so a hot reload mid-turn does not falsely reject the
 * next event.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const freeze = config.freeze ?? true
  const traces = new WeakMap<Session, SessionTrace>()
  // Agent status has no stored history to replay; the first observation after
  // (re-)apply seeds the baseline, so a reload never produces a false positive.
  const lastStatus = new WeakMap<Agent, AgentStatus>()

  const freshTrace = (): SessionTrace => ({ lastSeq: -1, openTurn: null, openStep: null, pendingCalls: new Set() })

  /** Build (or rebuild) a session's trace by replaying its whole log; freeze it. */
  const seedSession = (session: Session): SessionTrace => {
    const trace = freshTrace()
    traces.set(session, trace)
    for (const event of session.events) {
      checkEvent(trace, event)
      if (freeze) deepFreeze(event)
    }
    return trace
  }

  // Every store-created session (the only kind that emits session/event) is
  // seeded first — via ctx.sessions.list() at apply or session/created — so
  // the fallback is a defensive guard, never hit in practice.
  /* v8 ignore next -- traceFor's fallback: session/event always follows a seed */
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seedSession(session)

  // Rebuild state for sessions that already exist at (re-)apply time — HMR
  // reload starts a fresh fiber, and a mid-turn session would otherwise look
  // like it began with a stray chunk/step-end.
  for (const session of ctx.sessions.list()) seedSession(session)

  // A newly created session may arrive seeded/forked (the constructor copies
  // the seed WITHOUT emitting session/event), so replay its log here too.
  ctx.on('session/created', (session) => { seedSession(session) })

  ctx.on('session/event', (session, event) => {
    checkEvent(traceFor(session), event)
    if (freeze) deepFreeze(event)
  })

  ctx.on('agent/status', (agent, status) => {
    checkTransition(lastStatus.get(agent), status)
    lastStatus.set(agent, status)
  })
}
