/**
 * Shared buffering, serialization, adoption, repair, and disposal orchestration
 * for first-party backends. Third-party backends may implement the public
 * persistence seam directly.
 * @module @deepseek-ai/dsh-session-persistence/coordinator
 */

import { Context } from 'cordis'
import { interruptedTurnClosers, SESSION_FORMAT_VERSION, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * A stored session's header, valid contiguous event prefix, and optional opaque
 * torn-tail marker. The coordinator only checks marker presence and returns its
 * value to {@link PersistenceBackend.commitRepair}; each backend owns the type.
 */
export interface StoredPrefix<TornMarker = unknown> {
  meta: SessionHeader
  events: SessionEvent[]
  tornMarker?: TornMarker
}

/**
 * The storage seam between {@link PersistenceCoordinator} and a concrete
 * backend: the minimal set of durable primitives the orchestration calls. A
 * backend implements these (over files, rows, an object store, …); the
 * coordinator supplies everything else (buffering, serialization, cursors,
 * adoption, crash repair sequencing, dispose quiescence).
 *
 * @typeParam TornMarker - the backend's opaque torn-tail repair token (see
 * {@link StoredPrefix}). The coordinator treats it as fully opaque.
 */
export interface PersistenceBackend<TornMarker = unknown> {
  /** Human-readable backend name, used in the dispose-failure AggregateError. */
  readonly name: string

  /**
   * Read a stored prefix by id, scanning every backend storage scope. Returns
   * `undefined` if no stored artifact exists. Returned metadata must identify
   * `id` before repair or state publication. Used by resume/load, live adoption,
   * and — via `!== undefined` — the create-collision probe. The returned
   * `tornMarker` is present iff there is a torn tail to truncate.
   */
  loadStored(id: SessionId): Promise<StoredPrefix<TornMarker> | undefined>

  /**
   * Durably append a CONTIGUOUS batch, lazily materializing the session first
   * when `!isMaterialized`. The materialize-write and the first event batch MUST
   * commit ATOMICALLY (a crash between them must not leave a materialized-but-
   * empty session). Returns once the batch is durable.
   */
  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>

  /**
   * Make a crash repair durable: truncate the torn tail (iff
   * `tornMarker !== undefined`) and append `closers` (iff any). NOT required to
   * be atomic — a file backend may truncate-then-append in two fsync'd steps.
   * Used by load (truncate + synthetic closers) and by live-adoption (truncate
   * only, `closers = []`).
   */
  commitRepair(meta: SessionHeader, tornMarker: TornMarker | undefined, closers: readonly SessionEvent[]): Promise<void>

  /** List all stored (materialized) sessions' metadata. */
  list(): Promise<SessionHeader[]>

  /**
   * Optional lifecycle teardown (e.g. close a database handle). Awaited by the
   * coordinator's dispose effect AFTER the quiescence drain. A stateless file
   * backend omits it.
   */
  close?(): Promise<void>
}

/** Per-session write state held by the coordinator's in-memory bookkeeping. */
interface SessionState {
  meta: SessionHeader
  /** The next seq the backend expects to append (the stored log length). */
  cursor: number
  /**
   * Whether lazy creation has produced a durable artifact. The first append
   * atomically materializes the header with events; reclaim logic uses this to
   * distinguish an unused id from a persisted collision.
   */
  materialized: boolean
  /**
   * The live Session this state was bound to via `onCreated`, if any. State
   * created through the public `create()`/`load()` API has no owner; state bound
   * to a live session lets `onCreated` reject a second, unrelated session on the
   * same id (a collision) instead of silently no-opping.
   */
  owner?: Session
}

/** One live session's initialization and eager write-behind controller. */
interface LiveSessionState {
  pending: SessionEvent[]
  init: Promise<void>
  flush: Promise<void> | undefined
}

/** Collect the rejection reasons from a set of promises (none-throwing). */
async function settledErrors(promises: Iterable<Promise<unknown>>): Promise<unknown[]> {
  const settled = await Promise.allSettled([...promises])
  const errors: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  return errors
}

/** Whether a live session seed reproduces a persisted prefix exactly. */
function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return prefix.length <= seed.length
    && prefix.every((event, index) => {
      const seedEvent = seed[index]
      return seedEvent !== undefined && JSON.stringify(seedEvent) === JSON.stringify(event)
    })
}

