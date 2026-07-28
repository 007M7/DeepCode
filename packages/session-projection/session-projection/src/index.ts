/**
 * Session-projection seam: the merge-extensible `SessionProjectionMap` type
 * table, the `ProjectionDefinition` state-driven computation unit contract,
 * and the `ctx.sessionProjections` registry that DRIVES every registered unit
 * forward eagerly over committed session events. Domain host plugins
 * contribute pure mathematics (init/apply/view); the framework owns the
 * subscription, the per-session watermark cache, and change notification;
 * carriers (api-proxy today, TUI/ACP/headless later) consume the snapshot
 * read face and the change feed. Neither side knows the other
 * (capability-seam three-way split). Design authority: the session-projection
 * RFC (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 *
 * Whole-value event rule (load-bearing): a state-carrying log event MUST
 * carry the complete post-change state, never a bare delta — it keeps every
 * unit's transition trivially cheap and every served value self-describing.
 *
 * @module @deepseek-ai/dsh-session-projection
 */

import { Context, Service } from 'cordis'
import type { ZodType } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module 'cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry
  }
}

import type { SessionProjectionMap } from './types.ts'

export type { SessionProjectionMap } from './types.ts'

/**
 * One domain's state-driven computation unit: three pure synchronous
 * functions plus declarations — never an opaque getter. The framework drives
 * `apply` on every committed session event; the domain holds no
 * subscriptions and owns only the mathematics. All three functions MUST be
 * synchronous (an async unit would tear the carriers' consistency cut) and
 * `state` MUST be plain JSON (the persisted-cache precondition).
 */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  /** The projection key this unit owns (its `SessionProjectionMap` entry). */
  key: K
  /** Validates the wire payload (`view` output) before it leaves the host. */
  schema: ZodType<SessionProjectionMap[K]>
  /**
   * State for the empty log.
   * @returns the initial state.
   */
  init(): S
  /**
   * Pure transition: previous state + one committed event → next state. A
   * unit uninterested in an event MUST return the same state reference — an
   * unchanged reference (`Object.is`) produces zero downstream work.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state (same reference when the event is not the unit's).
   */
  apply(state: S, event: SessionEvent): S
  /**
   * State → wire payload (the read-side projection).
   * @param state - the current state.
   * @returns the whole current value for this unit's key.
   */
  view(state: S): SessionProjectionMap[K]
  /**
   * Persisted-cache invalidation anchor: bump whenever the state shape or the
   * fold semantics change, so persisted `(sessionId, key, stateVersion,
   * observedSeq, state)` rows from an older unit are discarded instead of
   * being forward-applied into garbage. Non-negative integer.
   */
  stateVersion: number
}

/**
 * Change-feed listener: one unit's value changed for one session. `value` is
 * the schema-validated `view` output; `seq` is the unit's watermark at
 * emission (the seq of the event that caused the change).
 */
export type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: number,
) => void

/**
 * One consistent read cut over every registered unit for one session.
 * `asOfSeq` is the shared watermark — the seq of the last event every value
 * reflects (`-1` for an empty log, mirroring `session/subscribed.lastSeq`).
 */
export interface ProjectionSnapshot {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number
  /** Whole current value per registered key. */
  values: Partial<SessionProjectionMap>
}

/** Type-erased unit view the drive machinery works with (the register seam already proved the typed contract). */
interface ErasedDefinition {
  key: string
  schema: { parse(value: unknown): unknown }
  init(): unknown
  apply(state: unknown, event: SessionEvent): unknown
  view(state: unknown): unknown
  stateVersion: number
}

/** Per-session per-unit watermark cache row. */
interface UnitCell {
  state: unknown
  /** Seq of the last event passed through `apply` (regardless of change). */
  observedSeq: number
}

/** One live registration: the unit plus its per-session cells (dropped whole on disposal). */
interface Registration {
  readonly def: ErasedDefinition
  readonly cells: WeakMap<Session, UnitCell>
}

