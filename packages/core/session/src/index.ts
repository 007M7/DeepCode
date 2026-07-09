/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 *
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from 'cordis'
import { isAbsolute } from 'node:path'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from './types.ts'
import type { CreateSessionOptions, EpochHeader, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceIntent, SurfaceEventType } from './types.ts'
import { isJsonValue } from './json.ts'
import { SurfaceManager, isSurfaceEligibleType } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'

export * from './types.ts'
export { isJsonValue } from './json.ts'
export type { JsonValue } from './json.ts'
export { interruptedTurnClosers } from './repair.ts'
export type { SurfaceNode } from './surface.ts'
export { isSurfaceEvent, isSurfaceEligibleType } from './surface.ts'
export { isToolPairingBalanced } from './tool-pairing.ts'
export { applyHeaderDelta, canonicalHeader, diffHeader, foldRequestHeader, headerEquals } from './request-header.ts'

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /**
     * A session was created in the store.
     * @param session - the session just entered and announced.
     * @mode emit
     */
    'session/created'(session: Session): void
    /**
     * An event was appended to a session log (sync, fire-and-forget). This is
     * the per-append feed a UI or invariant plugin tails.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @mode emit
     */
    'session/event'(session: Session, event: SessionEvent): void
    /**
     * Awaited durability checkpoint. The agent loop awaits
     * `ctx.parallel('session/flush', session)` at every turn end; persistence
     * plugins (JSONL, SQLite) drain their write-behind buffers here and on
     * fiber dispose. Awaited (parallel), not a waterfall: every listener runs
     * and the loop waits for all of them, but none can veto.
     * @param session - the session whose buffered events must reach durable storage.
     * @mode parallel
     */
    'session/flush'(session: Session): Promise<void> | void
  }
}

/**
 * Renders a `context/message` or `steering/message` event as a tagged
 * synthetic user-role message (the system-reminder pattern: zero adapter
 * burden, models distinguish it from real user prompts by the envelope).
 *
 * Live-adapter review has validated the tagged-envelope rendering against
 * current DeepSeek behavior; provider-specific mismatches belong in that
 * adapter, not in the canonical session vocabulary.
 */
function renderTagged(tag: string, content: ContentBlock[], source: MessageSource): ContentBlock[] {
  const open = `<${tag} source=${JSON.stringify(source.kind)}>`
  const close = `</${tag}>`
  return [
    { type: 'text', text: open },
    ...content,
    { type: 'text', text: close },
  ]
}

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create instances via `ctx.sessions.create()`.
 * Seeding with an existing event log replays/forks a session.
 */
export class Session {
  private log: SessionEvent[] = []
  /** Set by the store so appends are observable; undefined when detached. */
  onAppend: ((event: SessionEvent) => void) | undefined

  /**
   * Derived surface — a cached linked list of message-producing events.
   * Lazily rebuilt from `surfaceOp` markers in the log; processes only new
   * events (delta) on each access — the log is append-only, so prior events
   * never change.
   * `append`. Undefined until first accessed (including after fork/seed).
   */
  private _surface: SurfaceManager | undefined

  /** The surface linked list over this session's event log. */
  get surface(): SurfaceManager {
    if (!this._surface) this._surface = new SurfaceManager(this.log)
    return this._surface
  }