/** Reject events from an obsolete v0 vocabulary that this build cannot replay. */
function assertSupportedEvents(events: readonly SessionEvent[], id: SessionId): void {
  const legacyType: string = 'request/header-delta'
  const legacy = events.find(event => event.type === legacyType)
  if (legacy !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header-delta event at seq ${legacy.seq}`)
  }
  const legacyModeType: string = 'mode/set'
  const legacyMode = events.find(event => event.type === legacyModeType)
  if (legacyMode !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy mode/set event at seq ${legacyMode.seq}`)
  }
  const fallback = events.find(event => event.type === 'request/header'
    && (event.data as { reason?: string }).reason === 'fallback')
  if (fallback !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header reason "fallback" at seq ${fallback.seq}`)
  }
}

/**
 * Owns the backend-agnostic session write-path orchestration. A backend
 * constructs one (`new PersistenceCoordinator(ctx, this)`), implements
 * {@link PersistenceBackend}, and delegates its write/read service methods to
 * the matching coordinator methods.
 *
 * All per-id operations are serialized (a per-id promise chain) so concurrent
 * flushes / a flush racing a load never interleave storage writes. The
 * constructor installs the write-path listeners, per-session retirement, and
 * the backend dispose effect.
 *
 * @typeParam TornMarker - the backend's opaque torn-tail repair token.
 */
export class PersistenceCoordinator<TornMarker = unknown> {
  /** Backend bookkeeping keyed by session id (NOT the live Session object). */
  private states = new Map<SessionId, SessionState>()
  /** Lifecycle and write-behind state keyed by the exact live Session. */
  private live = new Map<Session, LiveSessionState>()
  /** Cold loads currently reserving an id across backend reads and repair writes. */
  private coldLoads = new Set<SessionId>()
  /**
   * Per-session serialization: every operation chains onto the prior one for the
   * same id, so writes for one session never interleave. Keyed by session id.
   */
  private chains = new Map<SessionId, Promise<unknown>>()

  constructor(private ctx: Context, private backend: PersistenceBackend<TornMarker>) {
    this.installWritePath()
  }

  // --- public surface (the backend's service methods delegate here) ---

  /**
   * Register detached session metadata for lazy creation on the first append.
   * @param meta - header to snapshot; duplicate tracked or persisted ids reject.
   */
  create(meta: SessionHeader): Promise<void> {
    // Snapshot before queueing so caller mutation cannot diverge the key and header.
    const snapshot = snapshotJsonValue(meta)
    if (snapshot === undefined) {
      return Promise.reject(new TypeError('session metadata must be losslessly JSON-serializable'))
    }
    if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
      return Promise.reject(new TypeError('session metadata createdAt must be a non-negative safe integer'))
    }
    return this.serialize(snapshot.id, () => this.createCore(snapshot))
  }

  private async createCore(meta: SessionHeader): Promise<void> {
    // Do NOT clobber an existing session: the SessionId IS the identity.
    if (this.states.has(meta.id)) {
      throw new Error(`session "${meta.id}" already exists in this backend`)
    }
    // A persisted artifact under this id (in ANY scope) blocks creation: load/
    // resume identify a session by id alone, so a second artifact would make
    // resume nondeterministic.
    if (await this.backend.loadStored(meta.id) !== undefined) {
      throw new Error(`session "${meta.id}" already has a persisted log on disk; load/resume it instead of creating`)
    }
    // Pure lazy: record intent only. No artifact until the first append.
    this.states.set(meta.id, { meta, cursor: 0, materialized: false })
  }

  // `async` so synchronous materialization failures below reject (not throw) per
  // the Promise<void> contract — callers use `await expect(...).rejects`.
  /**
   * Durably persist a batch of events. Honors the append-only and contiguous-seq
   * contracts; rejects non-JSON-serializable `event.data`.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order; materialized
   *   as a detached lossless-JSON snapshot at call time.
   */
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Validate and deep-snapshot the complete batch HERE, in one traversal,
    // before the op waits behind the per-session chain. A check followed by
    // structuredClone would reread accessors and could sanitize an exotic value
    // into an apparently valid record; the single-pass materializer makes the
    // checked value exactly the value persisted.
    const batch = snapshotJsonValue(events)
    if (batch === undefined) {
      throw new TypeError('session event batch is not losslessly JSON-serializable because it contains non-JSON-serializable data')
    }
    return this.serialize(id, () => this.appendCore(id, batch))
  }

  private async appendCore(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Every append route converges here: the public service, live write-behind
    // drains, and HMR seed/suffix adoption. Keep vocabulary rejection at that
    // shared boundary so a stale JavaScript plugin cannot persist an event that
    // this same backend will refuse to load.
    assertSupportedEvents(events, id)
    if (events.length === 0) return
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id) // calls loadCore, not load

    // Contiguity contract: each event's seq must continue the stored log.
    for (const [i, event] of events.entries()) {
      if (event.seq !== state.cursor + i) {
        throw new Error(`append seq mismatch for "${id}": expected ${state.cursor + i} at index ${i}, got ${event.seq}`)
      }
    }

    await this.backend.appendBatch(state.meta, events, state.materialized)
    // The durable write is the transaction: mark materialized + advance the
    // cursor as soon as it commits (uniform across backends).
    state.materialized = true
    state.cursor += events.length
  }

  /**
   * Reload a session: its {@link SessionHeader} plus the event log up to the last
   * durable checkpoint, with any interrupted final turn durably closed (synthetic
   * boundary events) during load.
   * @param id - the persisted session to reload.
   * @returns the header plus the event log, ending on a balanced `turn/end`.
   */
  async load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const selected = await this.serialize(id, async () => {
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) return { live }
      this.coldLoads.add(id)
      try {
        return { loaded: await this.loadCore(id) }
      } finally {
        this.coldLoads.delete(id)
      }
    })
    return 'loaded' in selected ? selected.loaded : this.loadLiveSnapshot(selected.live)
  }

  /**
   * Read a detached valid stored prefix without recovery mutations or
   * coordinator-state publication.
   * @param id - persisted session to inspect.
   * @returns stored header and events before any synthetic recovery closers.
   */
  inspect(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.serialize(id, () => this.inspectCore(id))
  }

  private async inspectCore(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const stored = await this.backend.loadStored(id)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    this.assertStoredId(id, stored.meta)
    this.assertVersion(stored.meta)
    assertSupportedEvents(stored.events, id)
    return {
      meta: structuredClone(stored.meta),
      events: structuredClone(stored.events),
    }
  }

  private async loadCore(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const stored = await this.backend.loadStored(id)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    const { meta, events, tornMarker } = stored
    this.assertStoredId(id, meta)
    this.assertVersion(meta)
    assertSupportedEvents(events, id)

    // Preserve complete interrupted events and synthesize only missing closers.
    const closers = interruptedTurnClosers(events)
    const balanced = [...events, ...closers]

    // Repair storage before publishing coordinator state.
    if (tornMarker !== undefined || closers.length > 0) {
      await this.backend.commitRepair(meta, tornMarker, closers)
    }
    // Keep coordinator metadata detached from the returned record.
    this.states.set(id, { meta: { ...meta }, cursor: balanced.length, materialized: true })
    return { meta, events: balanced }
  }

  /** Return a durable balanced live snapshot without applying cold crash repair. */
  private async loadLiveSnapshot(session: Session): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const events = session.events.map(event => structuredClone(event))
    await this.flush(session)
    const state = this.states.get(session.id)
    /* v8 ignore next -- successful flush always publishes this live session's durable state */
    if (state === undefined) throw new Error(`session "${session.id}" lost persistence state during load`)
    const meta = structuredClone(state.meta)
    if (events.length === 0) throw new Error(`session "${session.id}" not found`)
    if (interruptedTurnClosers(events).length > 0) {
      throw new Error(`cannot load session "${session.id}" while its live turn is open; use the live Session or wait for the turn to close`)
    }
    return { meta, events }
  }

  // Listing is a direct backend read and needs no coordinator state.

  // --- per-id serialization + adoption helpers ---

  /**
   * Run `op` after any in-flight operation for the same session id, so writes for
   * one session never interleave. Errors do not poison the chain. NOTE: serialized
   * public methods must NOT call each other (deadlock); they call the unserialized
   * `*Core` helpers instead.
   */
  private serialize<T>(id: SessionId, op: () => Promise<T> | T): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const next = prior.then(op, op)
    // Keep the chain alive but swallow this op's rejection for the NEXT waiter
    // (the caller still sees the real rejection via `next`).
    const tail = next.then(() => undefined, () => undefined)
    this.chains.set(id, tail)
    // Settled tails carry no serialization value. Delete only the exact tail
    // installed above: a later operation may already have replaced it.
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return next
  }

  /** Build a state for a session discovered in storage but not yet in memory. */
  private async adopt(id: SessionId): Promise<SessionState> {
    // loadCore (NOT load) — adopt runs inside an already-serialized op, so
    // re-entering the chain via the public load() would deadlock.
    await this.loadCore(id)
    const state = this.states.get(id)
    /* v8 ignore next -- loadCore always sets the state for the id */
    if (!state) throw new Error(`failed to adopt session "${id}"`)
    return state
  }

  private assertVersion(meta: SessionHeader): void {
    if (meta.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`unsupported session format version ${meta.version} for "${meta.id}" (only v${SESSION_FORMAT_VERSION} is supported)`)
    }
  }

  /** Reject backend metadata that is not bound to the requested session id. */
  private assertStoredId(id: SessionId, meta: SessionHeader): void {
    if (meta.id !== id) {
      throw new Error(`stored session identity mismatch: requested "${id}", header contains "${meta.id}"`)
    }
  }

  // --- write path (session/event → flush drain) ---

  private installWritePath(): void {
    const ctx = this.ctx

    // Register the disposer BEFORE the listeners. Cordis tears effects down in
    // reverse registration order, so event admission closes before this final
    // drain reaches quiescence and closes the backend.
    ctx.effect(() => async () => {
      let disposeError: unknown
      try {
        const errors = await settledErrors([...this.live.keys()].map(session => this.flush(session)))
        while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()])
        if (errors.length > 0) {
          throw new AggregateError(errors, `${this.backend.name} dispose failed`)
        }
      } catch (error: unknown) {
        disposeError = error
        throw error
      } finally {
        try {
          await this.backend.close?.()
        } catch (closeError: unknown) {
          // A close failure can only add teardown context; keep the already-
          // captured drain AggregateError as the primary failure rather than
          // masking it. Only surface the close error if the drain succeeded.
          /* v8 ignore start -- close failure racing disposal is a defensive teardown edge */
          if (disposeError === undefined) throw closeError
          /* v8 ignore stop */
        }
      }
    }, `${this.backend.name} write path`)

    // Capture the header on creation and persist a fork's seed once.
    ctx.on('session/created', (session) => {
      if (this.coldLoads.has(session.id)) {
        throw new Error(`cannot publish session "${session.id}" while its persisted history is loading`)
      }
      void this.initFor(session)
    })

    // Keep a persistence-owned copy of each frozen event and start an eager drain.
    ctx.on('session/event', (session, event) => {
      const live = this.initFor(session)
      live.pending.push(structuredClone(event))
      if (live.flush === undefined) this.scheduleDrain(session, live)
    })

    // Callers use flush as the observation barrier for the eager write path.
    ctx.on('session/flush', session => this.flush(session))

    // Session disposal is observe-only, so retirement contains its own failure.
    ctx.on('session/disposed', (session) => { this.retire(session) })

    // HMR: a hot reload does not replay session/created, so seed existing live
    // sessions (mirrors dsh-invariants).
    for (const session of ctx.sessions.list()) void this.initFor(session)
  }

  /** Start and observe one disposed session's final drain. */
  private retire(session: Session): void {
    if (!this.live.has(session)) return
    void this.retireCore(session).catch((error: unknown) => {
      this.ctx.logger.warn(`${this.backend.name}: session "${session.id}" retirement failed: ${String(error)}`)
    })
  }

  /** Drain and release state owned by one exact disposed Session lifecycle. */
  private async retireCore(session: Session): Promise<void> {
    await this.flush(session)
    const id = session.header.id
    await this.serialize(id, () => {
      this.live.delete(session)
      if (this.states.get(id)?.owner === session) this.states.delete(id)
    })
  }

  /** Return the one lifecycle controller for a live session, creating it if needed. */
  private initFor(session: Session): LiveSessionState {
    const existing = this.live.get(session)
    if (existing) return existing
    const seed = session.events.map(e => structuredClone(e))
    const live: LiveSessionState = { pending: [], init: Promise.resolve(), flush: undefined }
    this.live.set(session, live)
    live.init = this.serialize(session.header.id, () => this.onCreated(session, seed))
    live.init.catch(() => { /* observed by flush/dispose through the controller */ })
    return live
  }

  /**
   * Whether a live session's `seed` reproduces the first `cursor` persisted
   * events. A `cursor` of 0 (nothing persisted yet) trivially matches. Used when
   * a live session claims ownerless state left by a prior `load()`/`create()`.
   */
  private async seedMatchesPersisted(id: SessionId, seed: readonly SessionEvent[], cursor: number): Promise<boolean> {
    if (cursor === 0) return true
    const stored = await this.backend.loadStored(id)
    /* v8 ignore next -- a cursor > 0 means the session was materialized, so it exists */
    if (stored === undefined) return false
    this.assertStoredId(id, stored.meta)
    return seedCoversPrefix(seed, stored.events.slice(0, cursor))
  }

  /**
   * On session/created: sync the backend's in-memory state to a live Session.
   *
   * Cases, by whether this backend tracks the id and whether an artifact exists:
   *   1. Already tracked → no-op (or claim ownerless state if the seed matches,
   *      or reclaim a truly-abandoned id, else reject as a collision).
   *   2. Not tracked, an artifact EXISTS at the same cwd and is a seq-aligned
   *      PREFIX of the live events → ADOPT it, persisting any live suffix.
   *   3. Not tracked, an artifact EXISTS at another cwd or is NOT a prefix →
   *      REJECT (collision).
   *   4. Not tracked and NO artifact → a genuinely new session: register meta
   *      (lazy) and persist its seed once.
   */
  private async onCreated(session: Session, seed: readonly SessionEvent[]): Promise<void> {
    const id = session.header.id
    const tracked = this.states.get(id)
    if (tracked !== undefined) {
      // case 1: already tracked.
      /* v8 ignore next -- initFor dedupes per session object; same-object re-entry can't occur */
      if (tracked.owner === session) return
      if (tracked.owner === undefined) {
        // Ownerless state from the public create()/load() API. The FIRST live
        // session claims it — but ONLY if BOTH the cwd scope and the seed match.
        // A same-id ownerless artifact at a different cwd is a collision, not a
        // claim: accepting it would append this live session's events through
        // the stored header's cwd. The seed guard then ensures the live events
        // reproduce the persisted prefix; otherwise a fresh session reusing the
        // id could have its leading events filtered as already written.
        if (tracked.meta.cwd !== session.header.cwd) {
          throw new Error(`session "${id}" is already persisted at a different cwd (persisted: ${String(tracked.meta.cwd)}, live: ${String(session.header.cwd)}) (id collision)`)
        }
        if (!await this.seedMatchesPersisted(id, seed, tracked.cursor)) {
          throw new Error(`session "${id}" is already persisted with ${tracked.cursor} event(s) that do not match this live session (id collision)`)
        }
        tracked.owner = session
        // Persist the seed SUFFIX beyond the persisted prefix. Constructor seed
        // events never emit session/event, so the buffer never sees them.
        const suffix = seed.slice(tracked.cursor)
        if (suffix.length > 0) await this.appendCore(id, suffix)
        return
      }
      const owner = this.live.get(tracked.owner)
      if (!tracked.materialized && !owner?.pending.length) {
        this.states.delete(id)
      } else {
        throw new Error(`session "${id}" is already bound to a different live session in this backend (id collision)`)
      }
    }

    // case 2/3: resolve the id once across storage, then let adoption reject a
    // cwd mismatch before repair or state publication.
    const live = await this.backend.loadStored(id)
    if (live !== undefined) {
      // Do NOT route through loadCore(): that crash-repairs open turns as
      // interrupted, which is wrong for HMR while the live Session is still the
      // authority and may append the real step/turn end later.
      await this.adoptLivePrefix(session, seed, live)
      return
    }

    // case 4: a genuinely new session. Register its meta (lazy), then persist its
    // seed (events present at creation time) once.
    const meta: SessionHeader = { ...session.header }
    await this.createCore(meta)
    // Bind this state to the live session so a later DIFFERENT session reusing
    // the id is detected as a collision (case 1) rather than silently no-opped.
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) await this.appendCore(id, seed)
  }

  /**
   * Adopt a stored prefix as a live session's history (HMR/reload): verify the
   * seed covers the stored prefix, truncate any torn tail (NOT the open turn —
   * the live Session is still the authority), bind ownership, and persist the
   * live suffix that was ahead of the stored prefix.
   */
  private async adoptLivePrefix(session: Session, seed: readonly SessionEvent[], stored: StoredPrefix<TornMarker>): Promise<void> {
    const { meta, events, tornMarker } = stored
    this.assertStoredId(session.header.id, meta)
    if (meta.cwd !== session.header.cwd) {
      throw new Error(`session "${session.header.id}" is already persisted at a different cwd (persisted: ${String(meta.cwd)}, live: ${String(session.header.cwd)}) (id collision)`)
    }
    this.assertVersion(meta)
    assertSupportedEvents(events, session.header.id)
    if (!seedCoversPrefix(seed, events)) {
      throw new Error(`session "${session.header.id}" already has a persisted log on disk that does not match this live session (id collision)`)
    }
    // Truncate-only repair (no closers): the open turn is NOT closed here.
    if (tornMarker !== undefined) await this.backend.commitRepair(meta, tornMarker, [])
    this.states.set(session.header.id, {
      meta: { ...meta },
      cursor: events.length,
      materialized: true,
      owner: session,
    })
    const suffix = seed.slice(events.length)
    if (suffix.length > 0) await this.appendCore(session.header.id, suffix)
  }

  private async flush(session: Session): Promise<void> {
    const live = this.initFor(session)
    await live.init
    const overlapping = live.flush
    if (overlapping !== undefined) await Promise.allSettled([overlapping])
    while (live.flush !== undefined || live.pending.length > 0) {
      if (live.flush !== undefined) await live.flush
      else await this.ensureFlush(session, live)
    }
  }

  /** Start an eager drain without exposing its failure to the synchronous append. */
  private scheduleDrain(session: Session, live: LiveSessionState): void {
    void this.ensureFlush(session, live).catch((error: unknown) => {
      this.ctx.logger.warn(`${this.backend.name}: eager drain for session "${session.id}" failed (buffered events retained): ${String(error)}`)
    })
  }

  /** Start one drain for the complete pending batch. */
  private ensureFlush(session: Session, live: LiveSessionState): Promise<void> {
    const flush = live.init
      .then(() => this.serialize(session.header.id, () => this.drain(session.header.id, live)))
      .finally(() => { live.flush = undefined })
    live.flush = flush
    void flush.then(() => {
      if (live.pending.length > 0) this.scheduleDrain(session, live)
    }, () => {})
    return flush
  }

  /** Drain one stable prefix; events admitted during the write remain pending. */
  private async drain(id: SessionId, live: LiveSessionState): Promise<void> {
    const batch = live.pending.slice()
    const state = this.states.get(id)
    /* v8 ignore next -- state is always set by the awaited init before flush */
    const cursor = state?.cursor ?? 0
    const fresh = batch.filter(e => e.seq >= cursor)
    await this.appendCore(id, fresh)
    live.pending.splice(0, batch.length)
  }
}
