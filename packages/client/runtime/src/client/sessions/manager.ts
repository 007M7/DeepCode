// SessionManager: the instance cluster Map<SessionId, Session> (lazy-built, resident) + the frame
// dispatch entry + list state, constructed and held by SessionsService (one per client runtime).
// List data never enters zustand; React connects via subscribe/getListSnapshot.

import type { IApiClient, HostFrame, MuxFrame, RpcError, RpcRequest, RpcResult, SessionId, SessionSummary } from '@deepseek-ai/dsh-client-connection/client'
import { transportError } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionListEntry } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
import { Notifier } from './notifier.ts'
import { Session } from './session.ts'

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  state: 'idle' | 'loading' | 'error'
  error: RpcError | null
}

/** Per-session cap for pre-instantiation approval/question buffering (low-frequency frames; a few dozen covers any real backlog). */
const PENDING_BUFFER_CAP = 32

/** Instance cluster + frame entry + the session list (see the web client architecture RFC). */
export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  /** Approval/question frame buffer for uninstantiated sessions: pending interactions never hit
   *  history (cannot be backfilled on open), the one frame class that must not take the
   *  drop-and-backfill path; replayed and cleared on instantiation. Bounded per session (these
   *  frames are low-frequency; overflow drops oldest) and dropped on session-removed (audit S7). */
  private readonly pendingBuffers = new Map<SessionId, RpcRequest<MuxFrame>[]>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  private listError: RpcError | null = null
  private listInflight: Promise<void> | null = null

  private listSnapshotCache: SessionListSnapshot
  /** Entry-identity cache (§C.2 reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh (audit S5). */
  private entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  constructor(private readonly api: IApiClient) {
    this.listSnapshotCache = this.buildListSnapshot()
  }

  // ---- Instance management ----

  /**
   * Lazy build: return the existing instance or construct one (no auto-open —
   * open is triggered by the container's select callback).
   * @param sessionId - the session to get.
   * @returns the resident instance.
   */
  get(sessionId: SessionId): Session {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = new Session(sessionId, this.api)
      this.sessions.set(sessionId, session)
      // Sync the running bit from the list snapshot into the new instance (consistency when the list precedes open).
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) session.handleRunning(summary.running)
      // Replay approval/question frames buffered before instantiation (rpcId verbatim, same semantics as the subscribed baseline replay).
      const buffered = this.pendingBuffers.get(sessionId)
      if (buffered !== undefined) {
        this.pendingBuffers.delete(sessionId)
        for (const envelope of buffered) session.handleMuxEnvelope(envelope.rpcId, envelope.payload)
      }
    }
    return session
  }

  // ---- List surface ----

  /** Full refresh via session.list (single-flight: an in-flight call is reused). */
  refreshList(): Promise<void> {
    if (this.listInflight !== null) return this.listInflight
    this.listState = 'loading'
    this.listError = null
    this.notifier.markDirty()
    this.listInflight = (async () => {
      try {
        const { result } = await this.api.sessions.list({})
        if (result.ok) {
          this.summaries = result.value.items
          this.listState = 'idle'
          // Push running bits down to instantiated Sessions (the list is the authoritative summary source).
          for (const s of this.summaries) this.sessions.get(s.sessionId)?.handleRunning(s.running)
        } else {
          this.listState = 'error'
          this.listError = result.error
        }
      } catch (error) {
        this.listState = 'error'
        const folded = transportError<never>(error)
        /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
        this.listError = folded.ok ? null : folded.error
      } finally {
        this.listInflight = null
        this.notifier.markDirty()
      }
    })()
    return this.listInflight
  }

  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh).
   * @param cwd - optional working directory for the new session.
   * @returns the create result.
   */
  async create(cwd?: string): Promise<RpcResult<{ sessionId: SessionId }>> {
    try {
      const { result } = await this.api.sessions.create(cwd === undefined ? {} : { cwd })
      if (result.ok && !this.summaries.some(s => s.sessionId === result.value.sessionId)) {
        this.summaries = [
          { sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, ...(cwd !== undefined ? { cwd } : {}) },
          ...this.summaries,
        ]
        this.notifier.markDirty()
      }
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  // ---- Subscription surface (for useSessionList) ----

  /**
   * uSES subscription entry for useSessionList.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached list snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getListSnapshot(): SessionListSnapshot {
    this.notifier.ensureFresh()
    return this.listSnapshotCache
  }

  // ---- ConnectionController sinks (wired by boot) ----

  /**
   * Mux frame entry: sessionId-bearing frames go only to instantiated sessions
   * (no lazy build; non-pending frames for uninstantiated sessions drop —
   * history backfills them on open).
   * @param envelope - the frame with its wire rpcId.
   */
  handleMuxEnvelope(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'stream/error') return // Controller already treats this as stream failure
    const session = this.sessions.get(frame.sessionId)
    if (session === undefined) {
      // Approval/question frames never hit history: buffer for replay on instantiation;
      // everything else drops (not instantiated — history fully backfills on open).
      switch (frame.type) {
        case 'approval/requested':
        case 'approval/resolved':
        case 'question/requested':
        case 'question/resolved': {
          const buffer = this.pendingBuffers.get(frame.sessionId) ?? []
          buffer.push(envelope)
          if (buffer.length > PENDING_BUFFER_CAP) buffer.splice(0, buffer.length - PENDING_BUFFER_CAP)
          this.pendingBuffers.set(frame.sessionId, buffer)
          return
        }
        default:
          return
      }
    }
    session.handleMuxEnvelope(envelope.rpcId, frame)
  }

  /**
   * Host frame entry: list upkeep + per-instance running/removed/agent-error relay.
   * @param envelope - the frame with its wire rpcId.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    switch (frame.type) {
      case 'host/session-added': {
        if (!this.summaries.some(s => s.sessionId === frame.sessionId)) {
          this.summaries = [
            {
              sessionId: frame.sessionId, updatedAt: Date.now(), running: false,
              ...(frame.parentSessionId !== undefined ? { parentSessionId: frame.parentSessionId } : {}),
            },
            ...this.summaries,
          ]
          this.notifier.markDirty()
        }
        return
      }
      case 'host/session-removed': {
        this.summaries = this.summaries.filter(s => s.sessionId !== frame.sessionId)
        this.sessions.get(frame.sessionId)?.handleRemoved() // instance survives (resident-instance rule), only flagged in the snapshot
        this.pendingBuffers.delete(frame.sessionId) // a removed session's buffered frames must not replay on a future instantiation
        this.notifier.markDirty()
        return
      }
      case 'host/session-status': {
        this.summaries = this.summaries.map(s =>
          s.sessionId === frame.sessionId && s.running !== frame.running ? { ...s, running: frame.running } : s)
        this.sessions.get(frame.sessionId)?.handleRunning(frame.running)
        this.notifier.markDirty()
        return
      }
      case 'host/agent-error': {
        this.sessions.get(frame.sessionId)?.handleAgentError(frame.message)
        return // not reflected in the list
      }
      default:
        return // stream/error ignored; unknown frames ignored (documented default)
    }
  }

  /** After each connection generation (first connect included): refresh the list + resync opened instances (reconnect = rebuild). */
  handleConnected(): void {
    void this.refreshList()
    for (const session of this.sessions.values()) void session.resync()
  }

  private buildListSnapshot(): SessionListSnapshot {
    const fresh = flattenLineage(this.summaries)
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd && prev.depth === entry.depth
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    for (const id of this.entryCache.keys()) {
      if (!items.some(e => e.sessionId === id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    return { items: this.itemsCache, state: this.listState, error: this.listError }
  }
}
