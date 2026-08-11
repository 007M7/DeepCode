/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Session-list grouping mode: workspace sections or one flat recency list. */
export type WorkspaceGroupBy = 'workspace' | 'flat'
/** Session order: durable Workspace order or an activity-promoted editable order. */
export type WorkspaceOrderBy = 'manual' | 'updated'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: WorkspaceGroupBy
  orderBy: WorkspaceOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  workspaceExpansion: Record<string, boolean>
  /** Editable per-Workspace order used by recent-update mode. */
  recentSessionOrder: Record<string, string[]>
  /** Last observed update timestamps used to detect promotion events. */
  recentSessionUpdatedAt: Record<string, Record<string, number>>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: WorkspaceGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: WorkspaceOrderBy) => void
  setWorkspaceExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  syncRecentSessions: (
    draft: WorkspaceViewState,
    workspaceKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setRecentSessionOrder: (draft: WorkspaceViewState, workspaceKey: string, order: string[]) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'manual',
      workspaceExpansion: {},
      recentSessionOrder: {},
      recentSessionUpdatedAt: {},
    }),
    persist: 'dsh.workspace.view.v4',
    actions: {
      setGroupBy: (d, mode: WorkspaceGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: WorkspaceOrderBy) => { d.orderBy = mode },
      setWorkspaceExpanded: (d, key: string, expanded: boolean) => { d.workspaceExpansion[key] = expanded },
      syncRecentSessions: (d, workspaceKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.recentSessionOrder[workspaceKey] = order
        d.recentSessionUpdatedAt[workspaceKey] = updatedAt
      },
      setRecentSessionOrder: (d, workspaceKey: string, order: string[]) => {
        d.recentSessionOrder[workspaceKey] = order
      },
    },
  })
}
