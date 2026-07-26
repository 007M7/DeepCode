// Sessions remain resident after creation so they continue consuming mux frames off-screen.

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  HistoryEntry, IApiClient, MuxFrame, RpcError, RpcId, RpcResult,
  SessionId, ToolEventView, WorkspaceId,
} from '@deepseek-ai/dsh-client-connection/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ObservableSnapshot } from '../contract/store.ts'
import type {
  CodeSubCall, ComposerPhase, ConversationNode, ConversationSnapshot, OpenState, PendingPrompt,
  PromptError, RunningToolCall, SessionIntentSnapshot, SessionIntentTarget,
} from './conversation.ts'
import type { PendingInteraction } from './pending.ts'
import { PendingWait } from './pending.ts'
import { FoldAdapter } from './fold-adapter.ts'
import { Notifier } from './notifier.ts'
import { PartialAccumulator } from './partial.ts'

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Optional frontend Intent and publication observer for a Session object. */
export interface SessionOptions {
  intent?: { target: SessionIntentTarget; prompt: string }
  onPublished?(session: Session): void
}

/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer.
 */
export class Session implements ObservableSnapshot<ConversationSnapshot> {
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
  /** Interrupted-turn terminal nodes (frozen partial text / aborted tool cards), merged into the flow by seq.
   *  Derived from window events (turn/end sweep) — rebuilt by rebuildDerivedFromWindow like partial/openCalls. */
  private frozenNodes: ConversationNode[] = []
  private pending = new Map<string, PendingInteraction>()
  // Revision counters preserve array identity when derived content is unchanged, so
  // React.memo children survive unrelated snapshot swaps (chunk storms must not re-render every
  // tool card and pending card). Mutation sites bump the matching revision. partial needs no
  // counter — PartialAccumulator.toPartial already returns a cached reference when unchanged.
  private callsRev = 0
  private callsCache: { rev: number; value: RunningToolCall[] } | null = null
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  private frozenRev = 0
  private nodesCache: { folded: readonly ConversationNode[]; frozenRev: number; value: readonly ConversationNode[] } | null = null
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
  private removed = false
  private promptError: PromptError | null = null
  private intent: SessionIntentSnapshot | null
  private pendingPrompt: PendingPrompt | null
  private intentGeneration = 0
  private published: boolean
  private lastAgentError: string | null = null
  /** Live events buffered during open/resync and stitched by sequence once history lands. */
  private liveBuffer: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null

  private snapshotCache: ConversationSnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  /**
   * @param sessionId - stable identity shared by the frontend Intent and Host entity.
   * @param api - shared wire client.
   * @param options - optional frontend-only initial state and publication observer.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
    private readonly options: SessionOptions = {},
  ) {
    this.intent = options.intent === undefined
      ? null
      : { target: options.intent.target, phase: 'ready' }
    this.pendingPrompt = options.intent === undefined
      ? null
      : { text: options.intent.prompt, phase: 'editing', retry: 'send' }
    this.published = options.intent === undefined
    this.snapshotCache = this.buildSnapshot()
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
    }
    return result
  }

  /**
   * Update this Session's retained prompt while it remains editable.
   * @param text - exact controlled value of this Session's retained prompt.
   */
  updatePendingPrompt(text: string): void {
    const pending = this.pendingPrompt
    if (pending === null || pending.phase === 'sending') return
    this.pendingPrompt = { ...pending, text }
    this.notifier.notifyNow()
  }

  /**
   * Connect this frontend Session to a real Workspace and flush its retained prompt.
   * @param workspaceId - real Workspace target.
   */
  connect(workspaceId: WorkspaceId): void {
    const intent = this.intent
    const pending = this.pendingPrompt
    if (intent === null || intent.phase === 'connecting' || pending === null || pending.text.trim() === '') return
    const connecting: SessionIntentSnapshot = {
      target: { kind: 'workspace', workspaceId },
      phase: 'connecting',
    }
    const queued: PendingPrompt = {
      ...pending,
      phase: 'sending',
      retry: 'connect',
      workspaceId,
    }
    delete queued.error
    this.intent = connecting
    this.pendingPrompt = queued
    this.notifier.notifyNow()
    void this.flushPendingPrompt()
  }

