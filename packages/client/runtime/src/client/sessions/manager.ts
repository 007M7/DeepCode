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
import { Notifier } from './notifier.ts'
import { Session } from './session.ts'
import type { SessionIntentSnapshot, SessionIntentTarget } from './conversation.ts'

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** Session-owned frontend Intent projected into the global list snapshot. */
export interface SessionIntentListSnapshot extends SessionIntentSnapshot {
  sessionId: SessionId
  prompt: string
}

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  /** Selected real or frontend-only Session id. */
  current: SessionId | undefined
  /** Sole page-local frontend Session projection; its state remains owned by Session. */
  intent: SessionIntentListSnapshot | undefined
  state: 'idle' | 'loading' | 'error'
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  error: RpcError | null
}

type SessionListMutation =
  | { kind: 'upsert'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean }

/** Per-session cap for pre-instantiation approval/question buffering (low-frequency frames; a few dozen covers any real backlog). */
const PENDING_BUFFER_CAP = 32

/** Latest title control snapshot retained independently of list/instance arrival. */
interface SessionTitleSnapshot {
  title: string
  eventSeq: number
  updatedAt: number
}

/** Instance cluster + frame entry + the session list (see the web client architecture RFC). */
export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  /** Approval/question frame buffer for uninstantiated sessions: pending interactions never hit
   *  history (cannot be backfilled on open), the one frame class that must not take the
   *  drop-and-backfill path; replayed and cleared on instantiation. Bounded per session (these
   *  frames are low-frequency; overflow drops oldest) and dropped on session-removed (audit S7). */
  private readonly pendingBuffers = new Map<SessionId, RpcRequest<MuxFrame>[]>()
  private readonly titleSnapshots = new Map<SessionId, SessionTitleSnapshot>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
  private listPhase: SessionListPhase = 'pending'
  private listError: RpcError | null = null
  private listInflight: Promise<void> | null = null
  /** Mutations arriving after a list request starts are replayed over its response. */
  private listMutations: SessionListMutation[] | null = null

  private selected: SessionId | undefined
  private intentSessionId: SessionId | undefined
  private stopIntentWatch: (() => void) | undefined

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

  // ---- Selection and client-local intents ----

  /**
   * Select a real Session and discard the unmaterialized intent.
   * @param sessionId - listed real Session id.
   */
  select(sessionId: SessionId): void {
    if (!this.summaries.some(summary => summary.sessionId === sessionId)) {
      throw new Error(`sessions.select: unknown session ${sessionId}`)
    }
    this.discardIntent()
    this.selected = sessionId
    this.notifier.notifyNow()
  }

  /** Clear selection and abandon any frontend-only Session. */
  clearSelection(): void {
    this.discardIntent()
    this.selected = undefined
    this.notifier.notifyNow()
  }

  /**
   * Start a frontend Session against a real or still-local Workspace target.
   * @param target - real Workspace or the WorkspacesService-owned local target.
   * @param prompt - optional prompt retained when retargeting from a picker.
   * @returns the frontend Session object that owns the Intent.
   */
  startIntent(target: SessionIntentTarget, prompt = ''): Session {
    this.discardIntent()
    const sessionId = `client-session-${crypto.randomUUID()}` as SessionId
    const session = this.createSession(sessionId, { target, prompt })
    this.sessions.set(sessionId, session)
    this.intentSessionId = sessionId
    this.selected = sessionId
    this.stopIntentWatch = session.subscribe(() => {
      if (this.intentSessionId !== sessionId) return
      if (session.getSnapshot().intent === null) {
        this.intentSessionId = undefined
        this.stopIntentWatch?.()
        this.stopIntentWatch = undefined
      }
      this.notifier.markDirty()
    })
    this.notifier.notifyNow()
    return session
  }

  /**
   * Resolve the active frontend Session Intent.
   * @returns the active frontend Session, if one remains selected.
   */
  getIntent(): Session | undefined {
    return this.intentSessionId === undefined ? undefined : this.sessions.get(this.intentSessionId)
  }

  /**
   * Update the retained prompt of the active frontend Session.
   * @param text - exact controlled-input value for the active frontend Session.
   */
  updateIntent(text: string): void {
    this.getIntent()?.updatePendingPrompt(text)
  }

  private discardIntent(): void {
    const session = this.getIntent()
    this.intentSessionId = undefined
    this.stopIntentWatch?.()
    this.stopIntentWatch = undefined
    session?.abandonIntent()
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
      session = this.createSession(sessionId)
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

  private createSession(
    sessionId: SessionId,
    intent?: { target: SessionIntentTarget; prompt: string },
  ): Session {
    return new Session(sessionId, this.api, {
      ...(intent === undefined ? {} : { intent }),
      onPublished: (published) => {
        this.sessions.set(published.sessionId, published)
        this.recordMutation({
          kind: 'upsert',
          summary: { sessionId: published.sessionId, updatedAt: Date.now(), running: false },
        })
      },
    })
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
        this.listMutations = null
        this.listInflight = null
        this.notifier.markDirty()
      }
    })()
    return this.listInflight
  }

  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh).
   * @param opts - target workspace or working directory, plus an optional caller-owned id.
   * @returns the create result.
   */
  async create(
    opts: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId } = {},
  ): Promise<RpcResult<{ sessionId: SessionId }>> {
    try {
      const payload = opts.workspaceId !== undefined
        ? { workspaceId: opts.workspaceId, ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }) }
        : {
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
        }
      const { result } = await this.api.sessions.create(payload)
      if (result.ok) {
        this.recordMutation({ kind: 'upsert', summary: {
          sessionId: result.value.sessionId, updatedAt: Date.now(), running: false,
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
    if (frame.type === 'session/title') {
      const current = this.titleSnapshots.get(frame.sessionId)
      if (current !== undefined && current.eventSeq >= frame.eventSeq) return
      this.titleSnapshots.set(frame.sessionId, {
        title: frame.title,
        eventSeq: frame.eventSeq,
        updatedAt: frame.updatedAt,
      })
      this.notifier.markDirty()
      return
    }
    if (frame.type === 'session/subscribed') {
      const current = this.titleSnapshots.get(frame.sessionId)
      if (current !== undefined && current.eventSeq > frame.lastSeq) {
        this.titleSnapshots.delete(frame.sessionId)
        this.notifier.markDirty()
      }
    }
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
        this.mergeSummary({
          sessionId: frame.sessionId, updatedAt: Date.now(), running: false,
          ...(frame.parentSessionId !== undefined ? { parentSessionId: frame.parentSessionId } : {}),
          ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
        })
        this.sessions.get(frame.sessionId)?.handlePublished()
        return
      }
      case 'host/session-removed': {
        this.recordMutation({ kind: 'remove', sessionId: frame.sessionId })
        this.sessions.get(frame.sessionId)?.handleRemoved() // instance survives (resident-instance rule), only flagged in the snapshot
        this.pendingBuffers.delete(frame.sessionId) // a removed session's buffered frames must not replay on a future instantiation
        this.titleSnapshots.delete(frame.sessionId)
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

  /** After each connection generation: refresh the session baseline and rebuild opened windows. */
  handleConnected(): void {
    void this.refreshList()
    for (const session of this.sessions.values()) void session.resync()
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      const title = this.titleSnapshots.get(summary.sessionId)
      return title === undefined
        ? summary
        : { ...summary, title: title.title, updatedAt: Math.max(summary.updatedAt, title.updatedAt) }
    })
    const fresh = flattenLineage(merged)
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.title === entry.title && prev.depth === entry.depth
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    for (const id of this.entryCache.keys()) {
      if (!items.some(e => e.sessionId === id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    const intentSession = this.getIntent()
    const intentState = intentSession?.getSnapshot()
    const intent = intentSession !== undefined
      && intentState !== undefined && intentState.intent !== null && intentState.pendingPrompt !== null
      ? {
        sessionId: intentSession.sessionId,
        ...intentState.intent,
        prompt: intentState.pendingPrompt.text,
      }
      : undefined
    const selected = this.selected
    const current = selected !== undefined && (
      intent?.sessionId === selected || items.some(item => item.sessionId === selected)
    ) ? selected : undefined
    return {
      items: this.itemsCache,
      current,
      intent,
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
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId) return [...summaries]
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove':
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    case 'status':
      return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.running !== mutation.running
        ? { ...summary, running: mutation.running }
        : summary)
  }
}

/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error: RpcError): SessionId | undefined {
  const candidate = error as unknown as { code: string; details: { sessionId?: SessionId } }
  return candidate.code === 'workspace-attach-failed' ? candidate.details.sessionId : undefined
}