/**
 * `ctx.sessionProjections`: the projection unit table and its drive. The
 * service subscribes to `session/event` once; every committed event passes
 * every registered unit's `apply` (eager drive), and a changed state
 * reference notifies the change feed with the schema-validated view.
 * Cells build lazily — a unit registered after events flowed, or a session
 * older than the registry, folds `init` over the in-memory log on first
 * touch (event or read). Registration is an effect (disposer rides the
 * calling fiber): an unloaded domain plugin's key disappears from snapshots
 * and clients read it as capability absence. Duplicate keys throw. Domain
 * plugins register under `ctx.inject(['sessionProjections'], …)` so headless
 * assemblies without the registry stay unaffected.
 */
export class SessionProjectionRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<ProjectionChangeListener>()

  /**
   * Create and install the registry as `ctx.sessionProjections`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.drive(session, event)
    })
  }

  /**
   * Register one domain's unit. The registration is an effect on the calling
   * context's fiber: disposing the fiber (or calling the returned disposer)
   * removes the key — and the unit's cached cells — from subsequent drives
   * and snapshots.
   * @param definition - key, boundary schema, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<K extends keyof SessionProjectionMap, S>(definition: ProjectionDefinition<K, S>): () => void {
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
      throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`)
    }
    const dispose = this.ctx.effect(function* (this: SessionProjectionRegistry) {
      const key = definition.key as string
      if (this.registrations.has(key)) {
        throw new Error(`session projection key ${JSON.stringify(key)} is already registered`)
      }
      this.registrations.set(key, { def: definition, cells: new WeakMap() })
      yield () => {
        this.registrations.delete(key)
      }
    }.bind(this), 'sessionProjections.register()')
    return () => void dispose()
  }

  /**
   * Subscribe to the change feed. The registration is an effect on the
   * calling context's fiber.
   * @param listener - called once per unit whose state reference changed, per committed event.
   * @returns the exact disposer that unsubscribes.
   */
  onChanged(listener: ProjectionChangeListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }, 'sessionProjections.onChanged()')
    return () => void dispose()
  }

  /**
   * One consistent cut over every registered unit for one session, read from
   * the watermark cache (missing cells fold lazily over the in-memory log).
   * Fully synchronous — every value and `asOfSeq` reflect the same log
   * position. Each value passes its unit's schema before leaving.
   * @param session - the session whose projection values are read.
   * @returns the snapshot; `values` is empty when no unit is registered.
   */
  snapshot(session: Session): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    for (const registration of this.registrations.values()) {
      const cell = this.cellFor(registration, session)
      values[registration.def.key] = registration.def.schema.parse(registration.def.view(cell.state))
    }
    return { asOfSeq: session.seq - 1, values: values }
  }

  /** Fold one unit from init over `events`, producing a cell watermarked at the last folded event. */
  private buildCell(def: ErasedDefinition, events: readonly SessionEvent[]): UnitCell {
    let state = def.init()
    for (const event of events) state = def.apply(state, event)
    return { state, observedSeq: (events.at(-1)?.seq ?? -1) }
  }

  /** Read (or lazily build, folding the full in-memory log) one unit's cell. */
  private cellFor(registration: Registration, session: Session): UnitCell {
    let cell = registration.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(registration.def, session.events)
      registration.cells.set(session, cell)
    }
    return cell
  }

  /** Eager drive: pass one committed event through every registered unit; notify on changed references. */
  private drive(session: Session, event: SessionEvent): void {
    for (const registration of this.registrations.values()) {
      let cell = registration.cells.get(session)
      if (cell === undefined) {
        // Late build mid-stream: fold history before this event (seq = log
        // index, so the prefix slice is exact), then take the normal gate.
        cell = this.buildCell(registration.def, session.events.slice(0, event.seq))
        registration.cells.set(session, cell)
      }
      const next = registration.def.apply(cell.state, event)
      const changed = !Object.is(next, cell.state)
      cell.state = next
      cell.observedSeq = event.seq
      if (changed && this.listeners.size > 0) {
        const value = registration.def.schema.parse(registration.def.view(next))
        for (const listener of this.listeners) {
          listener(session, registration.def.key as Extract<keyof SessionProjectionMap, string>, value, event.seq)
        }
      }
    }
  }
}

export default SessionProjectionRegistry
