// Sessions remain resident after creation so they continue consuming mux frames off-screen.

import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  HistoryEntry, IApiClient, InboxItemId, MuxFrame, QueueAction, RpcError,
  RpcId, RpcResult, SessionId, ToolEventView,
} from '@deepseek-ai/dsh-client-connection/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionFace } from '../contract/session.ts'
import type {
  CodeSubCall, ComposerPhase, ConversationNode, ConversationSnapshot, ModelRetryNode,
  OpenState, PromptError, QueuedMessage, RunningToolCall,
} from './conversation.ts'
import type { PendingInteraction } from './pending.ts'
import { PendingWait } from './pending.ts'
import { FoldAdapter } from './fold-adapter.ts'
import { Notifier } from './notifier.ts'
import { PartialAccumulator } from './partial.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

// Browser bundles cannot value-import the host timeout library. This protocol
// bound is pinned to @deepseek-ai/dsh-timeout's MAX_TIMER_DELAY_MS in tests.
const MAX_RETRY_DELAY_MS = 2_147_483_647

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /**
   * First ACCEPTED prompt on a blank session (fires at most once, on the
   * prompt RPC's success response): the manager mirrors the blank→false flip
   * into its list row so the session surfaces without waiting for a host
   * frame. Acceptance is the flip point because it proves the user message
   * is in the host log; a rejected first prompt keeps the session blank
   * (hidden, still reusable by connectWorkspace).
   */
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
}

/** Queue-row preview cap: the dock renders one line, the full content never leaves the host mirror. */
const QUEUE_PREVIEW_CHARS = 200

