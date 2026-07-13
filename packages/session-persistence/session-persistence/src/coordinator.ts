/**
 * The backend-agnostic write-path orchestration shared by every first-party
 * {@link SessionPersistence} backend.
 *
 * Every durable backend needs the same orchestration: the in-memory bookkeeping
 * (the per-id state, the write-behind buffers, the per-id serialization chains,
 * the per-session init promises), the `session/event` → buffer → `session/flush`
 * drain, lazy materialization, crash-tail repair on load, the four
 * `session/created` adoption cases (new / HMR-adopt / collision /
 * ownerless-claim), and dispose-time quiescence. Only the STORAGE primitives are
 * backend-specific (file bytes for `dsh-session-persistence-jsonl`, `node:sqlite`
 * rows for `dsh-session-persistence-sqlite`). {@link PersistenceCoordinator} owns
 * the orchestration; a backend supplies the storage primitives as a small
 * {@link PersistenceBackend} hook object.
 *
 * The abstract {@link SessionPersistence} service's public API is independent of
 * this: a backend IS a `SessionPersistence` (its four public methods delegate to
 * a coordinator it composes), so a third-party backend MAY implement the service
 * directly without using the coordinator at all.
 *
 * See the write-coordinator RFC (docs/rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)
 * for the design rationale (composition over inheritance, the opaque torn marker).
 *
 * @module @deepseek-ai/dsh-session-persistence/coordinator
 */

