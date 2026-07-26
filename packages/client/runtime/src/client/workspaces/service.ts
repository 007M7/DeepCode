/** WorkspacesService projects the Workspace object manager for UI consumers. */

import type { Context } from 'cordis'
import type {
  IApiClient, RpcError, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsService } from '../sessions/service.ts'
import { WorkspaceManager, type WorkspaceIntentSnapshot, type WorkspaceListPhase } from './manager.ts'

/** Workspace list plus the two-baseline readiness and default-target projection. */
export interface WorkspaceListState {
  items: readonly WorkspaceView[]
  /** Sole client-local Workspace projection; its state remains owned by Workspace. */
  intent: WorkspaceIntentSnapshot | undefined
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
  /** True only after both workspace.list and session.list have succeeded. */
  baselinesReady: boolean
  /** Most recently active Workspace, derived without changing `items` order. */
  recentWorkspaceId: WorkspaceId | undefined
}

/** Real Workspace object layer and Host actions. */
export class WorkspacesService {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<WorkspaceListState>
  /** Workspace baseline and frame owner. */
  private readonly manager: WorkspaceManager
  private initialSessionResolved = false
  private composingIntent = false

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - lower-level Session service used for recency and cross-domain intent orchestration.
   */
  constructor(ctx: Context, api: IApiClient, private readonly sessions: SessionsService) {
    this.manager = new WorkspaceManager(api)
    this.list = createSnapshotStore<WorkspaceListState>({
      items: [], intent: undefined, state: 'idle', phase: 'pending', error: null,
      baselinesReady: false, recentWorkspaceId: undefined,
    })
    this.manager.subscribe(() => { if (!this.composingIntent) this.project() })
    this.sessions.list.subscribe(() => { if (!this.composingIntent) this.project() })
    ctx.reflect.provide('workspaces', this, undefined)
  }

  /**
   * Start the sole Session intent, resolving the default Workspace here.
   * @param workspaceId - optional explicit real Workspace target.
   * @param prompt - optional prompt retained while retargeting.
   */
  startSession(workspaceId?: WorkspaceId, prompt = ''): void {
    const snapshot = this.list.getSnapshot()
    const resolved = workspaceId ?? snapshot.recentWorkspaceId ?? snapshot.items[0]?.workspaceId
    this.composingIntent = true
    try {
      if (resolved === undefined) {
        this.manager.startIntent()
        this.sessions.startIntent({ kind: 'workspace-intent' }, prompt)
      } else {
        this.manager.discardIntent()
        this.sessions.startIntent({ kind: 'workspace', workspaceId: resolved }, prompt)
      }
    } finally {
      this.composingIntent = false
      this.project()
    }
  }

  /** Connect the current frontend Workspace and Session, then flush the Session-owned prompt. */
  sendSession(): void {
    const session = this.sessions.intent()
    const target = session?.getSnapshot().intent?.target
    if (session === undefined || target === undefined) return
    if (target.kind === 'workspace') {
      session.connect(target.workspaceId)
      return
    }
    if (session.getSnapshot().pendingPrompt?.text.trim() === '') return
    void this.manager.materializeIntent().then((result) => {
      if (this.sessions.intent() !== session) return
      if (result?.ok) {
        session.connect(result.value.workspace.workspaceId)
      }
    })
  }

  /**
   * Create a Workspace by name or register an existing path.
   * @param input - exactly one Host create spelling.
   * @returns the created or idempotently resolved Workspace.
   */
  async create(input: { name: string } | { path: string }): Promise<WorkspaceView> {
    const result = await this.manager.create(input)
    if (!result.ok) throw new Error(`workspace create failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - new display title (trimmed non-empty by the Host).
   * @returns the renamed Workspace view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.manager.rename(workspaceId, title)
    if (!result.ok) throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Move a session within its Workspace's manual order (DOM-insertBefore-like).
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Refresh the workspace baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started workspace baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refresh()
  }

  /**
   * Route a Host stream envelope into the Workspace object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<WorkspaceManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Workspace baseline after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  private project(): void {
    const workspace = this.manager.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    if (workspace.intent !== undefined && sessions.intent?.target.kind !== 'workspace-intent') {
      this.manager.discardIntent()
      return
    }
    const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready'
    this.list.set({
      ...workspace,
      baselinesReady,
      recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
    })
    if (!this.initialSessionResolved && baselinesReady) {
      this.initialSessionResolved = true
      if (sessions.current === undefined && sessions.intent === undefined) this.startSession()
    }
  }
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: ReturnType<SessionsService['list']['getSnapshot']>['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