  /** Stop a superseded frontend Intent from automatically sending after publication. */
  abandonIntent(): void {
    if (this.intent === null) return
    this.intentGeneration += 1
  }

  /** Retry this Session's retained prompt from its failed prerequisite. */
  retryPendingPrompt(): void {
    const pending = this.pendingPrompt
    if (pending === null || pending.phase === 'sending' || pending.text.trim() === '') return
    const sending: PendingPrompt = { ...pending, phase: 'sending' }
    delete sending.error
    this.pendingPrompt = sending
    this.promptError = null
    this.notifier.markDirty()
    void this.flushPendingPrompt()
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
      case 'session/subscribed': {
        this.subscribedLastSeq = frame.lastSeq
        return // pure baseline bookkeeping, no visible change
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
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /** Mark that Host publication is known without resolving an uncertain local create response. */
  handlePublished(): void {
    this.markPublished()
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

  /** Advance the retained prompt through Session attachment and submission. */
  private async flushPendingPrompt(): Promise<void> {
    const pending = this.pendingPrompt
    if (pending?.phase === 'sending') {
      const ready = pending.retry === 'connect'
        ? await this.attachPendingPrompt(pending)
        : pending
      if (ready !== null) await this.sendPendingPrompt(ready)
    }
  }

  /** Complete the Host Session prerequisite and return the prompt's send step. */
  private async attachPendingPrompt(pending: PendingPrompt): Promise<PendingPrompt | null> {
    const workspaceId = pending.workspaceId
    if (workspaceId === undefined) throw new Error('a Session attachment requires a Workspace id')
    const originIntent = this.intent
    const originGeneration = this.intentGeneration
    let result: RpcResult<{ sessionId: SessionId }>
    try {
      result = (await this.api.sessions.create({ sessionId: this.sessionId, workspaceId })).result
    } catch (error) {
      result = transportError(error)
    }
    let ready: PendingPrompt | null = null
    if (result.ok) {
      ready = this.completePendingAttachment(pending, originIntent, originGeneration)
    } else {
      this.failPendingAttachment(pending, originIntent, originGeneration, result.error)
    }
    this.notifier.markDirty()
    return ready
  }

  /** Move a published Session to the send step unless its page intent was superseded. */
  private completePendingAttachment(
    pending: PendingPrompt,
    originIntent: SessionIntentSnapshot | null,
    originGeneration: number,
  ): PendingPrompt | null {
    this.markPublished()
    this.intent = null
    this.promptAttempted = true
    const superseded = originIntent !== null && originGeneration !== this.intentGeneration
    const next: PendingPrompt = {
      ...pending,
      phase: superseded ? 'failed' : 'sending',
      retry: 'send',
      ...(superseded ? { error: 'Message was not sent because you navigated away.' } : {}),
    }
    if (!superseded) delete next.error
    this.pendingPrompt = next
    return superseded ? null : next
  }

  /** Retain the prompt at the failed attachment step that owns the retry. */
  private failPendingAttachment(
    pending: PendingPrompt,
    originIntent: SessionIntentSnapshot | null,
    originGeneration: number,
    error: RpcError,
  ): void {
    const partiallyPublished = error.code === 'workspace-attach-failed'
    if (partiallyPublished) {
      this.markPublished()
      this.intent = null
      this.promptAttempted = true
    }
    const activeIntent = !partiallyPublished
      && originIntent !== null
      && originGeneration === this.intentGeneration
      && this.intent === originIntent
    if (activeIntent) {
      this.intent = {
        target: originIntent.target,
        phase: 'ready',
        error: { step: 'session', message: rpcErrorMessage(error) },
      }
      this.pendingPrompt = { ...pending, phase: 'editing' }
    }
    if (!activeIntent && (partiallyPublished || originIntent === null) && this.pendingPrompt === pending) {
      this.pendingPrompt = { ...pending, phase: 'failed', error: rpcErrorMessage(error) }
    }
  }

  /** Submit the retained prompt and keep it only when Host rejects the send. */
  private async sendPendingPrompt(pending: PendingPrompt): Promise<void> {
    const result = await this.prompt([{ type: 'text', text: pending.text.trim() }], 'queue')
    if (this.pendingPrompt === pending) {
      this.pendingPrompt = result.ok
        ? null
        : {
          ...pending,
          retry: 'send',
          phase: 'failed',
          error: rpcErrorMessage(result.error),
        }
      this.notifier.markDirty()
    }
  }

  private markPublished(): void {
    if (this.published) return
    this.published = true
    this.options.onPublished?.(this)
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
      this.installWindow(result.value.events, result.value.hasMore)
      // Gap detection (§D.3-4): baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
      const tailSeq = this.windowTailSeq()
      if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
        result = (await this.api.sessions.history({ sessionId: this.sessionId, maxMessages: PAGE_MESSAGES })).result
        if (generation !== this.openGeneration) return
        if (result.ok) this.installWindow(result.value.events, result.value.hasMore)
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
   *  back into liveBuffer where nothing ever drains it — a silent drop loop (audit S1). */
  private installWindow(entries: HistoryEntry[], hasMore: boolean): void {
    this.events = entries.map(e => e.event)
    this.views = entries.map(e => e.view)
    this.baseSeq = this.events[0]?.seq ?? 0
    this.hasMore = hasMore
    this.foldAdapter.reset(this.events, this.baseSeq, this.views)
    this.rebuildDerivedFromWindow()
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
        this.installWindow(result.value.events, result.value.hasMore)
      }
    } catch (error) {
      console.error('[web-runtime] gap repair failed:', error)
    } finally {
      this.stitching = false
    }
  }

  /** Per-event side effects (right column of the §A.9 dispatch table):
   *  chunk accumulation / partial clear on finalize / openCalls add-remove. */
  private applyEventSideEffects(event: SessionEvent, view?: ToolEventView): void {
    // `tool/code-dispatch` is declared by the host-side dsh-tools plugin whose
    // types cannot enter the client program (its host Context merges collide
    // with the client's), so this wire consumer narrows it structurally —
    // the same posture as every other cross-wire event payload.
    if ((event.type as string) === 'tool/code-dispatch') {
      // A sub-dispatch becomes a ToolResultNode so rows and the details
      // panel reuse the native rendering path verbatim; it indexes under its
      // parent run_code callId and never joins the surface flow.
      const data = event.data as unknown as {
        parentCallId: string
        subCallId: string
        name: string
        arguments: unknown
        isError: boolean
        content: ContentBlock[]
      }
      const parent = data.parentCallId
      const siblings = this.codeDispatches.get(parent) ?? []
      const sub: CodeSubCall = {
        kind: 'tool-result', seq: event.seq, time: event.time,
        callId: data.subCallId,
        call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
        // The settle event is the only timestamp this event carries; the
        // start time is unknown (null per the ToolResultNode contract), so
        // duration-aware consumers never see a fabricated zero-duration call.
        callTime: null,
        content: data.content, isError: data.isError,
        callView: null, resultView: null,
      }
      this.codeDispatches.set(parent, [...siblings, sub])
      this.dispatchesRev++
      return
    }
    switch (event.type) {
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
        if (this.openCalls.delete(String(event.data.callId))) this.callsRev++
        return
      }
      case 'turn/end': {
        // Aborted turns never finalize. The accumulated partial is VALUE, not residue: freeze it
        // into an interrupted terminal node (pulse stops, text survives) instead of deleting it.
        // Shared by live and window-replay paths, so a refresh reconstructs the same frozen node
        // from the logged chunks. Content-free partials are dropped outright.
        if (this.partial !== null && this.partial.turn === event.data.turn) {
          const { blocks } = this.partial.toPartial()
          const visible = blocks.some(b => (b.kind === 'text' || b.kind === 'reasoning' ? b.text !== '' : true))
          if (visible) {
            // Fractional seq: strictly after every event of this turn (all < turn/end seq), before the next turn.
            this.frozenNodes.push({
              kind: 'assistant', seq: event.seq - 0.9, time: event.time,
              turn: this.partial.turn, step: this.partial.step,
              blocks, interrupted: true,
            })
            this.frozenRev++
          }
          this.partial = null
        }
        let callOffset = 0
        for (const [callId, call] of this.openCalls) {
          if (call.turn !== event.data.turn) continue
          this.openCalls.delete(callId)
          this.callsRev++
          // The spinner card becomes an interrupted terminal card (never vanishes mid-flow).
          this.frozenNodes.push({
            kind: 'tool-result', seq: event.seq - 0.8 + callOffset++ * 0.01, time: event.time,
            callId,
            call: { name: call.name, argsRaw: call.argsRaw },
            callTime: call.time,
            content: [], isError: true, error: { name: 'Interrupted', code: 'interrupted' },
            callView: call.callView, resultView: null,
          })
          this.frozenRev++
        }
        return
      }
      default:
        return
    }
  }

  /** Re-derive state (partial/openCalls/frozenNodes) from raw window events after a rebuild — keeps
   *  paging/stitching consistent, and makes the live freeze and the history replay converge on the
   *  same interrupted nodes (chunks are logged, so the replayed sweep re-freezes identical text). */
  private rebuildDerivedFromWindow(): void {
    this.partial = null
    this.openCalls.clear()
    this.callsRev++
    this.frozenNodes = []
    this.frozenRev++
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
    // Frozen interrupted nodes ride fractional seqs: a stable merge keeps them in flow order.
    // The merged array is cached on (folded reference, frozenRev) so an unchanged flow keeps its
    // reference across snapshot swaps (§A.9.4).
    let nodes: readonly ConversationNode[]
    if (this.nodesCache !== null && this.nodesCache.folded === folded && this.nodesCache.frozenRev === this.frozenRev) {
      nodes = this.nodesCache.value
    } else {
      nodes = this.frozenNodes.length === 0
        ? folded
        : [...folded, ...this.frozenNodes].sort((a, b) => a.seq - b.seq)
      this.nodesCache = { folded, frozenRev: this.frozenRev, value: nodes }
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
    const partial = this.partial?.toPartial() ?? null
    return {
      sessionId: this.sessionId,
      nodes,
      foldDegraded: degraded,
      partial,
      runningCalls: this.callsCache.value,
      pending: this.pendingCache.value,
      codeDispatches: this.dispatchesCache.value,
      running: this.running,
      composerPhase: derivePhase(
        nodes.length > 0 || partial !== null || this.running || this.pendingCache.value.length > 0,
        this.promptAttempted,
      ),
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      intent: this.intent,
      pendingPrompt: this.pendingPrompt,
      lastAgentError: this.lastAgentError,
    }
  }
}

function rpcErrorMessage(error: RpcError): string {
  return `${error.code}: ${error.message}`
}

/**
 * The composerPhase judgment — the single site that knows the predicate
 * (consumers switch on the result, never re-derive). Monotone per session
 * object: `hasContent` only grows within a window and `promptAttempted` is
 * sticky, so blank → engaging → active never steps back; a failed first
 * prompt stays engaging (retry semantics — see ComposerPhase).
 * @param hasContent - any conversation material exists (nodes, partial, running turn, pending waits).
 * @param promptAttempted - a prompt was initiated on this session object.
 * @returns the derived phase.
 */
function derivePhase(hasContent: boolean, promptAttempted: boolean): ComposerPhase {
  if (hasContent) return 'active'
  return promptAttempted ? 'engaging' : 'blank'
}
