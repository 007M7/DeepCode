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
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from './types.ts'
import type { CreateSessionOptions, EpochHeader, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceIntent, SurfaceEventType } from './types.ts'
import { snapshotJsonValue } from './json.ts'
import { SurfaceManager, isSurfaceEligibleType } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'

export * from './types.ts'
export { isJsonValue, snapshotJsonValue } from './json.ts'
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
     * A session was created in the store. A synchronous listener throw vetoes
     * publication and rollback emits the matching `session/disposed` edge;
     * returned-promise rejection is observed and logged but cannot retroactively
     * veto this synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is the
     * session's owner scope, captured when the session was ENTERED (an agent's
     * session is entered through `agent.ctx`, so its events dispatch in that
     * agent's scope; a bare `sessions.create()` from a plain plugin dispatches
     * subject-less). A listener registered through `agent.ctx` hears only that
     * agent's sessions; a plain plugin listener hears every session.
     * @param session - the session just entered and announced.
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * A previously announced session left the store. Emitted exactly once on
     * normal detach or publication rollback, and never for a prepared/entered
     * session whose `session/created` announcement did not begin. Listener
     * failures (including returned-promise rejections) are logged and contained
     * per listener so teardown always reaches quiescence.
     * Scope-filtered dispatch uses the same owner carrier captured at entry;
     * agent-scoped listeners hear only their own session's teardown.
     * @param session - the session that is no longer live in the store.
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /**
     * An event was appended to a session log (sync, fire-and-forget). This is
     * the per-append feed a UI or invariant plugin tails.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is the
     * session's owner scope, captured when the session was ENTERED (an agent's
     * session is entered through `agent.ctx`, so its events dispatch in that
     * agent's scope; a bare `sessions.create()` from a plain plugin dispatches
     * subject-less). A listener registered through `agent.ctx` hears only that
     * agent's sessions; a plain plugin listener hears every session.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * Awaited durability checkpoint. The agent loop awaits
     * `ctx.sessions.flush(session)` at every turn end; persistence
     * plugins (JSONL, SQLite) drain their write-behind buffers here and on
     * fiber dispose. Awaited (parallel), not a waterfall: every listener runs
     * and the caller waits for all of them, but none can veto. Dispatch it
     * through {@link SessionStore.flush} — the store owns the carrier — never
     * via a raw `ctx.parallel`.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is the
     * session's owner scope, captured when the session was ENTERED (an agent's
     * session is entered through `agent.ctx`, so its events dispatch in that
     * agent's scope; a bare `sessions.create()` from a plain plugin dispatches
     * subject-less). A listener registered through `agent.ctx` hears only that
     * agent's sessions; a plain plugin listener hears every session.
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

/** Reject a record shell that cloning or spreading would otherwise sanitize. */
function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} is not a plain JSON record`)
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} is not a plain JSON record`)
  }
}

/** Capture and validate the caller-owned fields that become a session header. */
function snapshotSessionMeta(source: CreateSessionOptions['meta']): NonNullable<CreateSessionOptions['meta']> {
  if (source === undefined) return {}
  assertPlainRecord(source, 'session metadata')

  // Read each accepted field exactly once. The metadata vocabulary is scalar,
  // so this plain record is already detached from the caller; cloning the
  // caller's shell first would erase a class prototype before validation.
  const cwd = source.cwd
  const parentSession = source.parentSession
  const createdAt = source.createdAt
  const seedLength = source.seedLength
  const accepted = {
    ...cwd !== undefined ? { cwd } : {},
    ...parentSession !== undefined ? { parentSession } : {},
    ...createdAt !== undefined ? { createdAt } : {},
    ...seedLength !== undefined ? { seedLength } : {},
  }
  const snapshot = snapshotJsonValue(accepted)
  if (snapshot === undefined) throw new Error('session metadata is not losslessly JSON-serializable')
  if (snapshot.cwd !== undefined) {
    if (typeof snapshot.cwd !== 'string') throw new Error('session cwd must be a string')
    if (!isAbsolute(snapshot.cwd)) {
      throw new Error(`session cwd must be an absolute path, got "${snapshot.cwd}"`)
    }
  }
  if (snapshot.parentSession !== undefined && typeof snapshot.parentSession !== 'string') {
    throw new Error('session parentSession must be a string')
  }
  if (snapshot.createdAt !== undefined
    && (typeof snapshot.createdAt !== 'number' || !Number.isFinite(snapshot.createdAt))) {
    throw new Error('session createdAt must be a finite number')
  }
  if (snapshot.seedLength !== undefined
    && (typeof snapshot.seedLength !== 'number' || !Number.isSafeInteger(snapshot.seedLength) || snapshot.seedLength < 0)) {
    throw new Error('session seedLength must be a non-negative safe integer')
  }
  return snapshot
}