import { Context } from 'cordis'
import { interruptedTurnClosers, SESSION_FORMAT_VERSION, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { seedCoversPrefix } from './index.ts'

/**
 * A stored session's durable prefix as read back from a backend: its
 * {@link SessionHeader}, the preserved (seq-contiguous, parseable) event prefix,
 * and an OPAQUE `tornMarker` that is present iff a never-committed torn tail must
 * be truncated before further writes.
 *
 * The coordinator NEVER inspects `tornMarker`'s value — it only tests
 * `!== undefined` (is there a tail to repair?) and passes the value back to
 * {@link PersistenceBackend.commitRepair}. Each backend chooses its own marker
 * type: the JSONL backend uses the byte offset to truncate to, the SQLite
 * backend uses the seq to delete from (both happen to be `number`).
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
   * Read a stored prefix by id, scanning ANY storage scope (for JSONL: every
   * cwd bucket). Returns `undefined` if no stored artifact exists. Used by
   * resume/load, and — via `!== undefined` — by the create-collision probe.
   * The returned `tornMarker` is present iff there is a torn tail to truncate.
   */
  loadStored(id: SessionId): Promise<StoredPrefix<TornMarker> | undefined>

  /**
   * Read a stored prefix SCOPED to `cwd`. Deliberately distinct from
   * {@link loadStored}: HMR live-adoption must only adopt a persisted log at the
   * SAME cwd as the live session (a same-id log at a different cwd is a
   * collision, not a resume) — conflating the two reintroduces a cross-cwd
   * adoption bug. For a globally-unique-id backend (SQLite) `cwd` is ignored.
   */
  loadLive(id: SessionId, cwd: string | undefined): Promise<StoredPrefix<TornMarker> | undefined>

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
   * Whether the backend has physically written this session (a JSONL file /
   * SQLite row exists). `create()` registers state LAZILY — cursor 0,
   * materialized false, nothing on disk — so an empty session leaves no
   * artifact and the FIRST `appendBatch` writes the header + its events in ONE
   * transaction (the "a row exists ⇔ it has events" invariant `list`
   * relies on; a separate up-front materialize could crash leaving a row with
   * zero events). The flag is the only signal that distinguishes a session
   * registered-but-never-written from one durably present, which the reclaim
   * path needs (an abandoned id with no artifact AND no buffered events is free
   * to reuse; a materialized one is a real collision).
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

/** Collect the rejection reasons from a set of promises (none-throwing). */
async function settledErrors(promises: Iterable<Promise<unknown>>): Promise<unknown[]> {
  const settled = await Promise.allSettled([...promises])
  const errors: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  return errors
}

/**
 * Owns the backend-agnostic session write-path orchestration. A backend
 * constructs one (`new PersistenceCoordinator(ctx, this)`), implements
 * {@link PersistenceBackend}, and delegates its four public service methods to
 * the matching coordinator methods.
 *
 * All per-id operations are serialized (a per-id promise chain) so concurrent
 * flushes / a flush racing a load never interleave storage writes. The
 * constructor installs the write-path listeners and the dispose effect.
 *
 * @typeParam TornMarker - the backend's opaque torn-tail repair token.
 */
export class PersistenceCoordinator<TornMarker = unknown> {
  /** Backend bookkeeping keyed by session id (NOT the live Session object). */
  private states = new Map<SessionId, SessionState>()
  /** Write-behind buffers keyed by the live Session (write path). */
  private buffers = new Map<Session, SessionEvent[]>()
  /**
   * Per-session serialization: every operation chains onto the prior one for the
   * same id, so writes for one session never interleave. Keyed by session id.
   */
  private chains = new Map<SessionId, Promise<unknown>>()
  /**
   * Per-session init promise (onCreated). Keyed by the LIVE Session OBJECT, not
   * its id: a disposed fiber's session can be replaced by a different live
   * Session reusing the same id (HMR, an ACP reconnect), and an id-keyed cache
   * would hand the new object the old object's init promise.
   *
   * Public (readonly) so a backend can expose it for white-box tests that await
   * a specific session's init (there is no public API to await one init); the
   * coordinator itself only ever mutates it internally.
   */
  readonly inits = new Map<Session, Promise<void>>()

  constructor(private ctx: Context, private backend: PersistenceBackend<TornMarker>) {
    this.installWritePath()
  }

  // --- public surface (the backend's service methods delegate here) ---

  /**
   * Register a new session's metadata (lazy: no physical write until the first
   * {@link append}). Rejects if the id is already tracked or already persisted.
   * @param meta - the header (id, version, cwd, lineage) to record; materialized
   *   as a detached lossless-JSON snapshot at call time.
   */
  create(meta: SessionHeader): Promise<void> {
    // Snapshot the metadata at call time: the op runs later (behind the
    // per-session chain) and the snapshot is stored as the lazy state, so keeping
    // the caller's object by reference would let a later mutation of `id`/`cwd`
    // register under one key but materialize under a different path/header.
    const snapshot = snapshotJsonValue(meta)
    if (snapshot === undefined) {
      return Promise.reject(new TypeError('session metadata must be losslessly JSON-serializable'))
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
  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.serialize(id, () => this.loadCore(id))
  }

  private async loadCore(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const stored = await this.backend.loadStored(id)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    const { meta, events, tornMarker } = stored
    this.assertVersion(meta)

    // Crash-recovery: if the log ended mid-turn (real, preserved events but no
    // closing turn/end), close it durably DURING load so disk, the returned log,
    // and the cursor all agree. The interrupted turn's real events are preserved,
    // never truncated (a turn can be huge — the session-persistence RFC); only a
    // never-fully-written torn tail fragment is discarded.
    const closers = interruptedTurnClosers(events)
    const balanced = [...events, ...closers]

    // Make the repair durable (truncate the torn tail + append the synthetic
    // closers) BEFORE recording state — commitRepair takes `meta` directly, so
    // there is no state-path ordering dependency (uniform across backends).
    if (tornMarker !== undefined || closers.length > 0) {
      await this.backend.commitRepair(meta, tornMarker, closers)
    }
    // The state keeps its OWN copy of the meta; the returned value is separate so
    // a consumer mutating loaded.meta cannot corrupt the backend's metadata.
    this.states.set(id, { meta: { ...meta }, cursor: balanced.length, materialized: true })
    return { meta, events: balanced }
  }

  // NOTE: there is deliberately no coordinator `list()`. Listing needs none of
  // the coordinator's orchestration (no per-id serialization, no cursor, no
  // in-memory state) — it is a pure read of stored metadata. A backend's public
  // `list()` IS the {@link PersistenceBackend.list} hook (one method); routing it
  // through the coordinator would only forward to that same hook, so the
  // coordinator stays out of the listing path entirely.

  // --- per-id serialization + adoption helpers ---

  /**
   * Run `op` after any in-flight operation for the same session id, so writes for
   * one session never interleave. Errors do not poison the chain. NOTE: serialized
   * public methods must NOT call each other (deadlock); they call the unserialized
   * `*Core` helpers instead.
   */
  private serialize<T>(id: SessionId, op: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const next = prior.then(op, op)
    // Keep the chain alive but swallow this op's rejection for the NEXT waiter
    // (the caller still sees the real rejection via `next`).
    this.chains.set(id, next.then(() => undefined, () => undefined))
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

  // --- write path (session/event → flush drain) ---

  private installWritePath(): void {
    const ctx = this.ctx

    // Capture the header on creation; persist a fork's seed once. Record the init
    // promise so flush/dispose can await it (onCreated is async).
    ctx.on('session/created', (session) => { void this.initFor(session) })

    // Session emits an owned frozen event. Keep a persistence-owned copy anyway
    // so the write-behind queue owns exactly the record it will flush rather than
    // retaining a product-layer record by identity. Serializability is guaranteed
    // at the source, so structuredClone is safe.
    ctx.on('session/event', (session, event) => {
      let buffer = this.buffers.get(session)
      if (!buffer) this.buffers.set(session, buffer = [])
      buffer.push(structuredClone(event))
    })

    // Drain to the backend at the durability checkpoint.
    ctx.on('session/flush', session => this.flush(session))

    // Dispose must reach quiescence: await every init + final drain BEFORE
    // returning, then close the backend's own resources (AFTER the drain), so no
    // write lands after teardown and a close failure never MASKS a drain error.
    ctx.effect(() => async () => {
      let disposeError: unknown
      try {
        const errors = [
          ...await settledErrors(this.inits.values()),
          ...await settledErrors([...this.buffers.keys()].map(s => this.flush(s))),
          ...await settledErrors(this.chains.values()),
        ]
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

    // HMR: a hot reload does not replay session/created, so seed existing live
    // sessions (mirrors dsh-invariants).
    for (const session of ctx.sessions.list()) void this.initFor(session)
  }

  /** Start (once) the async init for a session and remember its promise. */
  private initFor(session: Session): Promise<void> {
    const existing = this.inits.get(session)
    if (existing) return existing
    // Snapshot the seed SYNCHRONOUSLY — initFor runs inside the `session/created`
    // emit, before any later append invalidates the public array snapshot. Events
    // are already frozen; cloning gives persistence independent ownership.
    const seed = session.events.map(e => structuredClone(e))
    const p = this.onCreated(session, seed)
    // Attach a no-op rejection handler so a failing init does not surface as an
    // unhandled rejection if no flush observes `p` before it rejects. The REAL
    // error is still delivered: flush/dispose await the same `p` from the map.
    p.catch(() => { /* observed by flush/dispose via the stored promise */ })
    this.inits.set(session, p)
    return p
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
    return seedCoversPrefix(seed, stored.events.slice(0, cursor))
  }

  /**
   * On session/created: sync the backend's in-memory state to a live Session.
   *
   * Cases, by whether this backend tracks the id and whether an artifact exists:
   *   1. Already tracked → no-op (or claim ownerless state if the seed matches,
   *      or reclaim a truly-abandoned id, else reject as a collision).
   *   2. Not tracked, an artifact EXISTS at this cwd and is a seq-aligned PREFIX
   *      of the live events → ADOPT it (HMR/reload), persisting any live suffix.
   *   3. Not tracked, an artifact EXISTS but is NOT a prefix → REJECT (collision).
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
        // The cwd guard mirrors case-2's cwd-scoped loadLive(): a same-id
        // ownerless artifact at a DIFFERENT cwd is a collision, not a claim
        // (claiming it would append the live cwd's events under the stored
        // header's cwd, the exact cross-cwd corruption the loadLive scope
        // prevents). The seed guard then ensures the live events reproduce the
        // persisted prefix (else a fresh, unrelated session reusing the id would
        // have its seq 0..cursor-1 events filtered as already-written and
        // grafted on).
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
        if (suffix.length > 0) await this.append(id, suffix)
        return
      }
      // Owned by a DIFFERENT live session. Reclaim ONLY a truly-abandoned id
      // (never materialized, no pending buffer); else it is a real collision.
      const ownerBuffer = this.buffers.get(tracked.owner)
      if (!tracked.materialized && !ownerBuffer?.length) {
        this.states.delete(id)
      } else {
        throw new Error(`session "${id}" is already bound to a different live session in this backend (id collision)`)
      }
    }

    // case 2/3: an artifact at THIS cwd is adopted as a live prefix (or rejected
    // as a collision inside adoptLivePrefix). cwd-scoped (loadLive), never
    // any-scope: a same-id artifact at a different cwd is a collision, not a
    // resume.
    const live = await this.backend.loadLive(id, session.header.cwd)
    if (live !== undefined) {
      // Do NOT route through loadCore(): that crash-repairs open turns as
      // interrupted, which is wrong for HMR while the live Session is still the
      // authority and may append the real step/turn end later.
      await this.serialize(id, () => this.adoptLivePrefix(session, seed, live))
      return
    }

    // case 4: a genuinely new session. Register its meta (lazy), then persist its
    // seed (events present at creation time) once.
    const meta: SessionHeader = { ...session.header }
    await this.create(meta)
    // Bind this state to the live session so a later DIFFERENT session reusing
    // the id is detected as a collision (case 1) rather than silently no-opped.
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) await this.append(id, seed)
  }

  /**
   * Adopt a stored prefix as a live session's history (HMR/reload): verify the
   * seed covers the stored prefix, truncate any torn tail (NOT the open turn —
   * the live Session is still the authority), bind ownership, and persist the
   * live suffix that was ahead of the stored prefix.
   */
  private async adoptLivePrefix(session: Session, seed: readonly SessionEvent[], stored: StoredPrefix<TornMarker>): Promise<void> {
    const { meta, events, tornMarker } = stored
    this.assertVersion(meta)
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
    // Wait for the session's init (onCreated) so the state/cursor and any
    // fork-seed persistence are in place before draining. Awaiting the same
    // promise initFor stored also surfaces an init failure (e.g. a collision)
    // here, where the caller of session/flush observes it.
    await this.inits.get(session)
    // Serialize the WHOLE drain (read cursor → append → splice) on the per-session
    // chain so two concurrent flushes cannot both read the same cursor and
    // seq-mismatch on the second append.
    await this.serialize(session.header.id, () => this.drain(session))
  }

  /** Drain a session's write buffer to the backend. Caller serializes this per id. */
  private async drain(session: Session): Promise<void> {
    const buffer = this.buffers.get(session)
    if (!buffer?.length) return
    // Copy WITHOUT removing: the buffer is the only durable-pending copy of these
    // events. Drain it only AFTER the append commits; events pushed during the
    // await sit past batch.length and survive the prefix splice, so a
    // retry/dispose re-drains the rest.
    const batch = buffer.slice()
    const state = this.states.get(session.header.id)
    // Only append events at or beyond the write cursor (a resumed session's seed
    // is already stored). flush awaits the init above, which always sets state,
    // so the `?? 0` fallback is a defensive guard that never fires in practice.
    /* v8 ignore next -- state is always set by the awaited init before flush */
    const cursor = state?.cursor ?? 0
    const fresh = batch.filter(e => e.seq >= cursor)
    // appendCore (NOT the serialized append) — drain already runs inside the
    // per-session chain, so re-entering via append() would deadlock.
    if (fresh.length > 0) await this.appendCore(session.header.id, fresh)
    buffer.splice(0, batch.length)
  }
}
