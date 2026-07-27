/**
 * Projection cells: per-session log-derived domain state on the client
 * (session-projection RFC). A domain client plugin registers one cell per
 * projection key at scope materialization; the framework owns the fold
 * semantics — last-wins over whole-value events, guarded by a single seq
 * watermark shared by the live and window-replace paths, re-seeded by the
 * tail-page baseline. Cells are bare observable sources; React binding
 * (useProjection) happens in web-react.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ObservableSnapshot } from '../contract/store.ts'
import { Notifier } from './notifier.ts'

// The single projection type table, typed end to end (host provider, wire
// block, client cell, React hook) — the interface package's pure-type outlet
// (`/types`, zero imports), never the package root: the root's dsh-agent →
// dsh-session chain would drag the host `Context.sessions` merge into the
// client program (one program must not hold both sides). No second
// client-side "views" table (user ruling, RFC Alternatives).
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * Minimal validating-schema face (zod-compatible: `ZodType<T>` satisfies it
 * structurally). Keeps the client runtime free of a zod dependency while the
 * interface package owns the real schemas.
 */
export interface ProjectionSchemaLike<T> {
  /**
   * Validate a wire payload; MUST throw on mismatch.
   * @param value - raw baseline payload.
   * @returns the validated value.
   */
  parse(value: unknown): T
}

/**
 * One domain's client-side projection contribution: the key, the wire-boundary
 * schema for the baseline payload, and the whole-value event extractor. The
 * signature makes delta shapes unrepresentable — `fromEvent` returns the
 * complete post-change state or "not my event".
 */
export interface ProjectionCellSpec<K extends keyof SessionProjectionMap & string> {
  key: K
  /** Validates the baseline payload at the wire boundary (a failed parse degrades to capability absent). */
  schema: ProjectionSchemaLike<SessionProjectionMap[K]>
  /**
   * Extract the whole post-change value from a domain event.
   * @param event - any session event (live or window-replayed).
   * @returns the complete value, or undefined for "not my event".
   */
  fromEvent(event: SessionEvent): SessionProjectionMap[K] | undefined
}

/**
 * The fifth framework hook seat (session-projection RFC): key-addressed
 * projection reader delivered through the standard kit. `undefined` uniformly
 * means capability absent — host plugin unmounted, client cell unregistered,
 * or no baseline landed yet. The selector overload mirrors useSession
 * (per-cell uSES binding with reference-stable whole values).
 */
