// Session: wraps every contract call that needs a sessionId + all conversation state for this
// session (design §A.2/§A.9/§D.2/§D.3). Instances are resident (ruling 2): never destroyed once
// created, they keep consuming mux frames in the background; React connects directly via
// subscribe/getSnapshot.

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HistoryEntry, IApiClient, MuxFrame, RpcError, RpcId, RpcResult, SessionId, ToolEventView } from '@deepseek-ai/dsh-client-connection/client'
import { transportError } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '../store/index.ts'
import type {
  ConversationNode, ConversationSnapshot, OpenState, PendingInteraction, PromptError, RunningToolCall,
} from './conversation.ts'
import { FoldAdapter } from './fold-adapter.ts'
import { Notifier } from './notifier.ts'
import { PartialAccumulator } from './partial.ts'

/** Messages per page (F.4 ledger: promote to Config at graduation; every call site references this constant). */
export const PAGE_MESSAGES = 50

/**
 * Per-session state owner: event window + fold + partial, snapshot out via
 * subscribe/getSnapshot (see the web client architecture RFC). Bare source
 * only (store migration): the React machinery binds the per-cell useSession
 * hook at its own seam — no selector hook member lives on the data layer.
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
  // Revision counters + caches backing the snapshot's reference-stability contract (§A.9.4/§C.2,
  // audit S5): buildSnapshot reuses the previous array when the revision is unchanged, so
  // React.memo children survive unrelated snapshot swaps (chunk storms must not re-render every
  // tool card and pending card). Mutation sites bump the matching revision. partial needs no
  // counter — PartialAccumulator.toPartial already returns a cached reference when unchanged.
  private callsRev = 0
  private callsCache: { rev: number; value: RunningToolCall[] } | null = null
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  private frozenRev = 0
  private nodesCache: { folded: readonly ConversationNode[]; frozenRev: number; value: readonly ConversationNode[] } | null = null
  private running = false
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Buffer for live events arriving while open/resync is in flight (stitched by seq once history lands, §D.3). */
  private liveBuffer: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  /** Gap-repair (resync-lite) in flight: acceptLiveEvent detours to liveBuffer until the tail page lands (audit S3). */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null

  private snapshotCache: ConversationSnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  constructor(readonly sessionId: SessionId, private readonly api: IApiClient) {
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
    this.pending.clear() // the subscribed baseline replay re-sends still-pending requested frames verbatim
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
        this.pending.set(`a:${rpcId}`, {
          kind: 'approval', rpcId, approvalId: frame.approvalId, toolName: frame.toolName,
          ...(frame.callId !== undefined ? { callId: frame.callId } : {}),
          ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        })
        this.pendingRev++
        this.notifier.markDirty()
        return
      }
      case 'approval/resolved': {
        for (const [key, item] of this.pending) {
          if (item.kind === 'approval' && item.approvalId === frame.approvalId) {
            this.pending.delete(key)
            this.pendingRev++
          }
        }
        this.notifier.markDirty()
        return
      }
      case 'question/requested': {
        this.pending.set(`q:${rpcId}`, { kind: 'question', rpcId, questions: frame.questions })
        this.pendingRev++
        this.notifier.markDirty()
        return
      }
      case 'question/resolved': {
        if (this.pending.delete(`q:${frame.questionRpcId}`)) this.pendingRev++
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

  /** Instance-eviction hook, reserved no-op (design §F.6): resident instances are never destroyed
   *  in v1; an eviction policy lands here (unsubscribe, drop buffers) without touching call sites. */
  dispose(): void {}

  // ---- 私有 ----

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
          turn: event.data.turn, step: event.data.step,
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
              kind: 'assistant', seq: event.seq - 0.9, turn: this.partial.turn, step: this.partial.step,
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
            kind: 'tool-result', seq: event.seq - 0.8 + callOffset++ * 0.01, callId,
            call: { name: call.name, argsRaw: call.argsRaw },
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
    return {
      sessionId: this.sessionId,
      nodes,
      foldDegraded: degraded,
      partial: this.partial?.toPartial() ?? null,
      runningCalls: this.callsCache.value,
      pending: this.pendingCache.value,
      running: this.running,
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      lastAgentError: this.lastAgentError,
    }
  }
}
