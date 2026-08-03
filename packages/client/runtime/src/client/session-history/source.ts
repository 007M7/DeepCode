import type {
  HistoryEntry, IApiClient, MuxFrame, RpcError, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  SessionHistoryFace, SessionHistorySnapshot,
} from '../contract/session-history.ts'
import { createHistoryInspection } from '../sessions/history.ts'
import { Notifier } from '../sessions/notifier.ts'
import { PartialAccumulator } from '../sessions/partial.ts'

const HISTORY_PAGE_MESSAGES = 50

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Independent raw-history owner used only by inspection consumers. */
export class SessionHistorySource implements SessionHistoryFace {
  private entries: readonly HistoryEntry[] = []
  private baseSeq = 0
  private hasMore = false
  private state: SessionHistorySnapshot['state'] = 'cold'
  private error: RpcError | null = null
  private generation = 0
  private persistentConsumer = false
  private readonly consumerSignals = new Set<AbortSignal>()
  private openPromise: Promise<void> | null = null
  private olderPromise: Promise<void> | null = null
  private stitching = false
  private liveBuffer: HistoryEntry[] = []
  private subscribedLastSeq: number | null = null
  private inspectionCache: {
    entries: readonly HistoryEntry[]
    value: SessionHistorySnapshot['inspection']
  } | null = null
  private streamPublishToken: object | null = null
  private streamBaseInspection: SessionHistorySnapshot['inspection'] | null = null
  private streamPartial: PartialAccumulator | null = null
  private snapshotCache: SessionHistorySnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  /**
   * @param sessionId - Host session identity.
   * @param api - Shared wire client.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
  ) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Subscribe to ledger changes.
   * @param listener - Change callback.
   * @returns Unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Read the cached ledger snapshot.
   * @returns Stable snapshot until the source changes.
   */
  getSnapshot(): SessionHistorySnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  /**
   * Load the tail and exhaust all available older pages.
   * @param signal - Consumer lifetime.
   * @returns When paging completes, fails to advance, or is aborted.
   */
  async loadAll(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return
    this.trackConsumer(signal)
    await this.open()
    while (
      !isAborted(signal)
      && this.state === 'ready'
      && this.hasMore
    ) {
      const previousBaseSeq = this.baseSeq
      await this.loadOlder()
      if (isAborted(signal) || this.baseSeq === previousBaseSeq) return
    }
  }

  /** Rebuild and page for whichever mounted consumers survive a reconnect. */
  private async loadForConsumers(): Promise<void> {
    await this.open()
    while (
      this.hasConsumer()
      && this.state === 'ready'
      && this.hasMore
    ) {
      const previousBaseSeq = this.baseSeq
      await this.loadOlder()
      if (!this.hasConsumer() || this.baseSeq === previousBaseSeq) return
    }
  }