/** Single-line queue-row preview: text blocks flattened, non-text as tags, capped by code point. */
function queuePreviewOf(content: readonly ContentBlock[]): string {
  const flat = content
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

/** Recover complete composer text only when editing cannot discard non-text blocks. */
function queueTextOf(content: readonly ContentBlock[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are manager/runtime entry points.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read surface) ----
  private events: SessionEvent[] = []
  /** Wire views aligned with `events` by index (envelope-level annotations; undefined = no view).
   *  Kept parallel rather than merged so `events` stays the raw log slice (model-visible ⟺ logged). */
  private views: (ToolEventView | undefined)[] = []
  private baseSeq = 0
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RpcError | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by resync to invalidate an in-flight doOpen: a reconnect must rebuild, never adopt
   *  a pre-disconnect open whose history request is already doomed (audit S4). Stale doOpen
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  private readonly foldAdapter = new FoldAdapter()
  private partial: PartialAccumulator | null = null
  private openCalls = new Map<string, RunningToolCall>()
  /** Operational notices and interrupted-turn terminal nodes merged into the flow by seq.
   *  Derived from window events — rebuilt by rebuildDerivedFromWindow like partial/openCalls. */
  private derivedNodes: ConversationNode[] = []
  private pending = new Map<string, PendingInteraction>()
  // Revision counters preserve array identity when derived content is unchanged, so
  // React.memo children survive unrelated snapshot swaps (chunk storms must not re-render every
  // tool card and pending card). Mutation sites bump the matching revision. partial needs no
  // counter — PartialAccumulator.toPartial already returns a cached reference when unchanged.
  private callsRev = 0
  private callsCache: { rev: number; value: RunningToolCall[] } | null = null
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  private derivedRev = 0
  private nodesCache: { folded: readonly ConversationNode[]; derivedRev: number; value: readonly ConversationNode[] } | null = null
  /** Authoritative stream-only inbox snapshot; pending work never hits history. */
  private queued: QueuedMessage[] = []
  private queueRev = 0
  private queueCache: { rev: number; value: QueuedMessage[] } | null = null
  /** `run_code` sub-dispatches by parent callId (window-derived, like openCalls). Appends
   *  copy-on-write the per-parent array so published snapshot references never mutate. */
  private codeDispatches = new Map<string, readonly CodeSubCall[]>()
  private dispatchesRev = 0
  private dispatchesCache: { rev: number; value: ReadonlyMap<string, readonly CodeSubCall[]> } | null = null
  private running = false
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * synchronously before prompt()'s first await, never reset — the blank →
   * engaging edge of the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** Empty-log mirror (see ConversationSnapshot.blank); monotone false once flipped. */
  private blankBit = false
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Live events buffered during open/resync and stitched by sequence once history lands. */
  private liveBuffer: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null

  /**
   * Per-session projection value store (session-projection RFC, push model):
   * finished whole values computed on the host, seeded by the tail page's
   * projections block and updated by `session/projection` frames under the
   * one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  private snapshotCache: ConversationSnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })
  /**
   * Agent-scoped cordis context, bound once by SessionsService when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param api - shared wire client.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Bind the Agent-scoped context minted by SessionsService (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * the seam: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
   * @param content - core content blocks verbatim.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  async prompt(content: ContentBlock[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Synchronous, before the first await: the blank → engaging edge must be
    // visible on the session area's very first frame when a caller sends
    // ahead of navigation (first-send flow).
    this.promptAttempted = true
    this.notifier.markDirty()
    let result: RpcResult<{ accepted: true }>
    try {
      result = (await this.api.sessions.prompt({ sessionId: this.sessionId, mode, content })).result
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // Blank flips on ACCEPTANCE, not attempt: an accepted prompt starts the
    // conversation's first turn on the host (the host criterion — a logged
    // turn/start — is fact, not optimism; standalone command and projection
    // events never flip it), while a rejected first prompt must keep the
    // session blank — the client-side blank mirror only ever lowers, so
    // flipping early on a failure would surface the session forever and
    // strip its connectWorkspace reuse eligibility against the host's
    // authority.
    if (this.blankBit) {
      this.blankBit = false
      this.options.onEngaged?.(this)
      this.notifier.markDirty()
    }
    return result
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: InboxItemId, action: QueueAction): Promise<RpcResult<{ accepted: true }>> {
    try {
      return (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId, action })).result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Stop: contract session.cancel 1:1; failures land in promptError (same error-strip display slot).
   * @returns the cancel result.
   */
  async cancel(): Promise<RpcResult<{ accepted: true }>> {
    let result: RpcResult<{ accepted: true }>
    try {
      result = (await this.api.sessions.cancel({ sessionId: this.sessionId })).result
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the mux frame.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  async rename(title: string): Promise<RpcResult<{ title: string; seq: number }>> {
    try {
      const { result } = await this.api.sessions.rename({ sessionId: this.sessionId, title })
      if (result.ok) this.projections.apply('title', result.value.title, result.value.seq)
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the error branch on transport failure.
   */
  async command(line: string): Promise<RpcResult<{ matched: boolean }>> {
    try {
      return (await this.api.commands.execute({ sessionId: this.sessionId, line })).result
    } catch (error) {
      return transportError(error)
    }
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend (§D.2). */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    this.loadingOlder = true
    this.notifier.markDirty()
    try {
      const { result } = await this.api.sessions.history({
        sessionId: this.sessionId, beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES,
      })
      if (!result.ok) return // keep the window as-is; do not overwrite openError (open already succeeded)
      const older = result.value.events
      if (older.length === 0) {
        this.hasMore = result.value.hasMore
        return
      }
      const tail = older[older.length - 1]
      if (tail === undefined || tail.event.seq + 1 !== this.baseSeq) {
        // §D.2 continuity assertion: on violation drop the page fail-soft rather than render an out-of-order stream.
        console.error(`[web-runtime] history page discontinuous: tail seq ${tail?.event.seq} vs baseSeq ${this.baseSeq}`)
        this.hasMore = false
        return
      }
      this.events = [...older.map(e => e.event), ...this.events]
      this.views = [...older.map(e => e.view), ...this.views]
      /* v8 ignore next -- the ?? arm needs older[0] undefined, but the empty-page branch above already returned. */
      this.baseSeq = older[0]?.event.seq ?? this.baseSeq
      this.hasMore = result.value.hasMore
      this.foldAdapter.reset(this.events, this.baseSeq, this.views) // prepend forces a rebuild (sentinel count changed)
      this.rebuildDerivedFromWindow()
    } catch (error) {
      console.error('[web-runtime] loadOlder failed:', error)
    } finally {
      this.loadingOlder = false
      this.notifier.markDirty()
    }
  }

  /** Reconnect rebuild (manager calls this on onConnected for instances that were opened):
   *  reset the window and rerun open; pending waits for the baseline replay. Invalidates any
   *  in-flight open first — its history request rode the dead connection and must not settle
   *  the fresh generation into 'error' (audit S4). */
  async resync(): Promise<void> {
    // The queue mirror is NOT cleared here: onConnected (which drives resync)
    // races the mux frames — the fresh generation's baseline may have landed
    // already, and the host never resends it. The mirror re-baselines on the
    // session/subscribed frame instead (same stream as the queue snapshot
    // that follows it, so ordering is guaranteed).
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    this.openGeneration++
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.events = []
    this.views = []
    this.baseSeq = 0
    // Superseded, not settled: the baseline replay re-sends still-pending requested frames verbatim
    // (same rpcId), re-minting fresh waits; a stale reference's respond() still reaches the host.
    this.pending.clear()
    this.pendingRev++
    this.subscribedLastSeq = null
    this.liveBuffer = []
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription surface (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached conversation snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): ConversationSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Mux frame arrival (the dispatch switch).
   * @param rpcId - the frame envelope id (the respond backfill key for requested frames).
   * @param frame - the routed frame.
   */
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/event': {
        this.acceptLiveEvent(frame.event, frame.view)
        return
      }
      case 'session/queue': {
        this.queued = frame.items.map(item => ({
          id: item.id,
          preview: queuePreviewOf(item.message.content),
          text: queueTextOf(item.message.content),
        }))
        this.queueRev++
        this.notifier.markDirty()
        return
      }
      case 'session/subscribed': {
        this.subscribedLastSeq = frame.lastSeq
        // New mux-generation baseline: the host pushes this session's queue
        // snapshot AFTER the subscribed frame on the same stream, so the
        // stale mirror clears here — race-free against onConnected/resync
        // timing (clearing there could wipe a baseline that already landed).
        if (this.queued.length > 0) {
          this.queued = []
          this.queueRev++
          this.notifier.markDirty()
        }
        return
      }
      case 'approval/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('approval', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'approval/resolved': {
        for (const item of this.pending.values()) {
          if (item.kind === 'approval' && item.payload.approvalId === frame.approvalId) this.settle(item)
        }
        this.notifier.markDirty()
        return
      }
      case 'question/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('question', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'question/resolved': {
        const item = this.pending.get(`q:${frame.questionRpcId}`)
        if (item !== undefined) this.settle(item)
        this.notifier.markDirty()
        return
      }
      default:
        return // stream/error never reaches Session (Controller converges it); unknown frames ignored (documented default)
    }
  }

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    // Turn-start conversion: a blank session never runs, so the first
    // running:true proves another端's first message landed (设计稿 2.2).
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Blank-bit relay from the authoritative summary source (list baseline and
   * the session-added frame). Monotone: once any signal (local first send,
   * running flip, an earlier summary) cleared it, a stale true never
   * re-blanks.
   * @param blank - the summary's derived empty-log bit.
   */
  handleBlank(blank: boolean): void {
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** host/session-removed relay: flag the snapshot (instance survives — resident-instance rule). */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * host/agent-error relay: the only outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /** No-op because session instances remain resident. */
  dispose(): void {}

  // ---- 私有 ----

  /** Requested-frame arrival: the wait enters the pending map under its own key. */
  private mint(wait: PendingInteraction): void {
    this.pending.set(wait.key, wait)
    this.pendingRev++
  }

  /** Authoritative resolved-frame settlement: mark, then drop from the pending map. */
  private settle(wait: PendingInteraction): void {
    wait.markSettled()
    this.pending.delete(wait.key)
    this.pendingRev++
  }

  /** @param generation - openGeneration at launch; every await re-checks it and a stale pass
   *  drops all writes (resync superseded this open — its outcome belongs to a dead connection). */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    try {
      let { result } = await this.api.sessions.history({ sessionId: this.sessionId, maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration) return
      if (!result.ok) {
        this.openState = 'error'
        this.openError = result.error
        return
      }
      this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      // Gap detection (§D.3-4): baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
      const tailSeq = this.windowTailSeq()
      if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
        result = (await this.api.sessions.history({ sessionId: this.sessionId, maxMessages: PAGE_MESSAGES })).result
        if (generation !== this.openGeneration) return
        if (result.ok) this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      }
      this.openState = 'open'
    } catch (error) {
      if (generation !== this.openGeneration) return
      this.openState = 'error'
      const folded = transportError<never>(error)
      /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
      this.openError = folded.ok ? null : folded.error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Install the history window + stitch the liveBuffer (seq is the sole dedup key).
   *  Stitching MUST NOT route through acceptLiveEvent: openState is still 'loading' here
   *  (doOpen flips it after install), so recursing would push every buffered event straight
   *  back into liveBuffer where nothing ever drains it — a silent drop loop (audit S1).
   *  A carried projections block seeds the value store (higher seq wins, so a stale
   *  baseline cannot overwrite a newer push frame); the window events themselves are
   *  never folded — the host is the only computation site. */
  private installWindow(entries: HistoryEntry[], hasMore: boolean, projections?: ProjectionsBaseline): void {
    this.events = entries.map(e => e.event)
    this.views = entries.map(e => e.view)
    this.baseSeq = this.events[0]?.seq ?? 0
    this.hasMore = hasMore
    this.foldAdapter.reset(this.events, this.baseSeq, this.views)
    this.rebuildDerivedFromWindow()
    if (projections !== undefined) this.projections.seed(projections)
    const buffered = this.liveBuffer
    this.liveBuffer = []
    for (const item of buffered) this.appendLive(item.event, item.view)
    this.notifier.markDirty()
  }

  /** Seq-guarded append shared by stitching and the open-state live path. */
  private appendLive(event: SessionEvent, view?: ToolEventView): void {
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq <= tailSeq) return // replay overlap, drop
    this.events.push(event)
    this.views.push(view)
    this.foldAdapter.append(event, view)
    this.applyEventSideEffects(event, view)
  }

  /** Land a live session/event (open/repair in flight -> buffer; overlapping seq -> drop;
   *  a seq gap -> buffer + tail-page repull instead of appending a hole (audit S3: a gap is an
   *  expected reconnect-window artifact, repaired by refetch — never fed to the fold to trip
   *  its continuity assertion into the degraded view). */
  private acceptLiveEvent(event: SessionEvent, view?: ToolEventView): void {
    if (this.openState === 'loading' || this.stitching) {
      this.liveBuffer.push({ event, view })
      return
    }
    if (this.openState !== 'open') return // cold/error: no window upkeep (history fully backfills on open)
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq > tailSeq + 1) {
      this.liveBuffer.push({ event, view })
      void this.repairGap()
      return
    }
    this.appendLive(event, view)
    this.notifier.markDirty()
  }

  /** Resync-lite (audit S3): repull the tail page and stitch the liveBuffer through the shared
   *  installWindow path. No openState transition — the UI keeps the current window (no loading
   *  flash); events arriving meanwhile detour to liveBuffer via the stitching flag. */
  private async repairGap(): Promise<void> {
    /* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */
    if (this.stitching) return
    this.stitching = true
    const generation = this.openGeneration
    try {
      const { result } = await this.api.sessions.history({ sessionId: this.sessionId, maxMessages: PAGE_MESSAGES })
      // Failure or superseded by a full resync: drop — the resync path rebuilds and clears the buffer itself.
      if (result.ok && generation === this.openGeneration && this.openState === 'open') {
        this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      }
    } catch (error) {
      console.error('[web-runtime] gap repair failed:', error)
    } finally {
      this.stitching = false
    }
  }

  /** Per-event side effects (right column of the §A.9 dispatch table):
   *  chunk/retry projection and openCalls add-remove. */
  private applyEventSideEffects(event: SessionEvent, view?: ToolEventView): void {
    const eventType = event.type as string
    if (eventType === 'llm/retry') {
      const data = parseRetryEventData(event.data)
      if (data === null) {
        console.error(`[web-runtime] ignored malformed llm/retry event at seq ${event.seq}`)
        return
      }
      if (this.partial !== null && this.partial.turn === data.turn && this.partial.step === data.step) {
        this.partial = null
      }
      this.derivedNodes.push({
        kind: 'model-retry',
        seq: event.seq,
        time: event.time,
        retryState: 'scheduled',
        ...data,
      })
      this.derivedRev++
      return
    }
    // The `tool/code-dispatch-start`/`tool/code-dispatch` pair is declared by
    // the host-side dsh-tools plugin whose types cannot enter the client
    // program (its host Context merges collide with the client's), so this
    // wire consumer narrows them structurally — the same posture as every
    // other cross-wire event payload.
    if ((event.type as string) === 'tool/code-dispatch-start') {
      // A started sub-dispatch enters the index as a RunningToolCall — the
      // exact shape a native in-flight call renders from — under its parent
      // run_code callId; it never joins the surface flow.
      const data = event.data as unknown as {
        parentCallId: string
        subCallId: string
        name: string
        arguments: unknown
      }
      const running: CodeSubCall = {
        callId: data.subCallId, name: data.name,
        argsRaw: JSON.stringify(data.arguments),
        turn: 0, step: 0, time: event.time, callView: null,
      }
      const siblings = this.codeDispatches.get(data.parentCallId) ?? []
      this.codeDispatches.set(data.parentCallId, [...siblings, running])
      this.dispatchesRev++
      return
    }
    if ((event.type as string) === 'tool/code-dispatch') {
      // Settlement replaces the running entry in place (same array position,
      // so parallel sub-calls keep their start order) with the
      // ToolResultNode form; a settle with no observed start (history window
      // cut mid-pair, or a pre-start-event log) appends directly.
      const data = event.data as unknown as {
        parentCallId: string
        subCallId: string
        name: string
        arguments: unknown
        isError: boolean
        content: ContentBlock[]
      }
      const siblings = this.codeDispatches.get(data.parentCallId) ?? []
      const at = siblings.findIndex(sub => sub.callId === data.subCallId)
      const started = at === -1 ? undefined : siblings[at]
      const settled: CodeSubCall = {
        kind: 'tool-result', seq: event.seq, time: event.time,
        callId: data.subCallId,
        call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
        // Duration source: the paired start's time when observed; null =
        // unknown (settle-only window), matching the native tool-result
        // contract so views never present a fabricated zero duration.
        callTime: started === undefined ? null : started.time,
        content: data.content, isError: data.isError,
        callView: null, resultView: null,
      }
      this.codeDispatches.set(
        data.parentCallId,
        at === -1 ? [...siblings, settled] : siblings.map((sub, index) => (index === at ? settled : sub)),
      )
      this.dispatchesRev++
      return
    }
    switch (event.type) {
      case 'turn/start': {
        if (event.data.trigger.kind === 'retry') this.settleScheduledRetry('started')
        return
      }
      case 'assistant/chunk': {
        const { turn, step, chunk } = event.data
        if (this.partial === null || this.partial.turn !== turn || this.partial.step !== step) {
          this.partial = new PartialAccumulator(turn, step)
        }
        this.partial.push(chunk)
        return
      }
      case 'assistant/message': {
        if (this.partial !== null && this.partial.turn === event.data.turn && this.partial.step === event.data.step) {
          this.partial = null // finalize swaps in place (same notification batch, no flicker)
        }
        return
      }
      case 'tool/call': {
        this.openCalls.set(String(event.data.callId), {
          callId: String(event.data.callId), name: event.data.name, argsRaw: event.data.arguments,
          turn: event.data.turn, step: event.data.step, time: event.time,
          callView: view?.for === 'call' ? view.view : null,
        })
        this.callsRev++
        return
      }
      case 'tool/result': {
        if (this.openCalls.delete(String(event.data.message.source.callId))) this.callsRev++
        return
      }
      case 'turn/end': {
        if (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'disposed') {
          this.settleScheduledRetry('cancelled', event.data.turn)
        }
        // Aborted turns never finalize. The accumulated partial is VALUE, not residue: freeze it
        // into an interrupted terminal node (pulse stops, text survives) instead of deleting it.
        // Shared by live and window-replay paths, so a refresh reconstructs the same frozen node
        // from the logged chunks. Content-free partials are dropped outright.
        if (this.partial !== null && this.partial.turn === event.data.turn) {
          const { blocks } = this.partial.toPartial()
          const visible = blocks.some(b => (b.kind === 'text' || b.kind === 'reasoning' ? b.text !== '' : true))
          if (visible) {
            // Fractional seq: strictly after every event of this turn (all < turn/end seq), before the next turn.
            this.derivedNodes.push({
              kind: 'assistant', seq: event.seq - 0.9, time: event.time,
              turn: this.partial.turn, step: this.partial.step,
              blocks, interrupted: true,
            })
            this.derivedRev++
          }
          this.partial = null
        }
        let callOffset = 0
        for (const [callId, call] of this.openCalls) {
          if (call.turn !== event.data.turn) continue
          this.openCalls.delete(callId)
          this.callsRev++
          // The spinner card becomes an interrupted terminal card (never vanishes mid-flow).
          this.derivedNodes.push({
            kind: 'tool-result', seq: event.seq - 0.8 + callOffset++ * 0.01, time: event.time,
            callId,
            call: { name: call.name, argsRaw: call.argsRaw },
            callTime: call.time,
            content: [], isError: true, error: { name: 'Interrupted', code: 'interrupted' },
            callView: call.callView, resultView: null,
          })
          this.derivedRev++
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Settle the newest scheduled retry, optionally restricted to its failed turn.
   * @param retryState - next client projection state to publish.
   * @param turn - failed turn required for cancellation; omitted for the next retry turn start.
   */
  private settleScheduledRetry(
    retryState: Exclude<ModelRetryNode['retryState'], 'scheduled'>,
    turn?: number,
  ): void {
    const index = this.derivedNodes.findLastIndex(node =>
      node.kind === 'model-retry'
      && node.retryState === 'scheduled'
      && (turn === undefined || node.turn === turn))
    if (index < 0) return
    const node = this.derivedNodes[index]
    /* v8 ignore next -- findLastIndex's predicate narrows the indexed node only at runtime. */
    if (node?.kind !== 'model-retry') return
    this.derivedNodes[index] = { ...node, retryState }
    this.derivedRev++
  }

  /** Re-derive state (partial/openCalls/derivedNodes) from raw window events after a rebuild — keeps
   *  paging/stitching consistent, and makes live handling and history replay converge on the same
   *  retry notices and interrupted nodes. */
  private rebuildDerivedFromWindow(): void {
    this.partial = null
    this.openCalls.clear()
    this.callsRev++
    this.derivedNodes = []
    this.derivedRev++
    this.codeDispatches = new Map()
    this.dispatchesRev++
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i]
      /* v8 ignore next -- dense-array guard: i stays within events.length, so the undefined arm needs a sparse array no caller builds. */
      if (event !== undefined) this.applyEventSideEffects(event, this.views[i])
    }
  }

  private windowTailSeq(): number | null {
    const tail = this.events[this.events.length - 1]
    return tail === undefined ? null : tail.seq
  }

  private buildSnapshot(): ConversationSnapshot {
    const { nodes: folded, degraded } = this.foldAdapter.nodes()
    // Derived nodes use their event seq or a nearby fractional seq: a stable merge keeps flow order.
    // The merged array is cached on (folded reference, derivedRev) so an unchanged flow keeps its
    // reference across snapshot swaps (§A.9.4).
    let nodes: readonly ConversationNode[]
    if (this.nodesCache !== null && this.nodesCache.folded === folded && this.nodesCache.derivedRev === this.derivedRev) {
      nodes = this.nodesCache.value
    } else {
      nodes = this.derivedNodes.length === 0
        ? folded
        : [...folded, ...this.derivedNodes].sort((a, b) => a.seq - b.seq)
      this.nodesCache = { folded, derivedRev: this.derivedRev, value: nodes }
    }
    if (this.callsCache === null || this.callsCache.rev !== this.callsRev) {
      this.callsCache = { rev: this.callsRev, value: [...this.openCalls.values()] }
    }
    if (this.pendingCache === null || this.pendingCache.rev !== this.pendingRev) {
      this.pendingCache = { rev: this.pendingRev, value: [...this.pending.values()] }
    }
    if (this.dispatchesCache === null || this.dispatchesCache.rev !== this.dispatchesRev) {
      this.dispatchesCache = { rev: this.dispatchesRev, value: new Map(this.codeDispatches) }
    }
    if (this.queueCache === null || this.queueCache.rev !== this.queueRev) {
      this.queueCache = { rev: this.queueRev, value: this.queued }
    }
    const partial = this.partial?.toPartial() ?? null
    return {
      sessionId: this.sessionId,
      nodes,
      foldDegraded: degraded,
      partial,
      runningCalls: this.callsCache.value,
      pending: this.pendingCache.value,
      codeDispatches: this.dispatchesCache.value,
      queue: this.queueCache.value,
      running: this.running,
      composerPhase: derivePhase(
        // Command lifecycle nodes are not conversation: running /permission
        // or /plan on a fresh session keeps the hero (the client mirror of
        // the host's no-turn sessionBlank predicate).
        nodes.some(node => node.kind !== 'command') || partial !== null || this.running || this.pendingCache.value.length > 0,
        this.promptAttempted,
      ),
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
    }
  }
}

/** Validate the plugin-owned payload at the session-event wire boundary. */
function parseRetryEventData(value: unknown): LlmRetryEventData | null {
  if (value === null || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  const failure = data.failure
  if (failure === null || typeof failure !== 'object') return null
  const failureData = failure as Record<string, unknown>
  if (!nonNegativeSafeInteger(data.turn)
    || !nonNegativeSafeInteger(data.step)
    || typeof data.provider !== 'string'
    || data.provider.length === 0
    || typeof data.policyKey !== 'string'
    || data.policyKey.length === 0
    || !positiveSafeInteger(data.retry)
    || typeof data.delayMs !== 'number'
    || !Number.isFinite(data.delayMs)
    || data.delayMs < 0
    || data.delayMs > MAX_RETRY_DELAY_MS
    || typeof failureData.message !== 'string'
    || failureData.message.length === 0
    || typeof failureData.code !== 'string'
    || failureData.code.length === 0) return null
  if (data.mode === 'normal') {
    if (!positiveSafeInteger(data.maxRetries) || data.retry > data.maxRetries) return null
  } else if (data.mode === 'always') {
    if ('maxRetries' in data) return null
  } else {
    return null
  }
  if (failureData.status !== undefined
    && (typeof failureData.status !== 'number'
      || !Number.isInteger(failureData.status)
      || failureData.status < 100
      || failureData.status > 599)) return null
  if (failureData.providerRetryAfterMs !== undefined
    && (typeof failureData.providerRetryAfterMs !== 'number'
      || !Number.isFinite(failureData.providerRetryAfterMs)
      || failureData.providerRetryAfterMs <= 0)) return null
  if (failureData.requestId !== undefined
    && (typeof failureData.requestId !== 'string'
      || failureData.requestId.length === 0)) return null
  return data as unknown as LlmRetryEventData
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0
}

/**
 * The composerPhase judgment — the single site that knows the predicate
 * (consumers switch on the result, never re-derive). Monotone per session
 * object: `hasContent` only grows within a window and `promptAttempted` is
 * sticky, so blank → engaging → active never steps back; a failed first
 * prompt stays engaging (retry semantics — see ComposerPhase).
 * @param hasContent - any conversation material exists (non-command nodes,
 *   partial, running turn, pending waits; command lifecycle rows alone keep
 *   the session blank).
 * @param promptAttempted - a prompt was initiated on this session object.
 * @returns the derived phase.
 */
function derivePhase(hasContent: boolean, promptAttempted: boolean): ComposerPhase {
  if (hasContent) return 'active'
  return promptAttempted ? 'engaging' : 'blank'
}
