// SessionManager: the instance cluster Map<SessionId, Session> (lazy-built, resident) + the frame
// dispatch entry + list state, constructed and held by SessionsService (one per client runtime).
// List data never enters zustand; React connects via subscribe/getListSnapshot.

import type {
  IApiClient, HostFrame, MuxFrame, RpcError, RpcRequest, RpcResult, SessionId,
  SessionSummary, SubagentAddress, SubagentCatalog, WorkspaceId,
} from '@deepseek-ai/dsh-client-connection/client'
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

/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  /** Selected Session id (validated against items; masked to undefined while its session is off the list). */
  current: SessionId | undefined
  state: 'idle' | 'loading' | 'error'
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  error: RpcError | null
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  currentAddress: SubagentAddress | undefined
}

/** One parent-addressed durable catalog projected through the sessions snapshot. */
export interface SubagentCatalogSnapshot extends SubagentCatalog {
  state: 'loading' | 'ready' | 'error'
  error: RpcError | null
}

interface CatalogInflight {
  readonly promise: Promise<void>
  readonly expandableRows: Set<SessionId>
  readonly activityRows: Map<SessionId, 'running' | 'inactive'>
  /** Removal-time invalidation replayed over the response this request predates. */
  parentAvailableOverride: false | undefined
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
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  private readonly catalogs = new Map<SessionId, SubagentCatalogSnapshot>()
  private readonly catalogInflight = new Map<SessionId, CatalogInflight>()
  /** Catalog owners whose membership changed while a pull was in flight: one trailing refresh after it settles. */
  private readonly catalogStale = new Set<SessionId>()
  private readonly openCatalogs = new Set<SessionId>()
  private readonly catalogDebounce = new Map<SessionId, ReturnType<typeof setTimeout>>()

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
    restoredAddress?: SubagentAddress,
  ) {
    this.selected = restoredSelection
    if (restoredAddress !== undefined) this.addresses.set(restoredAddress.childSessionId, restoredAddress)
    this.listSnapshotCache = this.buildListSnapshot()
  }

  // ---- Selection ----

  /**
   * Select a listed Session or a retained catalog-addressed child.
   * @param sessionId - listed or catalog-addressed Session id.
   */
  select(sessionId: SessionId): void {
    const address = this.navigationAddress(sessionId)
    if (!this.summaries.some(summary => summary.sessionId === sessionId) && address === undefined) {
      throw new Error(`sessions.select: unknown session ${sessionId}`)
    }
    if (address !== undefined) this.addresses.set(sessionId, address)
    this.sessions.get(sessionId)?.configureSubagent(
      address,
      address === undefined
        ? false
        : this.catalogs.get(address.parentSessionId)?.parentAvailable ?? false,
    )
    this.selected = sessionId
    void this.refreshSubagents(sessionId)
    this.notifier.notifyNow()
  }

  /**
   * Select a healthy child through its durable direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  selectSubagent(address: SubagentAddress): void {
    const catalog = this.catalogs.get(address.parentSessionId)
    const entry = catalog?.entries.find(candidate => candidate.id === address.childSessionId)
    if (entry === undefined || entry.kind !== 'child' || entry.mode !== address.mode) {
      throw new Error(`sessions.selectSubagent: ${address.childSessionId} is not a healthy catalog child`)
    }
    this.addresses.set(address.childSessionId, address)
    this.sessions.get(address.childSessionId)?.configureSubagent(address, catalog?.parentAvailable ?? false)
    this.selected = address.childSessionId
    void this.refreshSubagents(address.childSessionId)
    this.notifier.notifyNow()
  }

  /** Clear the selection (the layout falls to the no-session view state). */
  clearSelection(): void {
    this.selected = undefined
    this.notifier.notifyNow()
  }

  /**
   * Return the durable catalog address retained for one child.
   * @param sessionId - possible addressed child id.
   * @returns The direct-parent address, when navigation discovered one.
   */
  subagentAddress(sessionId: SessionId): SubagentAddress | undefined {
    return this.addresses.get(sessionId)
  }

  /**
   * Resolve an address for breadcrumb navigation without retaining transport authority.
   * @param sessionId - possible child id in an already-loaded catalog.
   * @returns A retained or catalog-derived direct-parent address.
   */
  navigationAddress(sessionId: SessionId): SubagentAddress | undefined {
    const retained = this.addresses.get(sessionId)
    if (retained !== undefined) return retained
    for (const [parentSessionId, catalog] of this.catalogs) {
      const child = catalog.entries.find(entry => entry.kind === 'child' && entry.id === sessionId)
      if (child?.kind === 'child') {
        return { parentSessionId, childSessionId: sessionId, mode: child.mode }
      }
    }
    return undefined
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
      } else {
        const address = this.addresses.get(sessionId)
        const child = address === undefined ? undefined : this.catalogs.get(address.parentSessionId)?.entries
          .find(entry => entry.kind === 'child' && entry.id === sessionId)
        if (child?.kind === 'child') session.handleRunning(child.activity === 'running')
      }
    }
    return session
  }

  private createSession(sessionId: SessionId): Session {
    const address = this.addresses.get(sessionId)
    return new Session(sessionId, this.api, {
      ...(address === undefined ? {} : {
        address,
        parentAvailable: this.catalogs.get(address.parentSessionId)?.parentAvailable ?? false,
      }),
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

  /**
   * Refresh one direct-child catalog, reusing its in-flight request.
   * @param parentSessionId - catalog owner.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    const existing = this.catalogInflight.get(parentSessionId)
    if (existing !== undefined) return existing.promise
    const previous = this.catalogs.get(parentSessionId)
    const expandableRows = new Set<SessionId>()
    const activityRows = new Map<SessionId, 'running' | 'inactive'>()
    this.catalogs.set(parentSessionId, {
      entries: previous?.entries ?? [],
      parentAvailable: previous?.parentAvailable ?? false,
      state: 'loading',
      error: null,
    })
    this.notifier.markDirty()
    const operation = (async () => {
      try {
        const { result } = await this.api.subagents.list({ parentSessionId })
        if (result.ok) {
          const parentAvailable = this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
            ?? result.value.parentAvailable
          this.catalogs.set(parentSessionId, {
            ...result.value,
            entries: this.withCatalogMutations(result.value.entries, expandableRows, activityRows),
            parentAvailable,
            state: 'ready',
            error: null,
          })
          for (const [childId, address] of this.addresses) {
            if (address.parentSessionId !== parentSessionId) continue
            this.sessions.get(childId)?.handleSubagentParentAvailable(parentAvailable)
          }
        } else {
          this.catalogs.set(parentSessionId, {
            entries: this.withCatalogMutations(
              previous?.entries ?? [], expandableRows, activityRows,
            ),
            parentAvailable: this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
              ?? previous?.parentAvailable ?? false,
            state: 'error',
            error: result.error,
          })
        }
      } catch (error: unknown) {
        const folded = transportError<never>(error)
        this.catalogs.set(parentSessionId, {
          entries: this.withCatalogMutations(
            previous?.entries ?? [], expandableRows, activityRows,
          ),
          parentAvailable: this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
            ?? previous?.parentAvailable ?? false,
          state: 'error',
          error: folded.ok ? null : folded.error,
        })
      } finally {
        this.catalogInflight.delete(parentSessionId)
        // Re-arm the trailing pull before the dirty notify: the response the
        // caller observed predates the stale-marking change, so the follow-up
        // refresh is the only carrier of that change.
        if (this.catalogStale.delete(parentSessionId)) void this.refreshSubagents(parentSessionId)
        this.notifier.markDirty()
      }
    })()
    this.catalogInflight.set(parentSessionId, {
      promise: operation,
      expandableRows,
      activityRows,
      parentAvailableOverride: undefined,
    })
    return operation
  }

  /**
   * Mark whether a catalog menu is consuming live membership updates.
   * @param parentSessionId - catalog owner.
   * @param open - current menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    if (open) {
      this.openCatalogs.add(parentSessionId)
      void this.refreshSubagents(parentSessionId)
    } else {
      this.openCatalogs.delete(parentSessionId)
      const timer = this.catalogDebounce.get(parentSessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.catalogDebounce.delete(parentSessionId)
      }
    }
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
   * Search visible session message content without adding transient query
   * state to the list snapshot.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for superseded UI queries.
   * @returns the Host result or a folded transport error.
   */
  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    try {
      return (await this.api.sessions.search({ query }, signal)).result
    } catch (error: unknown) {
      return transportError(error)
    }
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
   * Contract session.fork; on success merge the child into summaries
   * immediately (same synchronous-addressability guarantee as create). The
   * child carries the source's history, so it is never blank; lineage rides
   * parentSessionId so the list nests it under its source. A child published
   * before Workspace attachment fails is also reconciled into the list.
   * @param opts - source session and the optional seq anchoring the cut.
   * @returns the fork result (the child session id).
   */
  async fork(
    opts: { sessionId: SessionId; atSeq?: number },
  ): Promise<RpcResult<{ sessionId: SessionId }>> {
    try {
      const source = this.summaries.find(s => s.sessionId === opts.sessionId)
      const { result } = await this.api.sessions.fork({
        sessionId: opts.sessionId,
        ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
      })
      const childId = result.ok
        ? result.value.sessionId
        : workspaceAttachSessionId(result.error)
      if (childId !== undefined) {
        this.recordMutation({ kind: 'upsert', summary: {
          sessionId: childId, updatedAt: Date.now(), running: false, blank: false,
          parentSessionId: opts.sessionId,
          ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
        } })
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
          ...(frame.origin !== undefined ? { origin: frame.origin } : {}),
          ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
        })
        this.sessions.get(frame.sessionId)?.handleBlank(frame.blank)
        if (frame.origin === 'subagent' && frame.parentSessionId !== undefined) {
          this.markCatalogParentExpandable(frame.parentSessionId)
        }
        if (frame.parentSessionId !== undefined
          && (this.selected === frame.parentSessionId || this.openCatalogs.has(frame.parentSessionId))) {
          this.scheduleCatalogRefresh(frame.parentSessionId)
        }
        return
      }
      case 'host/session-removed': {
        const summary = this.summaries.find(candidate => candidate.sessionId === frame.sessionId)
        const durableSubagent = summary?.origin === 'subagent' || this.addresses.has(frame.sessionId)
        this.recordMutation(durableSubagent
          ? { kind: 'status', sessionId: frame.sessionId, running: false }
          : { kind: 'remove', sessionId: frame.sessionId })
        this.updateCatalogActivity(frame.sessionId, false)
        if (durableSubagent) {
          // An Activation detaching is not durable child deletion:
          // keep its lineage and conversation while returning it to idle.
          this.sessions.get(frame.sessionId)?.handleRunning(false)
        } else {
          this.sessions.get(frame.sessionId)?.handleRemoved()
        }
        this.pendingBuffers.delete(frame.sessionId) // a removed session's buffered frames must not replay on a future instantiation
        this.waitingApprovals.delete(frame.sessionId) // a removed session cannot wait on anyone
        if (!durableSubagent) this.projectionStores.delete(frame.sessionId)
        // A pull already in flight was requested before this removal and can
        // carry the pre-removal parentAvailable:true, which would resurrect
        // the writable editor this invalidation just closed. Replay false over
        // that response and queue one trailing refresh so the post-removal
        // host truth converges.
        const inflightCatalog = this.catalogInflight.get(frame.sessionId)
        if (inflightCatalog !== undefined) {
          inflightCatalog.parentAvailableOverride = false
          this.catalogStale.add(frame.sessionId)
        }
        // The removed session can no longer be the delivery owner of its
        // catalog: invalidate availability immediately. Removal schedules no
        // catalog refresh, and without this an addressed child keeps a
        // writable editor against a dead continuation owner until an
        // unrelated refresh (or forever, for a closed menu).
        const ownedCatalog = this.catalogs.get(frame.sessionId)
        if (ownedCatalog !== undefined && ownedCatalog.parentAvailable) {
          this.catalogs.set(frame.sessionId, { ...ownedCatalog, parentAvailable: false })
        }
        for (const [childId, address] of this.addresses) {
          if (address.parentSessionId !== frame.sessionId) continue
          this.sessions.get(childId)?.handleSubagentParentAvailable(false)
        }
        return
      }
      case 'host/session-status': {
        this.recordMutation({ kind: 'status', sessionId: frame.sessionId, running: frame.running })
        this.sessions.get(frame.sessionId)?.handleRunning(frame.running)
        this.updateCatalogActivity(frame.sessionId, frame.running)
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
    const selectedAddress = this.selected === undefined ? undefined : this.addresses.get(this.selected)
    if (selectedAddress !== undefined) void this.refreshSubagents(selectedAddress.parentSessionId)
    if (this.selected !== undefined) void this.refreshSubagents(this.selected)
    for (const parentSessionId of this.openCatalogs) void this.refreshSubagents(parentSessionId)
    for (const session of this.sessions.values()) void session.resync()
  }

  /** Debounce membership refetches while one parent catalog is selected or open. */
  private scheduleCatalogRefresh(parentSessionId: SessionId): void {
    if (this.catalogDebounce.has(parentSessionId)) return
    const timer = setTimeout(() => {
      this.catalogDebounce.delete(parentSessionId)
      // The in-flight response predates the membership frame that scheduled
      // this callback. Queue one post-settlement pull instead of treating an
      // ordinary overlapping read as evidence that catalog membership changed.
      if (this.catalogInflight.has(parentSessionId)) {
        this.catalogStale.add(parentSessionId)
        return
      }
      void this.refreshSubagents(parentSessionId)
    }, 50)
    this.catalogDebounce.set(parentSessionId, timer)
  }

  /** Apply one Agent-driver transition to loaded and in-flight catalogs. */
  private updateCatalogActivity(childSessionId: SessionId, running: boolean): void {
    const activity = running ? 'running' as const : 'inactive' as const
    for (const inflight of this.catalogInflight.values()) {
      inflight.activityRows.set(childSessionId, activity)
    }
    let changed = false
    for (const [parentSessionId, catalog] of this.catalogs) {
      if (!catalog.entries.some(entry =>
        entry.kind === 'child' && entry.id === childSessionId && entry.activity !== activity)) continue
      const entries = catalog.entries.map((entry) => {
        if (entry.kind !== 'child' || entry.id !== childSessionId) return entry
        return { ...entry, activity }
      })
      changed = true
      this.catalogs.set(parentSessionId, { ...catalog, entries })
    }
    if (changed) this.notifier.markDirty()
  }

  /** Preserve and project a positive expandability hint after one direct subagent publishes. */
  private markCatalogParentExpandable(parentSessionId: SessionId): void {
    this.applyCatalogParentExpandable(parentSessionId)
    for (const inflight of this.catalogInflight.values()) inflight.expandableRows.add(parentSessionId)
  }

  /** Apply one positive expandability hint to every loaded catalog containing that unique row id. */
  private applyCatalogParentExpandable(parentSessionId: SessionId): void {
    let changed = false
    for (const [catalogParentId, catalog] of this.catalogs) {
      if (!catalog.entries.some(entry =>
        entry.kind === 'child' && entry.id === parentSessionId && !entry.hasChildren)) continue
      const entries = catalog.entries.map((entry) => {
        if (entry.kind !== 'child' || entry.id !== parentSessionId || entry.hasChildren) return entry
        return { ...entry, hasChildren: true }
      })
      changed = true
      this.catalogs.set(catalogParentId, { ...catalog, entries })
    }
    if (changed) this.notifier.markDirty()
  }

  /** Fold request-local row mutations into one catalog result before publication. */
  private withCatalogMutations(
    entries: SubagentCatalog['entries'],
    expandableRows: ReadonlySet<SessionId>,
    activityRows: ReadonlyMap<SessionId, 'running' | 'inactive'>,
  ): SubagentCatalog['entries'] {
    return entries.map((entry) => {
      if (entry.kind !== 'child') return entry
      const activity = activityRows.get(entry.id)
      if (!expandableRows.has(entry.id) && activity === undefined) return entry
      return {
        ...entry,
        ...expandableRows.has(entry.id) ? { hasChildren: true } : {},
        ...activity === undefined ? {} : { activity },
      }
    })
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // List rows read the generic 'title' projection key (host-computed unit
      // value; the bespoke session/title frame is retired).
      const projectionStore = this.projectionStores.get(summary.sessionId)
      const title = projectionStore?.get('title')
      const projectionValues = projectionStore?.values()
      return {
        ...summary,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(projectionValues === undefined ? {} : { projectionValues }),
      }
    })
    const fresh = flattenLineage(merged, new Set(this.waitingApprovals.keys()))
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.waitingApproval === entry.waitingApproval
        && prev.projectionValues === entry.projectionValues
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
    const current = selected !== undefined
      && (items.some(item => item.sessionId === selected) || this.addresses.has(selected))
      ? selected
      : undefined
    return {
      items: this.itemsCache,
      current,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
      subagentsByParent: Object.fromEntries(this.catalogs),
      currentAddress: current === undefined ? undefined : this.addresses.get(current),
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
        ...(existing.origin === undefined && mutation.summary.origin !== undefined
          ? { origin: mutation.summary.origin } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.origin === existing.origin && filled.blank === existing.blank) return [...summaries]
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