  /**
   * Immutable creation metadata (format version, cwd, lineage, seed boundary).
   * Supplied by the store via `ctx.sessions.create()`. When a `Session` is
   * constructed bare (tests, ad-hoc replay), a minimal header is synthesized
   * (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader

  constructor(public readonly id: SessionId, seed?: SessionEvent[], header?: SessionHeader) {
    if (seed) {
      // Validate the seed to the SAME invariants `append` enforces, so a
      // replay/fork (`ctx.sessions.create(id, { seed })`) cannot construct a
      // live log that no persistence backend could store: each event's `data`
      // must be JSON-serializable, and `seq` must be contiguous from 0 (the
      // `seq = log.length` contract the whole system relies on). Without this,
      // a bad seed would surface only later as a backend rejection or a silent
      // divergence between the live log and disk.
      seed.forEach((event, index) => {
        if (event.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${event.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        if (!isJsonValue(event.data)) {
          throw new Error(`seed event "${event.type}" (seq ${event.seq}) carries non-JSON-serializable data`)
        }
        // Surface-eligible events MUST carry a surfaceOp marker — the surface is
        // the sole source of derived history, so a marker-less message event
        // would load fine yet vanish from deriveMessages(). `append` enforces
        // this at compile time via its typed overload; a seed arrives as raw
        // SessionEvent[] (replay/fork/load), bypassing that, so re-check at
        // runtime here rather than silently resuming with empty history.
        if (isSurfaceEligibleType(event.type)
          && (event as SessionEvent<SurfaceEventType>).surfaceOp === undefined) {
          throw new Error(`seed event "${event.type}" (seq ${event.seq}) is surface-eligible but carries no surfaceOp marker`)
        }
      })
      // Deep-clone each seed event, NOT just the array: the seed events and
      // their `data` are still owned by the caller (or the source session of a
      // fork), so keeping the references would let a post-create mutation of the
      // original rewrite this session's durable log — or reintroduce a
      // non-JSON-serializable value AFTER the validation above. Snapshotting at
      // the boundary makes `session.events` independent and keeps it equal to
      // what was validated. Serializability is guaranteed by the check above, so
      // structuredClone can never hit a non-cloneable value here.
      this.log = seed.map(event => structuredClone(event))
    }
    this.header = header ?? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now() }
  }

  /**
   * The append-only event log, exposed live by reference (readonly-typed, not
   * a snapshot): later appends are visible through the same array.
   */
  get events(): readonly SessionEvent[] {
    return this.log
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number {
    return this.log.length
  }

  /**
   * Append one typed event to the log and synchronously notify observers via
   * `onAppend`. The hot path never blocks on I/O — persistence plugins buffer
   * asynchronously.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the surface linked list; `sourceEventSeqs` records provenance (the seq
   *   numbers of events this one derives from). REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` is not losslessly JSON-serializable (BigInt, function,
   *   symbol, undefined, non-finite number, circular ref, or an exotic object
   *   like Map/Set/Date). The event log is the durable source of truth, so this
   *   invariant is enforced at the source — a bad event never enters the log,
   *   keeping `session.events` always equal to what a backend can persist. The
   *   throw surfaces at the buggy caller's append site, not asynchronously in a
   *   backend flush.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
    if (!isJsonValue(data)) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    // Surface-eligible events MUST carry a surfaceOp marker — the surface is the
    // sole source of derived history, so a marker-less message event would be
    // logged yet vanish from deriveMessages(). The typed `opts` overload makes
    // the marker mandatory only when `T` is a SPECIFIC SurfaceEventType literal;
    // when `T` widens to the SessionEventType union (a caller iterating raw
    // events: `for (const e of log) append(e.type, e.data)`), the conditional
    // rest collapses to optional and the compiler stops enforcing it. Re-check
    // at runtime so that loophole can't silently drop history.
    if (isSurfaceEligibleType(type) && surfaceOpts?.surfaceOp === undefined) {
      throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
    }
    // Snapshot `data` into the log, NOT the caller's reference: the validation
    // above proves it is JSON-serializable AT THIS MOMENT, but the caller still
    // owns the object and could mutate it afterwards (before a persistence
    // flush, or permanently in the in-memory history) — making `session.events`
    // diverge from the value that passed validation, or reintroducing a
    // non-serializable value. Cloning here keeps the log equal to what was
    // validated. structuredClone is safe because serializability was just
    // checked. The returned event carries the SAME snapshot, so a caller reading
    // back `event.data` sees the logged value, not its own mutable input.
    //
    // Surface metadata is snapshot separately: sourceEventSeqs (number[] —
    // primitives, so array spread is a complete copy) and surfaceOp (a string
    // primitive, or cloned if it's a replace object).
    // Build the event shape with conditional surface fields via spreading.
    // The result is cast through `unknown` because the conditional spreads
    // produce an intersection type that the assignability checker can't
    // narrow to a specific discriminated-union member when T is generic.
    // This is a safe internal boundary: data was validated above, and
    // surface metadata was snapshot from primitive/clone-safe values.
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data: structuredClone(data),
      ...surfaceOpts?.sourceEventSeqs !== undefined ? { sourceEventSeqs: [...surfaceOpts.sourceEventSeqs] } : {},
      ...surfaceOpts?.surfaceOp !== undefined ? {
        surfaceOp: typeof surfaceOpts.surfaceOp === 'string' ? surfaceOpts.surfaceOp : structuredClone(surfaceOpts.surfaceOp),
      } : {},
    } as unknown as SessionEvent<T>
    this.log.push(event as unknown as SessionEvent)
    this.onAppend?.(event as unknown as SessionEvent)
    return event
  }

  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold: EpochHeader | undefined
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq = 0

  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      // Frozen on update: the fold is session state exposed by reference — a
      // consumer mutating it in place (instead of building a replacement)
      // would desync every later comparison against the log, so mutation
      // throws instead.
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived: Message[] = []
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes = 0
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration = 0

  /**
   * Derive the LLM message history by walking the session surface — the linked
   * list of message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SurfaceManager.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**
   * — cloned once off the log at projection time, so consumers can never
   * mutate logged data, and mutation attempts throw instead of silently
   * diverging replay from history.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[] {
    const nodes = this.surface.nodes
    const generation = this.surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const node of nodes.slice(this.derivedNodes)) {
      // Surface nodes are built from this.log — node.seq is always a valid
      // index by construction. The non-null assertion expresses that invariant.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const msg = this.deriveEventMessage(this.log[node.seq]!)
      // A surface node is one of the five message-producing types, but an
      // empty-content assistant/message (a max-tokens step that hosts only
      // usage) derives to null and must not enter the transcript.
      if (msg) this.derived.push(deepFreeze(msg))
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /**
   * Project a single event into the LLM message it derives to, or null when
   * it produces none — a non-surface event (chunk, boundary, log-only record)
   * or an empty-content assistant/message (which exists only to host usage).
   * The per-node pure function {@link deriveMessages} folds over the surface;
   * an external reconstructor (or the dev invariant) folds the same function
   * over a log prefix's surface to rebuild the exact messages any request was
   * built from (the reconstructability RFC). The returned `content` is
   * deep-cloned off the logged event: the log is append-only by contract, so
   * no live reference to logged data leaves this boundary.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    // Intentionally non-exhaustive: only message-producing events derive
    // history; turn/step boundaries, chunks, usage, and errors are
    // trace/replay data.

    switch (event.type) {
      case 'user/message': {
        return { role: 'user', content: structuredClone(event.data.content) }
      }
      case 'assistant/message': {
        // Skip an empty-content assistant/message: it exists only to host a
        // max-tokens step's usage and must not inject a content-less assistant
        // turn into the provider transcript.
        if (event.data.content.length === 0) return null
        return { role: 'assistant', content: structuredClone(event.data.content) }
      }
      case 'tool/result': {
        const { callId, content, isError } = event.data
        return {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId, content: structuredClone(content), isError }],
        }
      }
      case 'context/message': {
        const { content, source } = event.data
        return { role: 'user', content: renderTagged('context', structuredClone(content), source) }
      }
      case 'steering/message': {
        const { content, source } = event.data
        return { role: 'user', content: renderTagged('steering', structuredClone(content), source) }
      }
      default:
        // A non-surface event (boundary, chunk, log-only record) projects to
        // no message. Merge-extensible union: no assertNever here.
        return null
    }
  }
}

/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`); or the boundary event is not a
 * `turn/end` — a fork must cut on a closed turn (`OPEN_TURN`).
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'
  | 'OPEN_TURN'

/** Typed error for session fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, Session>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`,
   * `parentSession` lineage) as the immutable {@link SessionHeader} (the store
   * fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final flush is captured before `onAppend` detaches), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see `dsh-agent-loop`'s
   * `startOwned`).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, or if `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // Single effect owned by the calling fiber. Yield the detach BEFORE
    // announcing so a throwing `session/created` listener rolls the attach back
    // (the generator effect disposes already-yielded disposers on a throw)
    // instead of leaking the store entry + onAppend.
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would detach `onAppend`
   * before the loop's closing `session/flush`, dropping the closing events.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, or if `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: CreateSessionOptions): Session {
    const sessionId = SessionId(id ?? `session-${++this.counter}`)
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    const cwd = options?.meta?.cwd
    if (cwd !== undefined && !isAbsolute(cwd)) {
      throw new Error(`session cwd must be an absolute path, got "${cwd}"`)
    }
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: options?.meta?.createdAt ?? Date.now(),
      ...cwd !== undefined ? { cwd } : {},
      ...options?.meta?.parentSession !== undefined ? { parentSession: options.meta.parentSession } : {},
      ...options?.meta?.seedLength !== undefined ? { seedLength: options.meta.seedLength } : {},
    }
    return new Session(sessionId, options?.seed, header)
  }

  /**
   * Enter a {@link prepare}d session into the store: wire `onAppend` →
   * `session/event` and add it to the store. Returns the DETACH disposer
   * (`onAppend = undefined` + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public seam cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (`onAppend = undefined` + store removal).
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void {
    if (this.store.has(session.id)) throw new Error(`session "${session.id}" already exists`)
    session.onAppend = (event) => { this.ctx.emit('session/event', session, event) }
    this.store.set(session.id, session)
    return () => {
      session.onAppend = undefined
      this.store.delete(session.id)
    }
  }

  /** Emit `session/created` for an {@link enter}ed session. Separate from
   * {@link enter} so the caller can yield the detach disposer first (rollback
   * safety — see {@link enter}).
   * @param session - the entered session to announce to listeners. */
  announce(session: Session): void {
    this.ctx.emit('session/created', session)
  }

  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined {
    return this.store.get(id)
  }

  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[] {
    return [...this.store.values()]
  }

  /**
   * Create a live child session from a turn-enclosed prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. A non-empty selected slice must end at `turn/end`.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session {
    if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
      throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    const liveSource = this._resolveForkSource(source)
    const seed = this._forkSeed(liveSource, boundary)
    return this.create(childSessionId, {
      seed,
      meta: {
        ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
        parentSession: liveSource.id,
        seedLength: seed.length,
      },
    })
  }

  private _forkSeed(session: Session, requestedBoundary: number | undefined): SessionEvent[] {
    const events = session.events
    const lastEvent = events.at(-1)
    let boundary: number
    if (requestedBoundary !== undefined) {
      boundary = requestedBoundary
    } else {
      if (lastEvent === undefined) return []
      boundary = lastEvent.seq
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new SessionForkError(
        `fork boundary for session "${session.id}" must be a non-negative safe integer, got ${String(boundary)}`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundary >= events.length) {
      const lastSeq = events.at(-1)?.seq
      throw new SessionForkError(
        `fork boundary ${boundary} does not exist in session "${session.id}" (last seq: ${lastSeq ?? 'none'})`,
        'INVALID_BOUNDARY',
      )
    }

    const boundaryEvent = events[boundary]
    if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new SessionForkError(
        `fork boundary ${boundary} does not match a contiguous event seq in session "${session.id}"`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundaryEvent.type !== 'turn/end') {
      throw new SessionForkError(
        `fork boundary ${boundary} in session "${session.id}" must be turn/end, got ${boundaryEvent.type}`,
        'OPEN_TURN',
      )
    }

    return events.slice(0, boundary + 1).map(event => structuredClone(event))
  }

  private _resolveForkSource(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

}

export default SessionStore
