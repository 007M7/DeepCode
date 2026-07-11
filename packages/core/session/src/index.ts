/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 *
 * Scope-filtered dispatch: keyed to the session's captured owner.
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from 'cordis'
import { isAbsolute } from 'node:path'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
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
     * Dispatch uses the session's captured owner scope.
     * @param session - the session just entered and announced.
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * An event was appended to a session log (sync, fire-and-forget).
     *
     * Scope-filtered dispatch: keyed to the session's captured owner.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * Awaited durability checkpoint.
     *
     * Scope-filtered dispatch: keyed to the session's captured owner.
     * @param session - the session whose buffered events must reach durable storage.
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
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
      // Validate seed JSON and contiguous sequence numbers just as append would.
      seed.forEach((event, index) => {
        if (event.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${event.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        if (!isJsonValue(event.data)) {
          throw new Error(`seed event "${event.type}" (seq ${event.seq}) carries non-JSON-serializable data`)
        }
        // Seed events bypass append's overloads, so enforce surface markers at runtime.
        if (isSurfaceEligibleType(event.type)
          && (event as SessionEvent<SurfaceEventType>).surfaceOp === undefined) {
          throw new Error(`seed event "${event.type}" (seq ${event.seq}) is surface-eligible but carries no surfaceOp marker`)
        }
      })
      // Clone seed events so callers cannot mutate the durable log after validation.
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
   * Append one typed event to the log and synchronously notify observers via `onAppend`. The
   * hot path never blocks on I/O — persistence plugins buffer asynchronously.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - required surface placement and optional provenance for message-producing events.
   * @returns the event with assigned sequence, time, and snapshotted data.
   * @throws if data is not losslessly JSON-serializable or surface placement is missing.
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
    // Recheck the conditional overload when `T` has widened to the full union.
    if (isSurfaceEligibleType(type) && surfaceOpts?.surfaceOp === undefined) {
      throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
    }
    // Snapshot caller-owned data and metadata before they enter durable history.
    // The generic conditional spreads require an internal union-boundary cast.
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
   * Derive the LLM message history by walking the session surface — the linked list of
   * message-producing events maintained by `surfaceOp` markers.
   *
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
   * Project a single event into the LLM message it derives to, or null when it produces none —
   * a non-surface event (chunk, boundary, log-only record) or an empty-content
   * assistant/message (which exists only to host usage).
   *
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
  /**
   * Each live session's dispatch carrier, captured at {@link enter} from the
   * ENTERING context's scope tag (an agent session is entered through
   * `agent.ctx` ⇒ its events dispatch in that agent's scope; a bare session ⇒
   * subject-less carrier). WeakMap so a detached session drops its carrier
   * with the entry.
   */
  private carriers = new WeakMap<Session, Scoped<Session>>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /**
   * Create, enter, and announce a session owned by the calling fiber.
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - optional seed and header metadata.
   * @returns the live session, already entered and announced.
   * @throws if the id exists or cwd is not absolute.
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // Yield detach before announcement so listener failure rolls back entry.
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and construct the
   * {@link Session} (with its immutable {@link SessionHeader}).
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
   * Enter a {@link prepare}d session into the store: wire `onAppend` → `session/event` and
   * add it to the store.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (`onAppend = undefined` + store removal).
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void {
    if (this.store.has(session.id)) throw new Error(`session "${session.id}" already exists`)
    // The carrier is decided HERE, once, from the ENTERING context's scope tag (`this.ctx` is
    // the caller's context — the tracker mechanism): every session/created|event|flush dispatch
    // for this session uses it, so the session's whole event feed is scope-filtered
    // consistently.
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    this.carriers.set(session, carrier)
    const emitCtx = this.ctx
    session.onAppend = (event) => { emitCtx.emit(carrier, 'session/event', session, event) }
    this.store.set(session.id, session)
    let entered = true
    return () => {
      if (!entered) return
      entered = false
      session.onAppend = undefined
      this.carriers.delete(session)
      this.store.delete(session.id)
    }
  }

  /** Emit `session/created` for an {@link enter}ed session (with the carrier
   * {@link enter} captured). Separate from {@link enter} so the caller can
   * yield the detach disposer first (rollback safety — see {@link enter}).
   * @param session - the entered session to announce to listeners. */
  announce(session: Session): void {
    this.ctx.emit(this.liveCarrierFor(session), 'session/created', session)
  }

  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the loop's turn-end checkpoint, idle
   * injection, teardown drains) must come through here rather than dispatch a
   * raw `ctx.parallel('session/flush', …)` — one owner, one spelling, and the
   * scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns resolves when every flush listener has settled; rejects if one rejects.
   */
  async flush(session: Session): Promise<void> {
    await this.ctx.parallel(this.liveCarrierFor(session), 'session/flush', session)
  }

  /** Return the exact live session's carrier; detached/prepared objects reject. */
  private liveCarrierFor(session: Session): Scoped<Session> {
    if (this.store.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const carrier = this.carriers.get(session)
    // enter() installs store + carrier in one synchronous sequence; a live
    // session without one is an internal invariant violation, never fallback
    // to subject-less dispatch (that would silently cross scope boundaries).
    /* v8 ignore next -- enter installs store and carrier in one synchronous sequence */
    if (carrier === undefined) {
      throw new Error(`session "${session.id}" has no dispatch carrier`)
    }
    return carrier
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
   * Create a live child session from a turn-enclosed prefix of a live source. `boundary` is
   * an inclusive source event seq; omitted means the source's current last event.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means the
   *   source's current last event, and omitted on an empty source forks an empty child.
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
