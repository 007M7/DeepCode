/**
 * Sidebar tree store: plugin-owned snapshot store materializing the derived
 * row list. Subscribes to sessions.list and re-derives on list changes and
 * on viewing-state actions (expansion, search, group-by) — components
 * subscribe to `rows` and never derive in render. Contract: api-contracts
 * v3 section 6.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { deriveRows, type SidebarRow } from './tree.ts'

/** Grouping strategy. Only by-workspace is designed (figma); the menu shows the rest disabled. */
export type GroupBy = 'workspace'

/** Sidebar tree state: materialized rows plus the viewing state that shaped them. */
export interface SidebarTreeState {
  rows: SidebarRow[]
  /** Expanded project group keys (cwd or the ungrouped key). */
  expandedProjects: string[]
  /** Expanded session ids (subtree unfold). */
  expandedSessions: string[]
  query: string
  groupBy: GroupBy
}

/** Store handle: snapshot store plus mutation actions and the list unsubscribe. */
export interface SidebarTreeStore {
  readonly store: SnapshotStore<SidebarTreeState>
  toggleProject(key: string): void
  toggleSession(id: SessionId): void
  setQuery(query: string): void
  setGroupBy(groupBy: GroupBy): void
  dispose(): void
}

/**
 * Create the sidebar tree store bound to a sessions service.
 * @param sessions - root sessions service (only the list store is consumed).
 * @returns store handle; call dispose on plugin teardown.
 */
export function createSidebarTreeStore(sessions: Pick<SessionsService, 'list'>): SidebarTreeStore {
  const store = createSnapshotStore<SidebarTreeState>({
    rows: [],
    expandedProjects: [],
    expandedSessions: [],
    query: '',
    groupBy: 'workspace',
  })

  const rederive = (draft: SidebarTreeState): void => {
    draft.rows = deriveRows(sessions.list.getSnapshot(), {
      expandedProjects: new Set(draft.expandedProjects),
      expandedSessions: new Set(draft.expandedSessions),
      query: draft.query,
    })
  }
  store.update(rederive)
  const unsubscribe = sessions.list.subscribe(() => { store.update(rederive) })

  const toggle = (list: string[], key: string): void => {
    const at = list.indexOf(key)
    if (at >= 0) list.splice(at, 1)
    else list.push(key)
  }

  return {
    store,
    toggleProject(key) {
      store.update((draft) => {
        toggle(draft.expandedProjects, key)
        rederive(draft)
      })
    },
    toggleSession(id) {
      store.update((draft) => {
        toggle(draft.expandedSessions, id)
        rederive(draft)
      })
    },
    setQuery(query) {
      store.update((draft) => {
        draft.query = query
        rederive(draft)
      })
    },
    setGroupBy(groupBy) {
      store.update((draft) => {
        draft.groupBy = groupBy
        rederive(draft)
      })
    },
    dispose: unsubscribe,
  }
}