/** Detach, validate, and freeze the creation metadata published by a session. */
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: SessionHeader = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now() }
    : source
  assertPlainRecord(input, 'session header')

  // Capture each property once before validation. A stateful accessor therefore
  // cannot present one identity or storage location to a check and publish a
  // different one afterward.
  const version = input.version
  const headerId = input.id
  const createdAt = input.createdAt
  const cwd = input.cwd
  const parentSession = input.parentSession
  const seedLength = input.seedLength
  const accepted = {
    version,
    id: headerId,
    createdAt,
    ...cwd !== undefined ? { cwd } : {},
    ...parentSession !== undefined ? { parentSession } : {},
    ...seedLength !== undefined ? { seedLength } : {},
  }
  const snapshot = snapshotJsonValue(accepted)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  if (snapshot.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(snapshot.version)}`)
  }
  if (snapshot.id !== id) {
    throw new Error(`session header id "${String(snapshot.id)}" does not match session id "${id}"`)
  }
  if (typeof snapshot.createdAt !== 'number' || !Number.isFinite(snapshot.createdAt)) {
    throw new Error('session header createdAt must be a finite number')
  }
  if (snapshot.cwd !== undefined) {
    if (typeof snapshot.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(snapshot.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${snapshot.cwd}"`)
    }
  }
  if (snapshot.parentSession !== undefined && typeof snapshot.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  if (snapshot.seedLength !== undefined
    && (typeof snapshot.seedLength !== 'number' || !Number.isSafeInteger(snapshot.seedLength) || snapshot.seedLength < 0)) {
    throw new Error('session header seedLength must be a non-negative safe integer')
  }
  return deepFreeze(snapshot)
}

/** Validate the runtime shape of surface metadata after its JSON snapshot. */
function assertSurfaceMetadataShape(
  type: string,
  surfaceOp: unknown,
  sourceEventSeqs: unknown,
): void {
  const eligible = isSurfaceEligibleType(type)
  if (!eligible) {
    if (surfaceOp !== undefined || sourceEventSeqs !== undefined) {
      throw new Error(`session event "${type}" is not surface-eligible and cannot carry surface metadata`)
    }
    return
  }
  if (surfaceOp === undefined) {
    throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (surfaceOp !== 'append') {
    if (surfaceOp === null || typeof surfaceOp !== 'object' || Array.isArray(surfaceOp)) {
      throw new Error(`session event "${type}" carries an invalid surfaceOp`)
    }
    const op = surfaceOp as Record<string, unknown>
    const keys = Object.keys(op)
    if (keys.length !== 3 || !Object.hasOwn(op, 'op') || !Object.hasOwn(op, 'start') || !Object.hasOwn(op, 'end')
      || op['op'] !== 'replace'
      || typeof op['start'] !== 'number' || !Number.isSafeInteger(op['start']) || op['start'] < 0
      || typeof op['end'] !== 'number' || !Number.isSafeInteger(op['end']) || op['end'] < 0) {
      throw new Error(`session event "${type}" carries an invalid replace surfaceOp`)
    }
  }
  if (sourceEventSeqs !== undefined) {
    if (!Array.isArray(sourceEventSeqs)
      || sourceEventSeqs.some(seq => typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)) {
      throw new Error(`session event "${type}" sourceEventSeqs must contain non-negative safe integers`)
    }
  }
}

/** Validate the fixed event envelope after one-pass JSON materialization. */
function assertSessionEventEnvelope(value: Record<string, unknown>, index: number): asserts value is SessionEvent {
  const event = value
  const allowed = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])
  if (Object.keys(event).some(key => !allowed.has(key))
    || !Object.hasOwn(event, 'type') || typeof event['type'] !== 'string'
    || !Object.hasOwn(event, 'seq') || typeof event['seq'] !== 'number'
    || !Number.isSafeInteger(event['seq']) || event['seq'] < 0
    || !Object.hasOwn(event, 'time') || typeof event['time'] !== 'number'
    || !Number.isSafeInteger(event['time']) || event['time'] < 0
    || !Object.hasOwn(event, 'data')) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
}

