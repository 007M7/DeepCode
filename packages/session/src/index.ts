/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 *
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from 'cordis'
import { isAbsolute } from 'node:path'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from './types.ts'
import type { CreateSessionOptions, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceAppendOpts } from './types.ts'
import { isJsonValue } from './json.ts'
import { SurfaceManager } from './surface.ts'

export * from './types.ts'
export { isJsonValue } from './json.ts'
export { interruptedTurnClosers } from './repair.ts'
export type { SurfaceNode } from './surface.ts'

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /** A session was created in the store. */
    'session/created'(session: Session): void
    /** An event was appended to a session log (sync, fire-and-forget). */
    'session/event'(session: Session, event: SessionEvent): void
    /**
     * Awaited durability checkpoint. The agent loop awaits
     * `ctx.parallel('session/flush', session)` at every turn end; persistence
     * plugins (JSONL, sqlite — TODO, future phase) drain their write-behind
     * buffers here and on fiber dispose.
     */
    'session/flush'(session: Session): Promise<void> | void
  }
}

/**
 * Renders a `context/message` or `steering/message` event as a tagged
 * synthetic user-role message (the system-reminder pattern: zero adapter
 * burden, models distinguish it from real user prompts by the envelope).
 *
 * TODO(review): revisit the envelope once a real adapter exists.
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
   * Immutable creation metadata (format version, cwd, lineage). Supplied by
   * the store via `ctx.sessions.create()`. When a `Session` is constructed
   * bare (tests, ad-hoc replay), a minimal v1 header is synthesized so
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
    this.header = header ?? { version: 1, id, createdAt: Date.now() }
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }

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
   * @param opts - Optional surface metadata: `surfaceOp` controls how the
   *   event enters the surface linked list; `sourceEventSeqs` records
   *   provenance (the seq numbers of events this one derives from).
   * @throws if `data` is not losslessly JSON-serializable (BigInt, function,
   *   symbol, undefined, non-finite number, circular ref, or an exotic object
   *   like Map/Set/Date). The event log is the durable source of truth, so this
   *   invariant is enforced at the source — a bad event never enters the log,
   *   keeping `session.events` always equal to what a backend can persist. The
   *   throw surfaces at the buggy caller's append site, not asynchronously in a
   *   backend flush.
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], opts?: SurfaceAppendOpts): SessionEvent<T> {
    if (!isJsonValue(data)) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
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
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data: structuredClone(data),
      ...opts?.sourceEventSeqs !== undefined ? { sourceEventSeqs: [...opts.sourceEventSeqs] } : {},
      ...opts?.surfaceOp !== undefined ? {
        surfaceOp: typeof opts.surfaceOp === 'string' ? opts.surfaceOp : structuredClone(opts.surfaceOp),
      } : {},
    } as SessionEvent<T>
    this.log.push(event)
    this.onAppend?.(event)
    return event
  }

  /**
   * Derive the LLM message history from the session surface (when surface
   * markers exist) or from a linear scan of the raw event log (legacy sessions
   * without surface markers).
   *
   * - `user/message` → user message
   * - `assistant/message` → assistant message (chunks are skipped — they are
   *   replay/UI data; the assembled message is authoritative for history)
   * - `tool/result` → user message carrying a tool-result block
   * - `context/message` / `steering/message` → tagged synthetic user messages
   *   at their chronological position
   *
   * The returned `content` is **deep-cloned** off the logged events: the loop
   * hands these messages into the mutable `agent/request` waterfall and on to
   * adapters, where mutating the request is sanctioned — but the session log
   * is append-only by contract. Cloning at this boundary keeps in-flight
   * mutation from reaching back and rewriting history (which would silently
   * break replay equivalence). Cost is one structured clone per step,
   * negligible next to a model call.
   */
  deriveMessages(): Message[] {
    if (this.surface.hasSurface) {
      const messages: Message[] = []
      for (const node of this.surface.nodes) {
        // Surface nodes are built from this.log — node.seq is always a valid
        // index by construction. The non-null assertion expresses that invariant.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const msg = this._deriveOneMessage(this.log[node.seq]!)
        if (msg) messages.push(msg)
      }
      return messages
    }
    // Legacy path: linear scan for sessions without surface markers.
    const messages: Message[] = []
    for (const event of this.log) {
      const msg = this._deriveOneMessage(event)
      if (msg) messages.push(msg)
    }
    return messages
  }

  /**
   * Derive a single LLM message from one event, or null if the event type
   * does not produce a message. Extracted so both the surface path and the
   * legacy linear-scan path share the same derivation rules.
   */
  private _deriveOneMessage(event: SessionEvent): Message | null {
    // Intentionally non-exhaustive: only message-producing events derive
    // history; turn/step boundaries, chunks, usage, and errors are
    // trace/replay data.

    switch (event.type) {
      case 'user/message': {
        return { role: 'user', content: structuredClone(event.data.content) }
      }
      case 'assistant/message': {
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
        return null
    }
  }
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
export class SessionStore extends Service {
  private store = new Map<string, Session>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /**
   * Create a session. `options.seed` populates the session with a copy of
   * those events (replay/fork); `options.meta` attaches creation metadata
   * (validated absolute `cwd`, `parentSession` lineage) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`). The
   * session is a Cordis effect: disposing the calling fiber stops event
   * notification and removes the session from the store.
   *
   * @throws if a session with `id` already exists, or if `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: string, options?: CreateSessionOptions): Session {
    const sessionId = SessionId(id ?? `session-${++this.counter}`)
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    const cwd = options?.meta?.cwd
    if (cwd !== undefined && !isAbsolute(cwd)) {
      throw new Error(`session cwd must be an absolute path, got "${cwd}"`)
    }
    const header: SessionHeader = {
      version: 1,
      id: sessionId,
      createdAt: options?.meta?.createdAt ?? Date.now(),
      ...cwd !== undefined ? { cwd } : {},
      ...options?.meta?.parentSession !== undefined ? { parentSession: options.meta.parentSession } : {},
    }
    const session = new Session(sessionId, options?.seed, header)
    this.ctx.effect(function* (this: SessionStore) {
      session.onAppend = (event) => { this.ctx.emit('session/event', session, event) }
      this.store.set(sessionId, session)
      // Yield the rollback BEFORE emitting `session/created`: a generator
      // effect collects each yielded disposer before the next step runs, so a
      // throwing `session/created` listener detaches onAppend and removes the
      // store entry instead of leaking them (a leak would wedge the
      // already-exists check until restart). The duplicate throw above fires
      // before any mutation — it leaks nothing.
      yield () => {
        session.onAppend = undefined
        this.store.delete(sessionId)
      }
      this.ctx.emit('session/created', session)
    }.bind(this), 'sessions.create()')
    return session
  }

  get(id: string): Session | undefined {
    return this.store.get(id)
  }

  list(): Session[] {
    return [...this.store.values()]
  }
}

export default SessionStore
