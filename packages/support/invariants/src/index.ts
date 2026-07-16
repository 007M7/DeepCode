/**
 * Runtime listeners that fail loudly when cross-event contracts are broken:
 * turn and step nesting, scoped dispatch, status transitions, and request
 * reconstruction. The plugin has no environment guard and is active wherever
 * mounted, including the default `dsh-agent-spine-demo` bundle; custom compositions
 * may omit it. Sessions still own event snapshots and freezing.
 * @module @deepseek-ai/dsh-invariants
 */

import type { Context } from 'cordis'
import { carrierKeyOf, isScopeCarrier } from '@deepseek-ai/dsh-scope'
import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import type { CallId, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import { scopedSubjectResolverFor } from './scoped-events.generated.ts'

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

/** Per-session bookkeeping for the session-log invariants. */
interface SessionTrace {
  /** Highest `seq` seen so far (must strictly increase). */
  lastSeq: number
  /** Open turn number, or null between turns. */
  openTurn: number | null
  /** Open step within the current turn, or null between steps. */
  openStep: number | null
  /** The next turn number expected in this session log. */
  nextTurn: number
  /** The next step number expected within the open turn. */
  nextStep: number
  /**
   * Tool-call ids issued in the OPEN step awaiting a result. Cleared at
   * `step/end` — a result must arrive in the same step as its call.
   */
  pendingCalls: Set<CallId>
  /** Every seq seen so far — validates `sourceEventSeqs` references. */
  knownSeqs: Set<number>
  /**
   * The seqs currently on the surface linked list, in linked-list order
   * (head to tail). A replace reorders this relative to seq order (the new
   * node takes the replaced range's position), so range validation is
   * positional, not by seq comparison.
   */
  surface: number[]
}

/** One accepted event's deferred mutation of a live session trace. */
interface SessionTraceTransition {
  /** Scalar state after the event commits. */
  scalars: Pick<SessionTrace, 'lastSeq' | 'openTurn' | 'openStep' | 'nextTurn' | 'nextStep'>
  /** The event's mutation of the open step's pending call set. */
  pendingCalls:
    | { kind: 'none' }
    | { kind: 'add' | 'delete'; callId: CallId }
    | { kind: 'clear' }
  /** The event's mutation of the derived surface order. */
  surface:
    | { kind: 'none' | 'append' }
    | { kind: 'replace'; start: number; count: number }
  /** The committed event sequence to add to the known-sequence set. */
  seq: number
}

/** Assert that a step-scoped event names the currently open turn and step. */
function requireOpenStep(trace: SessionTrace, kind: string, turn: number, step: number): void {
  if (trace.openTurn !== turn || trace.openStep !== step) {
    throw new InvariantError(
      `${kind} names turn ${turn}/step ${step} but open is turn ${trace.openTurn}/step ${trace.openStep}`,
    )
  }
}

/** Validate one candidate event without mutating the committed session trace. */
function validateEvent(trace: SessionTrace, event: SessionEvent): SessionTraceTransition {
  // seq is strictly monotonic — the spine of replay equivalence. lastSeq
  // starts at -1, so the first event (seq 0) passes.
  if (event.seq <= trace.lastSeq) {
    throw new InvariantError(`seq must strictly increase: saw ${event.seq} after ${trace.lastSeq}`)
  }
  let openTurn = trace.openTurn
  let openStep = trace.openStep
  let nextTurn = trace.nextTurn
  let nextStep = trace.nextStep
  let pendingCalls: SessionTraceTransition['pendingCalls'] = { kind: 'none' }
  let surface: SessionTraceTransition['surface'] = { kind: 'none' }

  // --- Surface invariants ---
  // Surface metadata (sourceEventSeqs, surfaceOp) is only valid on
  // surface-eligible event types. The compiler enforces this at append()
  // call sites; this runtime check catches casts and persisted data.
  const SURFACE_TYPES = new Set<string>(['user/message', 'assistant/message', 'tool/result', 'context/message', 'steering/message'])
  // Cast to surface-eligible event type so we can access surfaceOp and
  // sourceEventSeqs (optional on SessionEvent, mandatory on SurfaceEvent).
  // SurfaceEvent's mandatory surfaceOp is too strict here — we need to
  // CHECK whether surface metadata is present, not assume it.
  const se = event as SessionEvent<SurfaceEventType>
  if (!SURFACE_TYPES.has(event.type)) {
    if (se.sourceEventSeqs !== undefined) {
      throw new InvariantError(`${event.type} cannot carry sourceEventSeqs (non-surface event)`)
    }
    if (se.surfaceOp !== undefined) {
      throw new InvariantError(`${event.type} cannot carry surfaceOp (non-surface event)`)
    }
  }
  if (se.sourceEventSeqs !== undefined) {
    if (se.sourceEventSeqs.length === 0) {
      throw new InvariantError('sourceEventSeqs must not be empty when present')
    }
    const unique = new Set(se.sourceEventSeqs)
    if (unique.size !== se.sourceEventSeqs.length) {
      throw new InvariantError('sourceEventSeqs must not contain duplicates')
    }
    for (const ref of se.sourceEventSeqs) {
      if (ref >= event.seq) {
        throw new InvariantError(`sourceEventSeqs must reference earlier events: ${ref} >= current seq ${event.seq}`)
      }
      if (!trace.knownSeqs.has(ref)) {
        throw new InvariantError(`sourceEventSeqs references unknown seq ${ref}`)
      }
    }
  }
  // Fold this event into the tracked surface linked list, validating the
  // replace contract as we go. `append` adds a tail node; `replace` shadows a
  // positional range — every shadowed node must appear in sourceEventSeqs.
  if (se.surfaceOp !== undefined) {
    if (se.surfaceOp === 'append') {
      surface = { kind: 'append' }
    } else {
      const { start, end } = se.surfaceOp
      const startIdx = trace.surface.indexOf(start)
      if (startIdx === -1) {
        throw new InvariantError(`surface replace: start seq ${start} is not on the surface`)
      }
      const endIdx = trace.surface.indexOf(end)
      if (endIdx === -1) {
        throw new InvariantError(`surface replace: end seq ${end} is not on the surface`)
      }
      if (startIdx > endIdx) {
        throw new InvariantError(`surface replace: start seq ${start} (pos ${startIdx}) is after end seq ${end} (pos ${endIdx}) on the surface`)
      }
      // Every node the replace shadows (surface positions [startIdx, endIdx]
      // inclusive) must appear in sourceEventSeqs — the provenance contract.
      const shadowed = trace.surface.slice(startIdx, endIdx + 1)
      const recorded = new Set(se.sourceEventSeqs ?? [])
      const missing = shadowed.filter(seq => !recorded.has(seq))
      if (missing.length > 0) {
        throw new InvariantError(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
      }
      surface = { kind: 'replace', start: startIdx, count: shadowed.length }
    }
  }

  // Boundary/step-scoped events have explicit cases; every OTHER event type —
  // including plugin-added (merge-extensible) SessionEventMap keys — is caught
  // by the `default` and must be turn-enclosed (the turn-enclosure RFC). No assertNever: an
  // unknown variant is valid, not a compile error.
  switch (event.type) {
    case 'turn/start': {
      if (trace.openTurn !== null) {
        throw new InvariantError(`turn/start ${event.data.turn} while turn ${trace.openTurn} is still open`)
      }
      // Current sessions replay full logs, so numbering starts at 1 and remains
      // contiguous. If a future compaction/fork stores a partial log, it must
      // seed `nextTurn` from retained metadata before this check runs.
      if (event.data.turn !== trace.nextTurn) {
        throw new InvariantError(`turn/start expected turn ${trace.nextTurn}, got ${event.data.turn}`)
      }
      openTurn = event.data.turn
      nextStep = 1
      break
    }
    case 'turn/end': {
      if (trace.openTurn !== event.data.turn) {
        throw new InvariantError(`turn/end ${event.data.turn} does not match open turn ${trace.openTurn}`)
      }
      if (trace.openStep !== null) {
        throw new InvariantError(`turn/end ${event.data.turn} while step ${trace.openStep} is still open`)
      }
      openTurn = null
      nextTurn += 1
      break
    }
    case 'step/start': {
      if (trace.openTurn !== event.data.turn) {
        throw new InvariantError(`step/start in turn ${event.data.turn} but open turn is ${trace.openTurn}`)
      }
      if (trace.openStep !== null) {
        throw new InvariantError(`step/start ${event.data.step} while step ${trace.openStep} is still open`)
      }
      // Steps are checked under the same full-log assumption as turns above.
      if (event.data.step !== trace.nextStep) {
        throw new InvariantError(`step/start expected step ${trace.nextStep} in turn ${event.data.turn}, got ${event.data.step}`)
      }
      openStep = event.data.step
      break
    }
    case 'step/end': {
      requireOpenStep(trace, 'step/end', event.data.turn, event.data.step)
      // A result must arrive in the step that issued the call; orphan calls
      // (a step that errored before its result) do not carry to the next step.
      pendingCalls = { kind: 'clear' }
      openStep = null
      nextStep += 1
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
      pendingCalls = { kind: 'add', callId: event.data.callId }
      break
    }
    case 'tool/result': {
      requireOpenStep(trace, 'tool/result', event.data.turn, event.data.step)
      // A result needs a prior matching call in the same step. (The converse
      // does NOT hold: a call may have no result — a throwing tool-execution
      // pipeline step ends the turn with no tool/result, which is legal.)
      const syntheticInterrupted = event.data.isError && event.data.error?.code === 'interrupted'
      if (!trace.pendingCalls.has(event.data.callId) && !syntheticInterrupted) {
        throw new InvariantError(`tool/result for ${event.data.callId} with no prior tool/call in this step`)
      }
      pendingCalls = { kind: 'delete', callId: event.data.callId }
      break
    }
    // Turn-enclosure (the turn-enclosure RFC): EVERY session event not handled by a boundary
    // case above must sit inside an open turn. The durable session log uses the
    // turn as its commit/replay boundary (the JSONL backend treats anything
    // after the last turn/end as a crash tail), so a bare event between turns is
    // silently dropped on reload. The loop records queued user messages after
    // turn/start, and an idle agent.inject() wraps its context/message in a
    // one-shot turn. A `default`
    // (not an enumerated list) is deliberate: SessionEventMap is
    // merge-extensible, so a PLUGIN-added event type appended while idle must
    // also fail here rather than fall through and be dropped on resume.
    default: {
      if (trace.openTurn === null) {
        throw new InvariantError(`${event.type} appended outside any open turn (every event must be turn-enclosed)`)
      }
      break
    }
  }
  return {
    scalars: { lastSeq: event.seq, openTurn, openStep, nextTurn, nextStep },
    pendingCalls,
    surface,
    seq: event.seq,
  }
}

/** Apply one already-validated transition after its event commits. */
function applyTransition(trace: SessionTrace, transition: SessionTraceTransition): void {
  Object.assign(trace, transition.scalars)
  switch (transition.pendingCalls.kind) {
    case 'none':
      break
    case 'add':
      trace.pendingCalls.add(transition.pendingCalls.callId)
      break
    case 'delete':
      trace.pendingCalls.delete(transition.pendingCalls.callId)
      break
    case 'clear':
      trace.pendingCalls.clear()
      break
    /* v8 ignore next -- validateEvent produces this closed transition union */
    default:
      assertNever(transition.pendingCalls, 'session trace pending-call transition')
  }
  switch (transition.surface.kind) {
    case 'none':
      break
    case 'append':
      trace.surface.push(transition.seq)
      break
    case 'replace':
      trace.surface.splice(transition.surface.start, transition.surface.count, transition.seq)
      break
    /* v8 ignore next -- validateEvent produces this closed transition union */
    default:
      assertNever(transition.surface, 'session trace surface transition')
  }
  trace.knownSeqs.add(transition.seq)
}

/** Validate and apply one event while rebuilding an already-committed log. */
function replayEvent(trace: SessionTrace, event: SessionEvent): void {
  applyTransition(trace, validateEvent(trace, event))
}

/** Allow an initial observation, idle/running transitions, and terminal disposal; reject repeats and leaving disposed. */
function checkTransition(from: AgentStatus | undefined, to: AgentStatus): void {
  if (from === undefined) return
  if (from === to) {
    throw new InvariantError(`agent/status repeated ${to} (no-op transition)`)
  }
  if (from === 'disposed') {
    throw new InvariantError(`agent/status left terminal state disposed → ${to}`)
  }
}

/**
 * Register the runtime invariants. Contributions are effect-scoped, so
 * disposing the plugin fiber removes all listeners (HMR-safe). On (re-)apply
 * the trace state is rebuilt by replaying each existing session's log, so a
 * hot reload mid-turn does not falsely reject the next event.
 *
 * @param ctx - Cordis context that receives the invariant listeners.
 */
export function apply(ctx: Context): void {
  const traces = new WeakMap<Session, SessionTrace>()
  const stagedTransitions = new WeakMap<SessionEvent, {
    session: Session
    trace: SessionTrace
    transition: SessionTraceTransition
  }>()
  // Agent status has no stored history to replay; the first observation after
  // (re-)apply seeds the baseline, so a reload never produces a false positive.
  const lastStatus = new WeakMap<Agent, AgentStatus>()

  const freshTrace = (): SessionTrace => ({
    lastSeq: -1,
    openTurn: null,
    openStep: null,
    nextTurn: 1,
    nextStep: 1,
    pendingCalls: new Set(),
    knownSeqs: new Set(),
    surface: [],
  })

  /** Build (or rebuild) a session's trace by replaying its whole log. */
  const seedSession = (session: Session): SessionTrace => {
    const trace = freshTrace()
    traces.set(session, trace)
    for (const event of session.events) {
      replayEvent(trace, event)
    }
    return trace
  }

  // Every store-created session (the only kind that emits session/event) is
  // seeded first — via ctx.sessions.list() at apply or session/created — so the
  // fallback is a defensive guard, never hit in practice.
  /* v8 ignore next -- traceFor's fallback: session/event always follows a seed */
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seedSession(session)

  // Rebuild state for sessions that already exist at (re-)apply time — HMR
  // reload starts a fresh fiber, and a mid-turn session would otherwise look
  // like it began with a stray chunk/step-end.
  for (const session of ctx.sessions.list()) seedSession(session)

  // A newly created session may arrive seeded/forked (the constructor copies
  // the seed WITHOUT emitting session/event), so replay its log here too.
  ctx.on('session/created', (session) => { seedSession(session) }, { global: true })

  ctx.on('session/event', (session, event) => {
    // Session resolves dispatch before committing, so internal/dispatch has
    // already staged this exact event. A later dispatch veto skips every
    // session/event callback and therefore leaves the live trace unchanged.
    const staged = stagedTransitions.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (staged === undefined || staged.session !== session) {
      throw new InvariantError('session/event reached publication without matching pre-commit validation')
    }
    stagedTransitions.delete(event)
    applyTransition(staged.trace, staged.transition)
  }, { global: true })

  ctx.on('agent/status', (agent, status) => {
    checkTransition(lastStatus.get(agent), status)
    lastStatus.set(agent, status)
  }, { global: true })

  // --- Scoped-dispatch invariants (the agent-scoping seam) ---------------
  //
  // Every scope-filtered event family must dispatch with a scope carrier
  // (scopeTarget) whose key IS the subject the event's arguments name —
  // a dispatch without one silently reverts that event to global delivery
  // (agent-scoped listeners over-hear foreign agents), and a mis-keyed one
  // delivers to the wrong agent's listeners. `internal/dispatch` fires
  // synchronously before listener delivery, so a violation throws at the
  // dispatching call site. The generated table maps each family to the unique
  // payload path whose Program type matches the real scopeTarget routing key;
  // `null` means the key is external to the payload, so only carrier presence
  // can be asserted.
  ctx.on('internal/dispatch', (_mode, name, args, thisArg) => {
    const subjectOf = scopedSubjectResolverFor(name)
    if (subjectOf === undefined) return
    if (!isScopeCarrier(thisArg)) {
      throw new InvariantError(
        `"${name}" is a scope-filtered event but was dispatched without a scope carrier — `
        + 'pass scopeTarget(base, subject) as the dispatch thisArg (agent events: use agentEvents(ctx, agent))')
    }
    if (subjectOf !== null && carrierKeyOf(thisArg) !== subjectOf(args)) {
      throw new InvariantError(
        `"${name}" was dispatched with a scope carrier keyed to a DIFFERENT subject than its arguments name — `
        + 'the carrier key and the event\'s subject must be the same object (use agentEvents(ctx, agent))')
    }
    if (name === 'session/event') {
      const [session, event] = args as [Session, SessionEvent]
      const trace = traceFor(session)
      const transition = validateEvent(trace, event)
      // The exact event identity reaches the contained post-commit listener.
      // A later internal/dispatch listener may still veto; because validation
      // is pure, abandoning this weakly keyed transition does not advance the
      // committed trace or retain the session.
      stagedTransitions.set(event, { session, trace, transition })
    }
  }, { global: true })

  // Request-reconstruction cross-check (the reconstructability RFC): a
  // loop-built request — frozen envelope + live sessionId is the marker; a
  // hand-built one-shot (compaction summarize) is unfrozen and skipped — must
  // be EXACTLY what the session log reconstructs:
  //
  // - messages: the folded header's session prefix (messagePrefix — the
  //   `agent/session-prefix` product, logged on the header because no
  //   session event carries it) followed by the
  //   derivation over the log prefix strictly before the in-flight step's
  //   `step/start` (the reconstruction boundary). The derivation is compared
  //   against a FRESH Session built over that prefix — the same projection
  //   code with zero shared state, so the live cache under test cannot vouch
  //   for itself. Boundary-correct by construction: content appended after
  //   the boundary (an `agent/request`-window inject) is legitimately absent
  //   from this request, and a current-surface comparison would false-fire.
  // - header: every non-content field must equal the fold of the log's
  //   `request/header*` events — the loop logs the header event BEFORE
  //   dispatch, so the fold already covers this request.
  //
  // Registered with `prepend: true` so a short-circuiting llm/stream listener
  // (the replay adapter returns its chunks without calling next()) cannot
  // silence the check by registering first. Prepend beats APPEND-registered
  // listeners only — two prepended listeners have no defined mutual order
  // (cordis unshift) — which is fine: correctness rests on the seq-bounded
  // fold below, never on listener timing.
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (options.sessionId === undefined || !Object.isFrozen(options)) return next()
    // GenerateOptions types sessionId as Branded<'SessionId'>, which IS
    // SessionId (dsh-llm cannot import it without a cycle) — no cast needed.
    const session = ctx.sessions.get(options.sessionId)
    if (!session) return next()
    if (!Object.isFrozen(options.messages)) {
      throw new InvariantError('a loop-built request must carry a frozen messages array')
    }

    const events = session.events
    // seq === index (checked above), so the last step/start's seq bounds the
    // prefix directly. The in-flight step's step/start is necessarily the
    // last one: the loop cannot open another step while this call streams.
    let boundary = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'step/start') {
        boundary = i
        break
      }
    }
    if (boundary === -1) {
      throw new InvariantError('a loop-built request with no step/start in its session log')
    }
    const header = foldRequestHeader(events)
    if (header === undefined) {
      throw new InvariantError('a loop-built request with no request/header event in its session log')
    }
    const rebuilt = new Session(SessionId(`${String(session.id)}-invariant-rebuild`), structuredClone(events.slice(0, boundary)))
    // The reconstruction equation: the folded header's session prefix, then
    // the boundary derivation — the loop
    // logs the header event BEFORE dispatch, so the fold already covers this
    // request's prefix. JSON equality is sound here: both sides are
    // structuredClones produced by the same projection/build code path, so key
    // insertion order matches when the values do.
    const expected = [...header.messagePrefix ?? [], ...rebuilt.deriveMessages()]
    if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
      throw new InvariantError(`llm request for session "${String(session.id)}" diverges from the boundary derivation (log-reconstruction desync)`)
    }

    const headerMatches = options.model === header.config.model
      && options.system === header.system
      && options.temperature === header.config.temperature
      && options.maxTokens === header.config.maxTokens
      && JSON.stringify(options.stop) === JSON.stringify(header.config.stop)
      && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
    if (!headerMatches) {
      throw new InvariantError(`llm request for session "${String(session.id)}" diverges from the folded request header`)
    }
    return next()
  }, { global: true, prepend: true })
}