  /**
   * Route a relevant mux frame without involving the Chat session.
   * @param frame - Session-addressed frame.
   */
  handleMuxFrame(frame: MuxFrame): void {
    if (frame.type === 'session/subscribed') {
      this.subscribedLastSeq = frame.lastSeq
      return
    }
    if (frame.type !== 'session/event') return
    this.acceptLive({ event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
  }

  /** Invalidate dead-generation requests while retaining the last readable snapshot. */
  handleDisconnected(): void {
    this.generation++
    this.openPromise = null
    this.olderPromise = null
    this.stitching = false
    this.liveBuffer = []
    this.subscribedLastSeq = null
    if (this.state !== 'cold') {
      this.state = 'cold'
      this.error = null
      this.publishDirtyNow()
    }
  }

  /** Rebuild an activated ledger from the new connection generation. */
  resync(): void {
    if (!this.hasConsumer()) return
    this.generation++
    this.openPromise = null
    this.olderPromise = null
    this.stitching = false
    this.liveBuffer = []
    this.subscribedLastSeq = null
    this.entries = []
    this.baseSeq = 0
    this.hasMore = false
    this.state = 'cold'
    this.error = null
    this.publishDirtyNow()
    void this.loadForConsumers()
  }

  /** Stop future refresh work after the host removes the session. */
  dispose(): void {
    this.persistentConsumer = false
    this.consumerSignals.clear()
    this.generation++
    this.openPromise = null
    this.olderPromise = null
    this.liveBuffer = []
    this.streamPublishToken = null
    this.streamBaseInspection = null
    this.streamPartial = null
  }

  private open(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const generation = this.generation
    const operation = this.doOpen(generation)
    const settled = operation.finally(() => {
      if (this.openPromise === settled) this.openPromise = null
    })
    this.openPromise = settled
    return settled
  }

  private trackConsumer(signal: AbortSignal | undefined): void {
    if (signal === undefined) {
      this.persistentConsumer = true
      return
    }
    if (this.consumerSignals.has(signal)) return
    this.consumerSignals.add(signal)
    signal.addEventListener('abort', () => {
      this.consumerSignals.delete(signal)
    }, { once: true })
  }

  private hasConsumer(): boolean {
    return this.persistentConsumer || this.consumerSignals.size > 0
  }

  private async doOpen(generation: number): Promise<void> {
    this.state = 'loading'
    this.error = null
    this.publishDirtyNow()
    try {
      let { result } = await this.api.sessions.history({
        sessionId: this.sessionId,
        maxMessages: HISTORY_PAGE_MESSAGES,
      })
      if (generation !== this.generation) return
      if (!result.ok) {
        this.state = 'error'
        this.error = result.error
        return
      }
      this.installTail(result.value.events, result.value.hasMore, true)
      const tailSeq = this.tailSeq()
      if (
        this.subscribedLastSeq !== null
        && tailSeq !== null
        && this.subscribedLastSeq > tailSeq
      ) {
        result = (await this.api.sessions.history({
          sessionId: this.sessionId,
          maxMessages: HISTORY_PAGE_MESSAGES,
        })).result
        if (generation !== this.generation) return
        if (result.ok) this.installTail(result.value.events, result.value.hasMore, true)
      }
      this.state = 'ready'
    } catch (error) {
      if (generation !== this.generation) return
      this.state = 'error'
      const folded = transportError<never>(error)
      /* v8 ignore next -- transportError always returns the error branch. */
      this.error = folded.ok ? null : folded.error
    } finally {
      if (generation === this.generation) this.publishDirtyNow()
    }
  }

  private loadOlder(): Promise<void> {
    if (this.olderPromise !== null) return this.olderPromise
    if (this.state !== 'ready' || !this.hasMore) return Promise.resolve()
    const generation = this.generation
    const operation = (async () => {
      try {
        const { result } = await this.api.sessions.history({
          sessionId: this.sessionId,
          beforeSeq: this.baseSeq,
          maxMessages: HISTORY_PAGE_MESSAGES,
        })
        if (generation !== this.generation || this.state !== 'ready' || !result.ok) return
        const older = result.value.events
        if (older.length === 0) {
          this.hasMore = result.value.hasMore
          return
        }
        const tail = older.at(-1)
        if (tail === undefined || tail.event.seq + 1 !== this.baseSeq) {
          console.error(
            `[web-runtime] inspection history page discontinuous: tail seq ${tail?.event.seq} vs baseSeq ${this.baseSeq}`,
          )
          this.hasMore = false
          return
        }
        this.entries = [...older, ...this.entries]
        this.baseSeq = older[0]?.event.seq ?? this.baseSeq
        this.hasMore = result.value.hasMore
      } catch (error) {
        console.error('[web-runtime] inspection history paging failed:', error)
      }
    })()
    const settled = operation.finally(() => {
      if (this.olderPromise !== settled) return
      this.olderPromise = null
      this.publishDirtyNow()
    })
    this.olderPromise = settled
    return settled
  }

  private installTail(
    tail: readonly HistoryEntry[],
    hasMore: boolean,
    replace: boolean,
  ): void {
    if (replace) {
      this.entries = [...tail]
      this.hasMore = hasMore
    } else {
      const firstSeq = tail[0]?.event.seq
      const prefix = firstSeq === undefined
        ? this.entries
        : this.entries.filter(entry => entry.event.seq < firstSeq)
      this.entries = [...prefix, ...tail]
    }
    this.baseSeq = this.entries[0]?.event.seq ?? 0
    const buffered = this.liveBuffer
    this.liveBuffer = []
    for (const entry of buffered) this.appendLive(entry)
    this.publishDirtyNow()
  }

  private acceptLive(entry: HistoryEntry): void {
    if (this.state === 'loading' || this.stitching) {
      this.liveBuffer.push(entry)
      return
    }
    if (this.state !== 'ready') return
    const tailSeq = this.tailSeq()
    if (tailSeq !== null && entry.event.seq > tailSeq + 1) {
      this.liveBuffer.push(entry)
      void this.repairGap()
      return
    }
    if (
      entry.event.type === 'assistant/chunk'
      && entry.event.data.chunk.type !== 'usage'
    ) {
      if (!this.appendIncrementalChunk(entry, entry.event)) return
      this.publishStreamDirty()
      return
    }
    this.appendLive(entry)
    this.publishDirtyNow()
  }

  private appendLive(entry: HistoryEntry): void {
    const tailSeq = this.tailSeq()
    if (tailSeq !== null && entry.event.seq <= tailSeq) return
    this.entries = [...this.entries, entry]
  }

  /** Append a chunk against the cached finalized projection; false means no visible publish. */
  private appendIncrementalChunk(
    entry: HistoryEntry,
    event: SessionEvent<'assistant/chunk'>,
  ): boolean {
    const { turn, step, chunk } = event.data
    if (!isVisibleAssistantChunk(chunk.type)) {
      const inspection = this.currentInspection()
      this.appendLive(entry)
      this.inspectionCache = { entries: this.entries, value: inspection }
      return false
    }
    const base = this.streamBaseInspection ?? this.currentInspection()
    this.streamBaseInspection = base
    if (
      this.streamPartial === null
      || this.streamPartial.turn !== turn
      || this.streamPartial.step !== step
    ) {
      const current = base.partial
      this.streamPartial = new PartialAccumulator(
        turn,
        step,
        current?.turn === turn && current.step === step ? current.blocks : [],
      )
    }
    this.streamPartial.push(chunk)
    this.appendLive(entry)
    this.inspectionCache = {
      entries: this.entries,
      value: { ...base, partial: this.streamPartial.toPartial() },
    }
    return true
  }

  /** Coalesce token-stream projection and rendering work to one publish per browser frame. */
  private publishStreamDirty(): void {
    if (this.streamPublishToken !== null) return
    const token = {}
    this.streamPublishToken = token
    const publish = () => {
      if (this.streamPublishToken !== token) return
      this.streamPublishToken = null
      this.notifier.markDirty()
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(publish)
    } else {
      queueMicrotask(publish)
    }
  }

  /** Publish structural changes immediately and invalidate an older scheduled stream publish. */
  private publishDirtyNow(): void {
    this.streamPublishToken = null
    this.streamBaseInspection = null
    this.streamPartial = null
    this.notifier.markDirty()
  }

  private async repairGap(): Promise<void> {
    if (this.stitching) return
    this.stitching = true
    const generation = this.generation
    try {
      const { result } = await this.api.sessions.history({
        sessionId: this.sessionId,
        maxMessages: HISTORY_PAGE_MESSAGES,
      })
      if (result.ok && generation === this.generation && this.state === 'ready') {
        this.installTail(result.value.events, result.value.hasMore, false)
      }
    } catch (error) {
      console.error('[web-runtime] inspection history gap repair failed:', error)
    } finally {
      if (generation === this.generation) this.stitching = false
    }
  }

  private tailSeq(): number | null {
    return this.entries.at(-1)?.event.seq ?? null
  }

  private buildSnapshot(): SessionHistorySnapshot {
    return {
      state: this.state,
      error: this.error,
      hasMore: this.hasMore,
      inspection: this.currentInspection(),
    }
  }

  /** Inspection pinned to the source's current immutable entry array. */
  private currentInspection(): SessionHistorySnapshot['inspection'] {
    if (this.inspectionCache?.entries !== this.entries) {
      const entries = this.entries
      this.inspectionCache = {
        entries,
        value: createHistoryInspection(() => entries),
      }
    }
    return this.inspectionCache.value
  }
}

function isVisibleAssistantChunk(type: string): boolean {
  return type === 'block-start'
    || type === 'text-delta'
    || type === 'reasoning-delta'
    || type === 'tool-call-delta'
    || type === 'block-end'
}
