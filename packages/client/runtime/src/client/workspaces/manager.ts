/** Workspace baseline, incremental-frame, and unary-action owner. */

import type {
  HostFrame, IApiClient, RpcError, RpcRequest, RpcResult, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import { Notifier } from '../sessions/notifier.ts'
import {
  Workspace, type WorkspaceCreateInput, type WorkspaceIntentSnapshot,
} from './workspace.ts'

export type { WorkspaceIntentSnapshot } from './workspace.ts'

/** Monotone workspace-list arrival lifecycle. */
export type WorkspaceListPhase = 'pending' | 'ready'

/** Immutable workspace-list snapshot. */
export interface WorkspaceListSnapshot {
  items: readonly WorkspaceView[]
  /** The sole page-local Workspace intent; never persisted or sent over the Host stream. */
  intent: WorkspaceIntentSnapshot | undefined
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
}

/** Workspace object cluster driven by one list baseline and changed-frame upserts. */
export class WorkspaceManager {
  private items: Workspace[] = []
  private intent: Workspace | undefined
  private itemViewsSource: readonly Workspace[] | null = null
  private itemViewsCache: readonly WorkspaceView[] = []
  private state: WorkspaceListSnapshot['state'] = 'idle'
  private phase: WorkspaceListPhase = 'pending'
  private error: RpcError | null = null
  private inflight: Promise<void> | null = null
  private refreshFrames: WorkspaceView[] | null = null
  private snapshotCache: WorkspaceListSnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  /** @param api - shared wire client. */
  constructor(private readonly api: IApiClient) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Replace the current client-local Workspace intent object.
   * @param name - directory/display name used if the intent is materialized.
   * @returns the new intent snapshot.
   */
  startIntent(name = 'workspace'): WorkspaceIntentSnapshot {
    this.intent = new Workspace(this.api, { name })
    this.notifier.notifyNow()
    return this.intent.getSnapshot().intent as WorkspaceIntentSnapshot
  }

  /** Discard the current client-local Workspace intent. */
  discardIntent(): void {
    if (this.intent === undefined) return
    this.intent = undefined
    this.notifier.notifyNow()
  }

  /**
   * Materialize the current Workspace intent through the ordinary Host create seam.
   * A superseded intent is never cleared by an older completion.
   * @returns the Host create result, or undefined when no intent exists.
   */
  async materializeIntent(): Promise<RpcResult<{ workspace: WorkspaceView; created: boolean }> | undefined> {
    const intent = this.intent
    if (intent?.getSnapshot().intent?.phase !== 'ready') return undefined
    const completion = intent.materialize()
    if (completion === undefined) return undefined
    this.notifier.notifyNow()
    const result = await completion
    if (result.ok) {
      this.upsert(result.value.workspace, intent)
      if (this.intent === intent) this.intent = undefined
    }
    this.notifier.markDirty()
    return result
  }

  /**
   * Refresh from workspace.list. The first successful response establishes
   * Host order; later responses update membership and values without moving
   * identities already visible to the client. Frames arriving during the RPC
   * are replayed over its response.
   * @returns the shared in-flight refresh.
   */
  refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight
    this.state = 'loading'
    this.error = null
    const established = this.itemViews()
    const frames: WorkspaceView[] = []
    this.refreshFrames = frames
    this.notifier.markDirty()
    this.inflight = (async () => {
      try {
        const { result } = await this.api.workspace.list({})
        if (result.ok) {
          let items = this.phase === 'pending'
            ? result.value.items
            : mergeOrderedBaseline(established, result.value.items, workspace => workspace.workspaceId)
          for (const workspace of frames) items = upsertWorkspace(items, workspace)
          this.installViews(items)
          this.state = 'idle'
          this.phase = 'ready'
        } else {
          this.state = 'error'
          this.error = result.error
        }
      } catch (error) {
        this.state = 'error'
        const folded = transportError<never>(error)
        /* v8 ignore next -- transportError always returns the failure branch. */
        this.error = folded.ok ? null : folded.error
      } finally {
        this.refreshFrames = null
        this.inflight = null
        this.notifier.markDirty()
      }
    })()
    return this.inflight
  }

  /**
   * Create or resolve a real Workspace, then publish its returned snapshot
   * without waiting for the changed frame.
   * @param input - name under workspaceRoot or an existing absolute path.
   * @returns the wire result.
   */
  async create(input: WorkspaceCreateInput): Promise<RpcResult<{ workspace: WorkspaceView; created: boolean }>> {
    const workspace = new Workspace(this.api, input)
    const completion = workspace.materialize()
    if (completion === undefined) throw new Error('a local Workspace must be materializable')
    const result = await completion
    if (result.ok) this.upsert(result.value.workspace, workspace)
    return result
  }

  /**
   * Rename a Workspace, then publish its returned snapshot without waiting
   * for the changed frame.
   * @param workspaceId - target workspace.
   * @param title - new display title.
   * @returns the wire result.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RpcResult<{ workspace: WorkspaceView }>> {
    const { result } = await this.api.workspace.rename({ workspaceId, title })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Move a session within its Workspace's manual order, then publish the
   * returned snapshot without waiting for the changed frame.
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the wire result.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<RpcResult<{ workspace: WorkspaceView }>> {
    const { result } = await this.api.workspace.insertSessionBefore({
      workspaceId, sessionId,
      ...beforeSessionId === undefined ? {} : { beforeSessionId },
    })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Host-frame entry. Non-workspace frames are ignored so the runtime can
   * fan one host stream out to both object managers.
   * @param envelope - host stream envelope.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    if (envelope.payload.type === 'host/workspace-changed') this.upsert(envelope.payload.workspace)
  }

  /** Re-pull the baseline after each connection generation. */
  handleConnected(): void {
    void this.refresh()
  }

  /**
   * Subscribe to workspace snapshot invalidation.
   * @param listener - snapshot invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Read the cached workspace snapshot after flushing pending notifications.
   * @returns the cached workspace snapshot.
   */
  getSnapshot(): WorkspaceListSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  private buildSnapshot(): WorkspaceListSnapshot {
    return {
      items: this.itemViews(),
      intent: this.intent?.getSnapshot().intent,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  /** Upsert one Host view, optionally retaining the local object that materialized it. */
  private upsert(view: WorkspaceView, identity?: Workspace): void {
    this.refreshFrames?.push(view)
    const index = this.items.findIndex(item => item.getSnapshot().view?.workspaceId === view.workspaceId)
    // Mutation responses and changed frames race (two carriers, no ordering):
    // reject a snapshot strictly older than the installed projection so a
    // late unary response cannot roll back a newer frame.
    const installed = index === -1 ? undefined : this.items[index]?.getSnapshot().view
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return
    if (identity !== undefined) {
      this.items = index === -1
        ? [identity, ...this.items]
        : this.items.map((item, position) => position === index ? identity : item)
    } else if (index === -1) {
      this.items = [new Workspace(this.api, view), ...this.items]
    } else {
      this.items[index]?.adopt(view)
      this.items = [...this.items]
    }
    this.notifier.markDirty()
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const existing = new Map(
      this.items.flatMap((workspace) => {
        const view = workspace.getSnapshot().view
        return view === undefined ? [] : [[view.workspaceId, workspace] as const]
      }),
    )
    const installed = new Map<WorkspaceView['workspaceId'], Workspace>()
    for (const view of views) {
      const duplicate = installed.get(view.workspaceId)
      if (duplicate !== undefined) {
        duplicate.adopt(view)
        continue
      }
      const workspace = existing.get(view.workspaceId) ?? new Workspace(this.api, view)
      workspace.adopt(view)
      installed.set(view.workspaceId, workspace)
    }
    this.items = [...installed.values()]
  }

  private itemViews(): readonly WorkspaceView[] {
    if (this.itemViewsSource === this.items) return this.itemViewsCache
    this.itemViewsSource = this.items
    this.itemViewsCache = this.items.flatMap((workspace) => {
      const view = workspace.getSnapshot().view
      return view === undefined ? [] : [view]
    })
    return this.itemViewsCache
  }
}

/** Known ids retain their position; a newly created Workspace enters first. */
function upsertWorkspace(items: readonly WorkspaceView[], workspace: WorkspaceView): WorkspaceView[] {
  const index = items.findIndex(item => item.workspaceId === workspace.workspaceId)
  return index === -1
    ? [workspace, ...items]
    : items.map((item, position) => position === index ? workspace : item)
}