/** Render an arbitrary thrown value without allowing coercion to throw again. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

const appendObservers = new WeakMap<Session, (event: SessionEvent) => void>()

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create instances via `ctx.sessions.create()`.
 * Seeding with an existing event log replays/forks a session.
 */
export class Session {
  private log: SessionEvent[] = []

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
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is constructed bare (tests, ad-hoc replay), a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
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
      this.log = Array.from(seed, (source, index) => {
        // Spreading would erase a class instance's prototype. Reject an exotic
        // event shell before that normalization can turn it into an apparently
        // valid plain record; field values are still captured by the one spread
        // below, so their accessors are not read twice.
        assertPlainRecord(source, `seed event at index ${index}`)
        // Read every enumerable event field once. Validation and snapshot
        // construction must consume this same captured record: a stateful seed
        // index or event getter cannot present one record to the checks and
        // another to the durable log.
        const event = { ...source }
        // Materialize the complete accepted record in one recursive pass. A
        // validate-then-structuredClone sequence would reread nested getters and
        // could sanitize a class instance returned only to the clone.
        const snapshot = snapshotJsonValue(event)
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // Surface-eligible events MUST carry a surfaceOp marker — the surface is
        // the sole source of derived history, so a marker-less message event
        // would load fine yet vanish from deriveMessages(). `append` enforces
        // this at compile time via its typed overload; a seed arrives as raw
        // SessionEvent[] (replay/fork/load), bypassing that, so re-check at
        // runtime here rather than silently resuming with empty history.
        const structural = snapshot as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
        try {
          assertSurfaceMetadataShape(snapshot.type, structural.surfaceOp, structural.sourceEventSeqs)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        return deepFreeze(snapshot)
      })
    }
    this.header = snapshotSessionHeader(id, header)
    // TypeScript readonly prevents ordinary typed assignment only. Pin both
    // public identity bindings at runtime too: setup/plugins receive the live
    // Session object, and replacing either slot would split registry keys,
    // persistence routing, and the already-validated header.
    Object.defineProperties(this, {
      id: { value: id, enumerable: true, writable: false, configurable: false },
      header: { value: this.header, enumerable: true, writable: false, configurable: false },
    })
  }

  /** Cached immutable public snapshot of the private append-only log. */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[] {
    this.eventsSnapshot ??= Object.freeze([...this.log])
    return this.eventsSnapshot
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number {
    return this.log.length
  }

  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private append observer. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously.
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
   * @throws if `type` is not a string, or if `data` or surface metadata is not
   *   losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
    if (typeof type !== 'string') {
      throw new TypeError('session event type must be a string')
    }
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    const sourceEventSeqs = surfaceOpts?.sourceEventSeqs
    const surfaceOp = surfaceOpts?.surfaceOp
    // Surface-eligible events MUST carry a surfaceOp marker — the surface is the
    // sole source of derived history, so a marker-less message event would be
    // logged yet vanish from deriveMessages(). The typed `opts` overload makes
    // the marker mandatory only when `T` is a SPECIFIC SurfaceEventType literal;
    // when `T` widens to the SessionEventType union (a caller iterating raw
    // events: `for (const e of log) append(e.type, e.data)`), the conditional
    // rest collapses to optional and the compiler stops enforcing it. Re-check
    // at runtime so that loophole can't silently drop history.
    const surfaceMetadata = {
      ...sourceEventSeqs !== undefined ? { sourceEventSeqs } : {},
      ...surfaceOp !== undefined ? { surfaceOp } : {},
    }
    // The caller still owns the data and metadata objects and could mutate them
    // after append. Materialize each accepted value exactly once while checking
    // its JSON vocabulary, so the log cannot drift and a stateful getter cannot
    // show one value to validation and another to a prototype-erasing clone. The
    // returned event carries these SAME snapshots.
    //
    // Surface metadata accessors are read once into one plain record; the
    // recursive snapshot then reads each nested value once as it copies it.
    // Build the event shape with conditional surface fields via spreading.
    // The result is cast through `unknown` because the conditional spreads
    // produce an intersection type that the assignability checker can't
    // narrow to a specific discriminated-union member when T is generic.
    // This is a safe internal boundary: data and surface metadata are
    // materialized below before the event enters the log.
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }
    assertSurfaceMetadataShape(
      type,
      (surfaceMetadataSnapshot as { surfaceOp?: unknown }).surfaceOp,
      (surfaceMetadataSnapshot as { sourceEventSeqs?: unknown }).sourceEventSeqs,
    )
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data: dataSnapshot,
      ...surfaceMetadataSnapshot,
    } as unknown as SessionEvent<T>
    const acceptedEvent = deepFreeze(event)
    this.log.push(acceptedEvent as unknown as SessionEvent)
    this.eventsSnapshot = undefined
    appendObservers.get(this)?.(acceptedEvent as unknown as SessionEvent)
    return acceptedEvent
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
 * Unforgeable ownership handle for one unpublished session id. A factory keeps
 * this capability across load/setup, preventing setup code from entering the
 * prepared Session or publishing a replacement under the same id. Obtain it
 * only from {@link SessionStore.reserve}.
 */
