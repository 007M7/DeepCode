/**
 * Capture coordinator: the seam's upstream half. Subscribes to the session
 * firehose plus the one live-bus relay (`agent/error`), applies the fixed
 * chunk projection, builds logical records, runs each through the
 * `telemetry/redact` waterfall, and hands the redacted copy to the backend —
 * synchronously, with every handler self-contained so a failing backend can
 * never starve other subscribers (cordis `emit` is stop-on-throw) or touch
 * the agent loop. Composed by a backend in its constructor.
 *
 * @module @deepseek-ai/dsh-session-telemetry/coordinator
 */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TelemetryBackend, TelemetryRecord, TelemetrySeverity } from './index.ts'
import { applyDefaultRedaction } from './redact.ts'

/**
 * The handoff cursor: per session, the highest `seq` handed to a backend.
 * Deliberately MODULE-scope ambient state — a narrow, documented exception
 * to the registrations-are-effects discipline: cordis has no HMR
 * state-handover API, and keying by the `Session` object (which belongs to
 * the session store and outlives any telemetry fiber) is the only in-process
 * lifetime that lets a re-adopting fiber resume instead of re-handing
 * history. Entries die with their sessions; a missing entry safely means
 * "re-hand everything". Advanced only at emit time — the cursor marks
 * handed-off, not delivered.
 */
const handoffCursor = new WeakMap<Session, number>()

/**
 * Install the telemetry capture side onto a context for one backend.
 *
 * Registers the persistence-coordinator listener set plus the `agent/error`
 * relay, all through `ctx.effect()`/`ctx.on()` on the composing fiber, and
 * sweeps already-live sessions (a hot reload does not replay
 * `session/created`). Disposal emits each adopted session's `shutdown`
 * operational record and then awaits the backend's `shutdown()`; a failure
 * there warns instead of throwing — best-effort reporting must not fail
 * application teardown.
 */
export class TelemetryCoordinator {
  /** Sessions adopted by THIS fiber, for dispose-time `shutdown` records and double-adoption protection. */
  private readonly adopted = new Set<Session>()
  /** Per session, the `turn:step` keys whose first chunk already shipped; rebuilt from the log on re-adoption. */
  private readonly chunkSeen = new WeakMap<Session, Set<string>>()

  /**
   * @param ctx - the composing backend's context; listeners bind to its fiber.
   * @param backend - the backend receiving records; owned elsewhere, never disposed here beyond `shutdown()` forwarding.
   */
  constructor(
    private readonly ctx: Context,
    private readonly backend: TelemetryBackend,
  ) {
    ctx.on('session/created', (session) => {
      this.adopt(session)
    })
    ctx.on('session/event', (session, event) => {
      this.contain(() => {
        this.capture(session, event)
      })
    })
    // Parallel listeners are awaited by the loop at turn end; returning void
    // (not the SDK's flush promise) is the turn-latency contract.
    ctx.on('session/flush', (session) => {
      this.contain(() => {
        this.hintFlush(session)
      })
    })
    ctx.on('agent/error', (agent, turn, step, error) => {
      this.contain(() => {
        this.relayAgentError(agent, turn, step, error)
      })
    })
    ctx.effect(() => async () => {
      for (const session of this.adopted) {
        this.contain(() => {
          this.handOff(shutdownRecord(session))
        })
      }
      try {
        await this.backend.shutdown()
      } catch (error) {
        this.ctx.logger.warn(`telemetry: backend shutdown failed: ${String(error)}`)
      }
    }, 'telemetry capture')
    for (const session of ctx.sessions.list()) {
      this.adopt(session)
    }
  }

  /**
   * Adopt a session: replay its log THROUGH the projection from the handoff
   * cursor (or from the start when no cursor survived), then rely on the
   * firehose for everything after. Events at or below the cursor still feed
   * the projection state (first-chunk tracking) without being re-handed, so
   * a resumed fiber drops mid-step chunk continuations exactly like the
   * fiber that saw the step begin.
   * @param session - the live session to adopt; a second adoption is a no-op.
   */
  private adopt(session: Session): void {
    this.contain(() => {
      if (this.adopted.has(session)) return
      this.adopted.add(session)
      const cursor = handoffCursor.get(session) ?? -1
      for (const event of session.events) {
        if (event.seq <= cursor) this.track(session, event)
        else this.capture(session, event)
      }
    })
  }