export type UseProjection = {
  <K extends keyof SessionProjectionMap & string>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap & string, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * Tail-page projections baseline — structurally identical to the wire's
 * `SessionProjectionsBlock` (apiproxy api layer), restated here so the
 * React-free cell framework depends only on the type table, not the wire
 * package's response vocabulary.
 */
export interface ProjectionsBaseline {
  /** The consistent-cut seq (equals the window tail seq by construction). */
  asOfSeq: number
  /** Whole current values by key; a registered key absent here means the capability is absent. */
  values: Partial<SessionProjectionMap>
}

/** Type-erased spec view the framework machinery works with (the register seam already proved the typed contract). */
interface ErasedCellSpec {
  key: string
  schema: ProjectionSchemaLike<unknown>
  fromEvent(event: SessionEvent): unknown
}

/**
 * One key's per-session cell. Framework semantics, implemented once for all
 * cells: a `lastAppliedSeq` watermark; one application rule — `event.seq >
 * watermark` and `fromEvent` hit ⇒ take the whole value, raise the watermark,
 * notify (microtask-batched); live and window-replace events pass the same
 * filter, so replayed old pages can never roll state back; a baseline reset
 * re-seeds value and watermark unless a newer commit already applied (seq
 * rule); `undefined` uniformly means capability absent.
 */
export class ProjectionCell implements ObservableSnapshot<unknown> {
  private value: unknown = undefined
  /** Highest seq whose state this cell reflects; -1 = nothing applied (pre-baseline construction state). */
  private lastAppliedSeq = -1
  /** No rebuild callback: the value is written eagerly at the application sites; the notifier only batches. */
  private readonly notifier = new Notifier(() => {})

  /** @param spec - erased cell spec (typed at the register seam). */
  constructor(private readonly spec: ErasedCellSpec) {}

  /**
   * Offer one event (live append or window replay — same filter).
   * @param event - session event in log order or replayed.
   */
  offerEvent(event: SessionEvent): void {
    if (event.seq <= this.lastAppliedSeq) return // replay at or below the watermark: never roll back
    const hit = this.spec.fromEvent(event)
    if (hit === undefined) return
    this.value = hit
    this.lastAppliedSeq = event.seq
    this.notifier.markDirty()
  }

  /**
   * Re-seed from a tail-page baseline. A stale baseline (cut older than an
   * already-applied commit) is dropped whole — the seq rule, uniform with the
   * event filter.
   * @param present - whether the block carried this cell's key.
   * @param raw - the key's raw wire payload (validated here; a parse failure degrades to absent).
   * @param asOfSeq - the block's consistent-cut seq.
   */
  resetBaseline(present: boolean, raw: unknown, asOfSeq: number): void {
    if (asOfSeq < this.lastAppliedSeq) return // a newer mux commit already applied; the baseline must not overwrite it
    if (present) {
      try {
        this.value = this.spec.schema.parse(raw)
      } catch (error) {
        console.error(`[web-runtime] projection baseline for "${this.spec.key}" failed validation:`, error)
        this.value = undefined
      }
    } else {
      this.value = undefined // key absent from the block: capability absent
    }
    this.lastAppliedSeq = asOfSeq
    this.notifier.markDirty()
  }

  /**
   * uSES subscription entry (bare source; web-react binds the hook).
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Current whole value; `undefined` means capability absent (no baseline
   * carried the key, or none landed yet).
   * @returns the value reference (frozen event/wire data — stable between applications).
   */
  getSnapshot(): unknown {
    return this.value
  }
}

/**
 * The per-session cell set: registration (duplicate keys throw — one cell per
 * key per session), the two dispatch entrances the Session forwards to, and
 * the key-addressed read face useProjection resolves through.
 */
export class ProjectionCellSet {
  private readonly cells = new Map<string, ProjectionCell>()

  /**
   * Register one cell (scope-materialization time; the caller wires the
   * disposer into the scope fiber, the InputHub.shellFor pattern).
   * @param spec - typed cell spec.
   * @returns disposer removing the cell.
   */
  register<K extends keyof SessionProjectionMap & string>(spec: ProjectionCellSpec<K>): () => void {
    if (this.cells.has(spec.key)) throw new Error(`projection cell "${spec.key}" is already registered on this session`)
    const cell = new ProjectionCell(spec as unknown as ErasedCellSpec)
    this.cells.set(spec.key, cell)
    return () => {
      this.cells.delete(spec.key)
    }
  }

  /**
   * Key-addressed bare source (the useProjection resolution face).
   * @param key - projection key.
   * @returns the cell, or undefined when no cell is registered (capability absent).
   */
  cellOf(key: string): ProjectionCell | undefined {
    return this.cells.get(key)
  }

  /**
   * Live-append dispatch (one event through every cell's filter).
   * @param event - the appended live event.
   */
  offerEvent(event: SessionEvent): void {
    for (const cell of this.cells.values()) cell.offerEvent(event)
  }

  /**
   * Window-replace dispatch: every window event through the same filter —
   * events newer than a cell's watermark apply, replayed old pages drop.
   * @param events - the (re)installed window slice.
   */
  offerWindow(events: readonly SessionEvent[]): void {
    for (const event of events) this.offerEvent(event)
  }

  /**
   * Baseline re-seed from a tail-page response's projections block. Called
   * only when the response carries the block (RFC: reset rides the block; a
   * blockless response — registry-less deployment — leaves cells on the
   * one-rule event path, and every un-baselined key reads absent by default).
   * @param baseline - the response's projections block.
   */
  resetBaseline(baseline: ProjectionsBaseline): void {
    // Erased view: the framework walks the open key space; per-key typing
    // lives at the cell spec seam (schema.parse re-establishes it).
    const values = baseline.values as Record<string, unknown>
    for (const [key, cell] of this.cells) {
      cell.resetBaseline(Object.hasOwn(values, key), values[key], baseline.asOfSeq)
    }
  }
}
