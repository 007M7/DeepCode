/**
 * Capture coordinator: the seam's upstream half. Subscribes to the session
 * firehose plus the one live-bus relay (`agent/error`), applies the fixed
 * chunk projection, builds logical records, runs each through the
 * `telemetry/record` waterfall (deployment-mounted redaction rules;
 * pass-through when none), and hands the result to the backend — synchronously, with every
 * handler self-contained so a failing backend can never starve other
 * subscribers (cordis `emit` is stop-on-throw) or touch the agent loop.
 * Composed by a backend in its constructor.
 *
 * @module @deepseek-ai/dsh-session-telemetry/coordinator
 */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TelemetryBackend, TelemetryRecord, TelemetrySeverity } from './index.ts'

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
 * `session/created`). A `session/disposed` emits the session's `shutdown`
 * operational record — the marker rides the session's own termination edge,
 * where receivers key crash detection — and retires it from the adopted set,
 * so a long-lived backend neither retains closed sessions (and their frozen
 * event logs) nor re-marks them at unload. Disposal marks the sessions still
 * alive at teardown (their own edge would fire unobserved) and then awaits
 * the backend's `shutdown()`; a failure there warns instead of throwing —
 * best-effort reporting must not fail application teardown.
 */
export class TelemetryCoordinator {
  /**
   * Sessions adopted by THIS fiber and still live, for double-adoption
   * protection and the teardown sweep of unmarked sessions;
   * `session/disposed` marks and retires entries.
   */
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
    // The session's own termination edge: emit the shutdown marker HERE —
    // receivers classify a session with activity and no marker as crashed,
    // so a normally closed session in a long-running host must get its
    // marker at disposal, not never. Then retire: the projection/cursor
    // WeakMaps die with the Session object; only the strong adopted set
    // needs the explicit release.
    ctx.on('session/disposed', (session) => {
      this.contain(() => {
        if (!this.adopted.delete(session)) return
        this.handOff(shutdownRecord(session))
      })
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
    ctx.on('agent/error', ({ agent, turn, step, error }) => {
      this.contain(() => {
        this.relayAgentError(agent, turn, step, error)
      })
    })
    ctx.effect(() => async () => {
      // Sessions still adopted here are alive through a whole-application
      // teardown (their own disposal edge will fire after telemetry is gone,
      // unobserved) — mark them now so the receiver sees a clean stop of
      // observation rather than a crash-shaped silence.
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
   * cursor, then rely on the firehose for everything after. When no cursor
   * survived, replay starts at the session's construction boundary
   * (`firstLiveSeq`), not seq 0: constructor seeds never publish on the
   * firehose, and their content already left the process under another
   * identity — the same id in a previous process (resume) or the parent's
   * stream (fork, stitched by receivers via `session.seed_length`). Events
   * at or below the start still feed the projection state (first-chunk
   * tracking) without being re-handed, so a resumed fiber drops mid-step
   * chunk continuations exactly like the fiber that saw the step begin. The
   * cost, accepted with the seam's at-most-once stance: a resume no longer
   * backfills records a previous process failed to deliver.
   * @param session - the live session to adopt; a second adoption is a no-op.
   */
  private adopt(session: Session): void {
    if (this.adopted.has(session)) return
    this.adopted.add(session)
    const cursor = handoffCursor.get(session) ?? session.firstLiveSeq - 1
    // Containment is PER EVENT, matching the firehose: one rejected record
    // is withheld fail-closed while the rest of the historical replay
    // proceeds — wrapping the whole loop would let a single failure silently
    // skip the remainder of the log on an already-adopted session.
    for (const event of session.events) {
      this.contain(() => {
        if (event.seq <= cursor) this.track(session, event)
        else this.capture(session, event)
      })
    }
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
   * Run the `telemetry/record` waterfall over one record and hand the result
   * to the backend. The innermost `next` passes the record through unchanged
   * — the seam ships no rules; exported data is as clean as the listeners a
   * deployment mounts. Callers run inside {@link contain}, so a throwing
   * rule withholds the record instead of reaching the loop (fail-closed).
   */
  private handOff(record: TelemetryRecord): void {
    this.backend.emit(this.ctx.waterfall('telemetry/record', record, () => record))
  }

  /** Forward the turn-end boundary to the backend's optional flush hint. */
  private hintFlush(session: Session): void {
    if (this.adopted.has(session)) this.backend.flush?.()
  }

  /** Relay one `agent/error` bus emission as an `agent-error` operational record. */
  private relayAgentError(agent: Agent, turn: number, step: number, error: unknown): void {
    const detail = errorDetail(error)
    this.handOff({
      channel: 'ops',
      time: Date.now(),
      severity: 'error',
      attributes: {
        'telemetry.op': 'agent-error',
        'session.id': String(agent.session.id),
        'agent.id': agent.id,
        'error.name': detail.name,
        turn,
        step,
      },
      body: detail,
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

/**
 * Build the per-session clean-exit marker: emitted at the session's own
 * disposal edge, or at coordinator dispose for sessions still alive then.
 */
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
      return event.data.message.content[0].isError === true ? 'error' : 'info'
    case 'turn/end':
      return event.data.reason.kind === 'error' ? 'error' : 'info'
    default:
      // Merge-extensible fall-through (no assertNever): event types this seam
      // does not depend on — including plugin-merged ones it never heard of —
      // pass through as info; their owners' outcome semantics stay theirs.
      return 'info'
  }
}

/** Normalize the live bus's arbitrary thrown value into the stable operational-record shape. */
function errorDetail(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { name: normalized.name, message: normalized.message }
}

/** Build the minimal identity attributes: envelope plus self-contained header facts. */
function identityOf(session: Session, event: SessionEvent): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'session.id': String(session.id),
    'event.type': event.type,
    'event.seq': event.seq,
  }
  const { cwd, parentSession, seedLength } = session.header
  if (cwd !== undefined) attributes['session.cwd'] = cwd
  if (parentSession !== undefined) attributes['session.parent_id'] = String(parentSession)
  // The durable fork boundary: a forked stream starts here, and its prefix
  // lives in the parent's stream — receivers stitch on (parent_id, seed_length).
  if (seedLength !== undefined) attributes['session.seed_length'] = seedLength
  return attributes
}
