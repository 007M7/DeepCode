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
/** Session order: durable Workspace order or a derived timestamp order. */
export type WorkspaceOrderBy = 'manual' | 'created' | 'updated'

/** Workspace browser viewing state; transient expansion facts stay component-local. */
type WorkspaceViewState = { groupBy: WorkspaceGroupBy; orderBy: WorkspaceOrderBy }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: WorkspaceGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: WorkspaceOrderBy) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({ groupBy: 'workspace', orderBy: 'manual' }),
    // The added order field changes the whole-value persistence format.
    persist: 'dsh.workspace.view.v2',
    actions: {
      setGroupBy: (d, mode: WorkspaceGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: WorkspaceOrderBy) => { d.orderBy = mode },
    },
  })
}