  /** Feed the chunk projection without handing off — the ≤cursor half of re-adoption. */
  private track(session: Session, event: SessionEvent): void {
    if (event.type === 'assistant/chunk') {
      this.seen(session).add(`${event.data.turn}:${event.data.step}`)
    }
  }

  /** Project one event and hand it to the backend, advancing the cursor on handoff. */
  private capture(session: Session, event: SessionEvent): void {
    if (event.type === 'assistant/chunk') {
      const key = `${event.data.turn}:${event.data.step}`
      const seen = this.seen(session)
      // Fixed chunk projection: only the first chunk of each (turn, step)
      // ships — the stream-started signal; content is byte-complete in the
      // step's assembled assistant/message. Dropped chunks do not advance
      // the cursor, so re-adoption re-drops them deterministically.
      if (seen.has(key)) return
      seen.add(key)
    }
    this.handOff({
      channel: 'ledger',
      time: event.time,
      severity: severityOf(event),
      attributes: identityOf(session, event),
      // The live event object is mutable and the backend serializes later;
      // append-time validation guarantees this clone cannot throw.
      body: structuredClone(event.data),
    })
    handoffCursor.set(session, event.seq)
  }

  /**
   * Run the `telemetry/redact` waterfall over one record and hand the result
   * to the backend. The innermost `next` applies the seam's conservative
   * default rules, so an unconfigured deployment still never exports raw
   * credential shapes; callers run inside {@link contain}, so a throwing
   * rule withholds the record instead of reaching the loop (fail-closed).
   */
  private handOff(record: TelemetryRecord): void {
    this.backend.emit(this.ctx.waterfall('telemetry/redact', record, () => applyDefaultRedaction(record)))
  }

  /** Forward the turn-end boundary to the backend's optional flush hint. */
  private hintFlush(session: Session): void {
    if (this.adopted.has(session)) this.backend.flush?.()
  }

  /** Relay one `agent/error` bus emission as an `agent-error` operational record. */
  private relayAgentError(agent: Agent, turn: number, step: number, error: Error): void {
    this.handOff({
      channel: 'ops',
      time: Date.now(),
      severity: 'error',
      attributes: {
        'telemetry.op': 'agent-error',
        'session.id': String(agent.session.id),
        'agent.id': agent.id,
        'error.name': error.name,
        turn,
        step,
      },
      body: { name: error.name, message: error.message },
    })
  }

  /** Lazily create the per-session first-chunk tracking set. */
  private seen(session: Session): Set<string> {
    let set = this.chunkSeen.get(session)
    if (!set) this.chunkSeen.set(session, set = new Set())
    return set
  }

  /**
   * Run one capture-side step with its exception contained: cordis `emit`
   * is stop-on-throw, so a throwing listener would starve every subscriber
   * registered after this plugin — nothing from the backend may escape.
   */
  private contain(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.ctx.logger.warn(`telemetry: capture step failed: ${String(error)}`)
    }
  }
}

/** Build the per-session clean-exit marker emitted at dispose, before the backend's `shutdown()`. */
function shutdownRecord(session: Session): TelemetryRecord {
  return {
    channel: 'ops',
    time: Date.now(),
    severity: 'info',
    attributes: { 'telemetry.op': 'shutdown', 'session.id': String(session.id) },
    body: { op: 'shutdown' },
  }
}

/** Map an event's own outcome flag to the pre-baked alerting severity. */
function severityOf(event: SessionEvent): TelemetrySeverity {
  switch (event.type) {
    case 'tool/result':
      return event.data.isError ? 'error' : 'info'
    case 'turn/end':
      return event.data.reason.kind === 'error' ? 'error' : 'info'
    case 'prompt/blocked':
      return 'warn'
    default: {
      // Merge-extensible fall-through (no assertNever): types this seam does
      // not depend on still get their RFC-pinned severity via a widened
      // probe — `compact/end` is declared by dsh-compact, which the seam
      // deliberately does not import.
      const type: string = event.type
      if (type === 'compact/end' && (event.data as { error?: unknown }).error !== undefined) return 'error'
      return 'info'
    }
  }
}

/** Build the minimal identity attributes: envelope plus self-contained header facts. */
function identityOf(session: Session, event: SessionEvent): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'session.id': String(session.id),
    'event.type': event.type,
    'event.seq': event.seq,
  }
  const { cwd, parentSession } = session.header
  if (cwd !== undefined) attributes['session.cwd'] = cwd
  if (parentSession !== undefined) attributes['session.parent_id'] = String(parentSession)
  return attributes
}
