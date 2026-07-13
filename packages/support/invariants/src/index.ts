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
 * the dev-invariants RFC. Briefly: a `DeepReadonly<SessionEvent>` is high type-noise across
 * every log consumer and a plugin casts straight through it; a dev-mode freeze
 * + assertions catch real corruption at zero production cost and zero type
 * noise. The always-on half of that defense (cloning derived messages) lives
 * in dsh-session; this package is the dev-mode tripwire.
 *
 * @module @deepseek-ai/dsh-invariants
 */

import type { Context } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CallId, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'

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

/**
 * Deep-freeze a value and everything reachable from it.
 *
 * Walks every object's own properties even when the object itself is already
 * frozen: `Session.append()` accepts event data from arbitrary plugins/tools,
 * so a caller can hand us a SHALLOW-frozen object whose descendants are still
 * mutable. Skipping an already-frozen node (the obvious idempotence shortcut)
 * would leave exactly the kind of mutable history the dev-invariants RFC means to catch. A
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
      trace.surface.push(event.seq)
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
      // Apply the replace to the tracked surface: the new node takes the
      // range's position so order stays in sync for later replaces.
      trace.surface.splice(startIdx, shadowed.length, event.seq)
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
      trace.openTurn = event.data.turn
      trace.nextStep = 1
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
      trace.nextTurn += 1
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
      trace.openStep = event.data.step
      break
    }
    case 'step/end': {
      requireOpenStep(trace, 'step/end', event.data.turn, event.data.step)
      // A result must arrive in the step that issued the call; orphan calls
      // (a step that errored before its result) do not carry to the next step.
      trace.pendingCalls.clear()
      trace.openStep = null
      trace.nextStep += 1
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
      // does NOT hold: a call may have no result — a throwing tool-execution
      // pipeline step ends the turn with no tool/result, which is legal.)
      const syntheticInterrupted = event.data.isError && event.data.error?.code === 'interrupted'
      if (!trace.pendingCalls.delete(event.data.callId) && !syntheticInterrupted) {
        throw new InvariantError(`tool/result for ${event.data.callId} with no prior tool/call in this step`)
      }
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
  // Track every seq seen — used above to validate sourceEventSeqs references.
  trace.knownSeqs.add(event.seq)
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
  }, { prepend: true })
}
