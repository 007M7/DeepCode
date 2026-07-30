// SessionManager: the instance cluster Map<SessionId, Session> (lazy-built, resident) + the frame
// dispatch entry + list state, constructed and held by SessionsService (one per client runtime).
// List data never enters zustand; React connects via subscribe/getListSnapshot.

import type { IApiClient, HostFrame, MuxFrame, RpcError, RpcRequest, RpcResult, SessionId, SessionSummary, WorkspaceId } from '@deepseek-ai/dsh-client-connection/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import type { SessionListEntry, TitledSessionSummary } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
// Type-only merge edge: the title domain's client-namespace outlet declares
// the 'title' projection key this manager projects into list rows (and any
// useProjection('title') consumer reads). Zero value imports by construction.
import type {} from '@deepseek-ai/dsh-session-title/client'
import { Notifier } from './notifier.ts'
import { ProjectionValueStore } from './projection-store.ts'
import { Session } from './session.ts'

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  /** Selected Session id (validated against items; masked to undefined while its session is off the list). */
  current: SessionId | undefined
  state: 'idle' | 'loading' | 'error'
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  error: RpcError | null
}

type SessionListMutation =
  | { kind: 'upsert'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean }
  /** Local first-send flip: the sender clears blank without waiting for a host frame. */
  | { kind: 'engaged'; sessionId: SessionId }

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
  /** Outstanding approval questions per session, keyed by approvalId (idempotent under mux-open
   *  replays of the same requested frame). Manager-owned rather than read off Session instances
   *  because the sidebar must light up for sessions never instantiated. Cleared per connection
   *  generation — the reopen replay re-adds still-pending questions — and on session-removed. */
  private readonly waitingApprovals = new Map<SessionId, Set<string>>()
  /** Per-session projection value stores, retained independently of instance arrival (the
   *  title-snapshot precedent, generalized): push frames land here whether or not the Session
   *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
   *  same store so history-baseline seeding and frames converge on one row set. */
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
  private listPhase: SessionListPhase = 'pending'
  private listError: RpcError | null = null
  private listInflight: Promise<void> | null = null
  /** Mutations arriving after a list request starts are replayed over its response. */
  private listMutations: SessionListMutation[] | null = null

  private selected: SessionId | undefined

  private listSnapshotCache: SessionListSnapshot
  /** Entry-identity cache (§C.2 reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh (audit S5). */
  private entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  /**
   * @param api - shared wire client.
   * @param restoredSelection - persisted real-Session selection candidate.
   */
  constructor(
    private readonly api: IApiClient,
    restoredSelection?: SessionId,
  ) {
    this.selected = restoredSelection
    this.listSnapshotCache = this.buildListSnapshot()
  }

  // ---- Selection ----

  /**
   * Select a listed Session.
   * @param sessionId - listed Session id.
   */
  select(sessionId: SessionId): void {
    if (!this.summaries.some(summary => summary.sessionId === sessionId)) {
      throw new Error(`sessions.select: unknown session ${sessionId}`)
    }
    this.selected = sessionId
    this.notifier.notifyNow()
  }

  /** Clear the selection (the layout falls to the no-session view state). */
  clearSelection(): void {
    this.selected = undefined
    this.notifier.notifyNow()
  }

  // ---- Instance management ----

  /**
   * Drop a session instance (scope-prune companion, decision 12: instance
   * and scope share one lifecycle). The host session log is the durable
   * truth — a later get() lazily rebuilds and open() backfills history.
   * @param sessionId - the session to drop.
   */
  drop(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Lazy build: return the existing instance or construct one (no auto-open —
   * open is triggered by the container's select callback).
   * @param sessionId - the session to get.
   * @returns the resident instance.
   */
  get(sessionId: SessionId): Session {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = this.createSession(sessionId)
      this.sessions.set(sessionId, session)
      // Replay approval/question/queued frames buffered before instantiation (rpcId
      // verbatim, same semantics as the subscribed baseline replay). Replay happens
      // BEFORE the running-bit sync: a not-running summary must sweep replayed queue
      // rows the same way a live status flip would (their retirement events dropped
      // while the session was uninstantiated).
      const buffered = this.pendingBuffers.get(sessionId)
      if (buffered !== undefined) {
        this.pendingBuffers.delete(sessionId)
        for (const envelope of buffered) session.handleMuxEnvelope(envelope.rpcId, envelope.payload)
      }
      // Sync the running and blank bits from the list snapshot into the new
      // instance (consistency when the list precedes open).
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) {
        session.handleBlank(summary.blank)
        session.handleRunning(summary.running)
      }
    }
    return session
  }

  private createSession(sessionId: SessionId): Session {
    return new Session(sessionId, this.api, {
      // The sender's local first-send flip mirrors into the list row so the
      // session surfaces (lists filter on blank) before any host frame lands.
      onEngaged: (engaged) => {
        this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId })
      },
      projections: this.projectionStore(sessionId),
    })
  }

  /** Resident per-session projection store (create-on-demand; outlives instantiation). */
  private projectionStore(sessionId: SessionId): ProjectionValueStore {
    let store = this.projectionStores.get(sessionId)
    if (store === undefined) {
      store = new ProjectionValueStore()
      // List rows project off store keys (title); any-key changes re-enter
      // the manager's own batched rebuild channel.
      store.subscribeAny(() => { this.notifier.markDirty() })
      this.projectionStores.set(sessionId, store)
    }
    return store
  }

  // ---- List surface ----

  /** Full refresh via session.list (single-flight: an in-flight call is reused). */
  refreshList(): Promise<void> {
    if (this.listInflight !== null) return this.listInflight
    this.listState = 'loading'
    this.listError = null
    const established = this.summaries
    const mutations: SessionListMutation[] = []
    this.listMutations = mutations
    this.notifier.markDirty()
    this.listInflight = (async () => {
      try {
        const { result } = await this.api.sessions.list({})
        if (result.ok) {
          let summaries = this.listPhase === 'pending'
            ? result.value.items
            : mergeOrderedBaseline(established, result.value.items, summary => summary.sessionId)
          for (const mutation of mutations) summaries = applyMutation(summaries, mutation)
          this.summaries = summaries
          this.listState = 'idle'
          this.listPhase = 'ready'
          // Push running/blank bits down to instantiated Sessions (the list is the authoritative summary source).
          for (const s of this.summaries) {
            const session = this.sessions.get(s.sessionId)
            if (session === undefined) continue
            session.handleBlank(s.blank)
            session.handleRunning(s.running)
          }
          // Seed each row's projection baseline into the per-session value
          // store (cold titles surface without opening the session). Per-key
          // apply, not seed(): the list block is a partial baseline — the
          // cold cache serves only version-matching keys — so an absent key
          // must not clear; higher-seq-wins still keeps a stale list block
          // from overwriting a newer push frame or tail baseline.
          for (const s of result.value.items) {
            const block = s.projections
            if (block === undefined) continue
            const store = this.projectionStore(s.sessionId)
            const values = block.values as Record<string, unknown>
            for (const key of Object.keys(values)) store.apply(key, values[key], block.asOfSeq)
          }
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
        this.listMutations = null
        this.listInflight = null
        this.notifier.markDirty()
      }
    })()
    return this.listInflight
  }

  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh). A created session is blank by definition
   * (entity birth precedes the first message).
   * @param opts - target workspace or working directory, plus an optional caller-owned id.
   * @returns the create result.
   */
  async create(
    opts: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId } = {},
  ): Promise<RpcResult<{ sessionId: SessionId }>> {
    try {
      const shared = opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }
      const payload = opts.workspaceId !== undefined
        ? { workspaceId: opts.workspaceId, ...shared }
        : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared }
      const { result } = await this.api.sessions.create(payload)
      if (result.ok) {
        this.recordMutation({ kind: 'upsert', summary: {
          sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        } })
      } else {
        const publishedSessionId = workspaceAttachSessionId(result.error)
        // Publication precedes attachment. The error's id is a real Session,
        // so expose it immediately as Ungrouped while the caller keeps the
        // prompt buffer and decides whether to retry attachment.
        if (publishedSessionId !== undefined) {
          this.recordMutation({ kind: 'upsert', summary: {
            sessionId: publishedSessionId,
            updatedAt: Date.now(),
            running: false,
            blank: true,
          } })
        }
      }
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Insert-or-enrich a locally synthesized summary: a new id prepends; an
   * existing entry only gains fields it lacks (the session-added frame and the
   * create() echo race — whichever lands second must fill the placeholder's
   * missing cwd/parentSessionId, never overwrite list-refresh data).
   */
  private mergeSummary(summary: SessionSummary): void {
    this.recordMutation({ kind: 'upsert', summary })
  }

  /** Apply immediately and retain for replay when a list response is in flight. */
  private recordMutation(mutation: SessionListMutation): void {
    this.listMutations?.push(mutation)
    this.summaries = applyMutation(this.summaries, mutation)
    this.notifier.markDirty()
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
    if (frame.type === 'session/projection') {
      // Finished host-computed value: land it in the resident store whether or
      // not the Session is instantiated (list rows read the 'title' key). The
      // synchronous markDirty keeps the list snapshot same-tick fresh (the
      // store's own any-key channel is microtask-batched).
      this.projectionStore(frame.sessionId).apply(frame.key, frame.value, frame.seq)
      this.notifier.markDirty()
      return
    }
    if (frame.type === 'session/subscribed') {
      // Rows past the host's durable baseline rode state a restart lost; drop
      // them so last-wins cannot pin a phantom value over recomputed truth.
      this.projectionStores.get(frame.sessionId)?.truncate(frame.lastSeq)
      this.notifier.markDirty()
      // New mux-generation baseline: buffered session/queue frames belong to
      // the previous generation and the host is about to resend the live
      // snapshot — drop them, or every reconnect appends a duplicate batch
      // (and enough reconnects push real approval/question frames past the
      // cap). Same re-baseline signal Session uses for its own mirror.
      const buffered = this.pendingBuffers.get(frame.sessionId)
      if (buffered !== undefined) {
        const kept = buffered.filter(item => item.payload.type !== 'session/queue')
        if (kept.length !== buffered.length) {
          if (kept.length === 0) this.pendingBuffers.delete(frame.sessionId)
          else this.pendingBuffers.set(frame.sessionId, kept)
        }
      }
    }
    // List-level waiting-approval bit (the sidebar amber dot): tracked here for
    // every session, instantiated or not; approvalId keys make replays idempotent.
    if (frame.type === 'approval/requested') {
      let ids = this.waitingApprovals.get(frame.sessionId)
      if (ids === undefined) this.waitingApprovals.set(frame.sessionId, ids = new Set())
      if (!ids.has(frame.approvalId)) {
        ids.add(frame.approvalId)
        this.notifier.markDirty()
      }
    } else if (frame.type === 'approval/resolved') {
      const ids = this.waitingApprovals.get(frame.sessionId)
      if (ids !== undefined && ids.delete(frame.approvalId)) {
        if (ids.size === 0) this.waitingApprovals.delete(frame.sessionId)
        this.notifier.markDirty()
      }
    }
    const session = this.sessions.get(frame.sessionId)
    if (session === undefined) {
      // Approval/question/queue frames never hit history: buffer for replay on
      // instantiation; everything else drops (not instantiated — history fully
      // backfills on open).
      switch (frame.type) {
        case 'approval/requested':
        case 'approval/resolved':
        case 'question/requested':
        case 'question/resolved':
        case 'session/queue': {
          const buffer = this.pendingBuffers.get(frame.sessionId) ?? []
          const prior = frame.type === 'session/queue'
            ? buffer.findIndex(item => item.payload.type === 'session/queue')
            : -1
          if (prior !== -1) buffer.splice(prior, 1)
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
        this.mergeSummary({
          sessionId: frame.sessionId, updatedAt: Date.now(), running: false, blank: frame.blank,
          ...(frame.parentSessionId !== undefined ? { parentSessionId: frame.parentSessionId } : {}),
          ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
        })
        this.sessions.get(frame.sessionId)?.handleBlank(frame.blank)
        return
      }
      case 'host/session-removed': {
        this.recordMutation({ kind: 'remove', sessionId: frame.sessionId })
        this.sessions.get(frame.sessionId)?.handleRemoved() // instance survives (resident-instance rule), only flagged in the snapshot
        this.pendingBuffers.delete(frame.sessionId) // a removed session's buffered frames must not replay on a future instantiation
        this.waitingApprovals.delete(frame.sessionId) // a removed session cannot wait on anyone
        this.projectionStores.delete(frame.sessionId) // removed sessions drop their projection rows with the instance
        return
      }
      case 'host/session-status': {
        this.recordMutation({ kind: 'status', sessionId: frame.sessionId, running: frame.running })
        this.sessions.get(frame.sessionId)?.handleRunning(frame.running)
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

  /**
   * The moment a connection generation dies (before any next-generation frame
   * can arrive — onConnected waits for the readiness handshake while replayed
   * frames flow from stream open, so clearing there would race the replay):
   * drop generation-scoped live state. Approvals resolved while disconnected
   * send no frame, so the stale bits and the buffered answerable frames must
   * not survive into the next generation — the mux-open replay re-adds every
   * still-pending question with its live rpcId.
   */
  handleDisconnected(): void {
    if (this.waitingApprovals.size > 0) {
      this.waitingApprovals.clear()
      this.notifier.markDirty()
    }
    for (const [sessionId, buffer] of [...this.pendingBuffers]) {
      const kept = buffer.filter(item =>
        item.payload.type !== 'approval/requested' && item.payload.type !== 'approval/resolved'
        && item.payload.type !== 'question/requested' && item.payload.type !== 'question/resolved')
      if (kept.length === buffer.length) continue
      if (kept.length === 0) this.pendingBuffers.delete(sessionId)
      else this.pendingBuffers.set(sessionId, kept)
    }
  }

  /** After each connection generation: refresh the session baseline and rebuild opened windows. */
  handleConnected(): void {
    void this.refreshList()
    for (const session of this.sessions.values()) void session.resync()
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // List rows read the generic 'title' projection key (host-computed unit
      // value; the bespoke session/title frame is retired).
      const title = this.projectionStores.get(summary.sessionId)?.get('title')
      return typeof title === 'string' && title !== ''
        ? { ...summary, title }
        : summary
    })
    const fresh = flattenLineage(merged, new Set(this.waitingApprovals.keys()))
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.title === entry.title && prev.depth === entry.depth
        && prev.waitingApproval === entry.waitingApproval
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    for (const id of this.entryCache.keys()) {
      if (!items.some(e => e.sessionId === id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    const selected = this.selected
    const current = selected !== undefined && items.some(item => item.sessionId === selected)
      ? selected
      : undefined
    return {
      items: this.itemsCache,
      current,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
    }
  }
}

/** Apply one list mutation without deriving display order. */
function applyMutation(summaries: readonly SessionSummary[], mutation: SessionListMutation): SessionSummary[] {
  switch (mutation.kind) {
    case 'upsert': {
      const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId)
      if (existing === undefined) return [mutation.summary, ...summaries]
      const filled: SessionSummary = {
        ...existing,
        // Blank only lowers: a stale true (session-added racing the local
        // first send) never re-hides an already-surfaced session.
        blank: existing.blank && mutation.summary.blank,
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.blank === existing.blank) return [...summaries]
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove':
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    case 'status':
      // running:true doubles as the cross-端 blank flip (a blank session
      // never runs, so the first running frame proves a message landed).
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && (summary.running !== mutation.running || (mutation.running && summary.blank))
        ? { ...summary, running: mutation.running, blank: summary.blank && !mutation.running }
        : summary)
    case 'engaged':
      return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.blank
        ? { ...summary, blank: false }
        : summary)
  }
}

/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error: RpcError): SessionId | undefined {
  const candidate = error as unknown as { code: string; details: { sessionId?: SessionId } }
  return candidate.code === 'workspace-attach-failed' ? candidate.details.sessionId : undefined
}