export interface SessionRegistrationReservation {
  /** The reserved store id. */
  readonly id: SessionId
  /**
   * Construct the one Session owned by this reservation.
   * @param options - seed events and creation metadata.
   * @returns the still-unpublished Session.
   */
  prepare(options?: CreateSessionOptions): Session
  /**
   * Release the unpublished reservation; idempotent. The store also releases
   * it automatically when the fiber that called `reserve` disposes.
   * @returns nothing.
   */
  release(): void
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, Session>()
  /** The one accepted map key for each live session; never reread caller state. */
  private acceptedIds = new WeakMap<Session, SessionId>()
  /** Sessions whose creation announcement began and therefore require a pair. */
  private announced = new WeakSet<Session>()
  /** Unpublished identities held across factory load/setup transactions. */
  private reservations = new Map<SessionId, SessionRegistrationReservation>()
  /** The exact prepared object owned by each reservation capability. */
  private reservedSessions = new WeakMap<SessionRegistrationReservation, Session>()
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
   * Reserve one unpublished session id across an asynchronous factory
   * transaction. Bare `prepare`/`create`/`enter` calls for the id reject until
   * release; the capability constructs exactly one Session and is passed back
   * to {@link enter} at publication. The reservation belongs to the calling
   * fiber, so owner unload releases an abandoned id automatically.
   * @param id - the session id the transaction will publish.
   * @returns the opaque reservation capability.
   * @throws if the id is malformed, live, or already reserved.
   */
  reserve(id: SessionId): SessionRegistrationReservation {
    if (typeof id !== 'string') throw new TypeError('session id must be a string')
    if (this.store.has(id) || this.reservations.has(id)) {
      throw new Error(`session "${id}" already exists or is reserved`)
    }
    let active = true
    let prepared = false
    const rawRelease = (): void => {
      if (!active) return
      active = false
      this.reservedSessions.delete(reservation)
      this.reservations.delete(id)
    }
    let disposeEffect!: () => Promise<void> | void
    const reservation: SessionRegistrationReservation = Object.freeze({
      id,
      prepare: (options?: CreateSessionOptions) => {
        if (!active) {
          throw new Error(`session "${id}" reservation is no longer active`)
        }
        if (prepared) throw new Error(`session "${id}" reservation already prepared a session`)
        prepared = true
        const session = this.prepareReserved(id, options, reservation)
        this.reservedSessions.set(reservation, session)
        return session
      },
      release: () => {
        rawRelease()
        // Remove the now-inert ownership effect on manual transaction settle;
        // its cleanup is the exact idempotent raw release above.
        void disposeEffect()
      },
    })
    this.reservations.set(id, reservation)
    try {
      disposeEffect = this.ctx.effect(() => rawRelease, `sessions.reserve(${id})`)
    } catch (error: unknown) {
      rawRelease()
      throw error
    }
    return reservation
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
   * loop's final flush is captured before the store-owned observer detaches), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see `dsh-agent-loop`'s
   * `startOwned`).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // Single effect owned by the calling fiber. Yield the detach BEFORE
    // announcing so a throwing `session/created` listener rolls the attach back
    // (the generator effect disposes already-yielded disposers on a throw)
    // instead of leaking the store entry + append observer.
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
   * chain rather than as racing sibling effects — which would detach the append observer
   * before the loop's closing `session/flush`, dropping the closing events.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: CreateSessionOptions): Session {
    return this.prepareReserved(id, options)
  }

  /** Shared prepare implementation, optionally authorized by a reservation. */
  private prepareReserved(
    id?: SessionId,
    options?: CreateSessionOptions,
    reservation?: SessionRegistrationReservation,
  ): Session {
    let sessionId: SessionId
    if (id === undefined) {
      do sessionId = SessionId(`session-${++this.counter}`)
      while (this.store.has(sessionId) || this.reservations.has(sessionId))
    } else {
      sessionId = SessionId(id)
    }
    if (typeof sessionId !== 'string') throw new TypeError('session id must be a string')
    const held = this.reservations.get(sessionId)
    if (reservation === undefined && held !== undefined) {
      throw new Error(`session "${sessionId}" is reserved for unpublished creation`)
    }
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    const seed = options?.seed
    const meta = snapshotSessionMeta(options?.meta)
    const cwd = meta.cwd
    const parentSession = meta.parentSession
    const seedLength = meta.seedLength
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta.createdAt ?? Date.now(),
      ...cwd !== undefined ? { cwd } : {},
      ...parentSession !== undefined ? { parentSession } : {},
      ...seedLength !== undefined ? { seedLength } : {},
    }
    return new Session(sessionId, seed, header)
  }

  /**
   * Enter a {@link prepare}d session into the store: wire the module-private
   * append observer to `session/event` and add it to the store. Returns the
   * DETACH disposer (observer + store removal). Does NOT emit `session/created` —
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
   * @param reservation - the exact unpublished-id capability when a factory
   *   reserved this session across setup.
   * @returns the detach disposer (observer + store removal).
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session, reservation?: SessionRegistrationReservation): () => void {
    const id = session.id
    if (typeof id !== 'string') throw new TypeError('session id must be a string')
    const held = this.reservations.get(id)
    if (reservation === undefined) {
      if (held !== undefined) throw new Error(`session "${id}" is reserved for unpublished creation`)
    } else if (reservation.id !== id || held !== reservation
      || this.reservedSessions.get(reservation) !== session) {
      throw new Error(`session "${id}" registration reservation does not own this prepared session`)
    }
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    if (appendObservers.has(session)) throw new Error(`session "${id}" is already attached to a store`)
    // The carrier is decided HERE, once, from the ENTERING context's scope tag
    // (`this.ctx` is the caller's context — the tracker mechanism): every
    // session/created|event|flush dispatch for this session uses it, so the
    // session's whole event feed is scope-filtered consistently. The base is
    // the session itself (scoped listeners' `this` is the session).
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    this.carriers.set(session, carrier)
    const emitCtx = this.ctx
    appendObservers.set(session, (event) => { emitCtx.emit(carrier, 'session/event', session, event) })
    this.acceptedIds.set(session, id)
    this.store.set(id, session)
    let entered = true
    return () => {
      if (!entered) return
      entered = false
      const wasAnnounced = this.announced.delete(session)
      appendObservers.delete(session)
      this.acceptedIds.delete(session)
      this.carriers.delete(session)
      this.store.delete(id)
      if (wasAnnounced) this.emitDisposed(session, carrier, id)
    }
  }

  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void {
    const carrier = this.liveCarrierFor(session)
    if (this.announced.has(session)) {
      throw new Error(`session "${session.id}" was already announced`)
    }
    // Mark before emit: Cordis emit may deliver to earlier listeners and then
    // throw. Rollback must still pair that partial creation with disposal, and
    // a listener cannot recursively create a second lifecycle edge.
    this.announced.add(session)
    const args: unknown[] = [carrier, 'session/created', session]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      // Synchronous throws intentionally propagate and veto publication; the
      // yielded detach then emits the paired disposal edge. An async function
      // is nevertheless assignable to a void listener, so observe its returned
      // promise: rejection is too late to roll back and must be logged instead
      // of becoming unhandled.
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        this.ctx.logger.warn(`session "${session.id}": session/created listener rejected: ${renderThrown(error)}`)
      })
    }
  }

  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed(session: Session, carrier: Scoped<Session>, id: SessionId): void {
    const args: unknown[] = [carrier, 'session/disposed', session]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`session "${id}": session/disposed listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`session "${id}": session/disposed listener threw: ${renderThrown(error)}`)
      }
    }
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
    const id = this.acceptedIds.get(session)
    if (id === undefined || this.store.get(id) !== session) {
      throw new Error(`session "${id ?? session.id}" is not live in this store`)
    }
    const carrier = this.carriers.get(session)
    // enter() installs store + carrier in one synchronous sequence; a live
    // session without one is an internal invariant violation, never fallback
    // to subject-less dispatch (that would silently cross scope boundaries).
    /* v8 ignore next -- enter installs store and carrier in one synchronous sequence */
    if (carrier === undefined) {
      throw new Error(`session "${id}" has no dispatch carrier`)
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
