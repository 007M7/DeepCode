// @vitest-environment jsdom
/**
 * SidebarRoot interaction spec on the real framework stack: real tree store
 * (web-react SnapshotStore) feeding the component through the same selector
 * hook the inject surface hands out. Covers expand/collapse, subtree unfold,
 * search filtering, row activation, and the creation entries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createSidebarTreeStore, SidebarRoot,
  type SidebarActions, type SidebarTreeStore,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'

const sid = (s: string) => s as SessionId

/** Bare-string init; brands ids and omits absent optional keys (exactOptionalPropertyTypes). */
interface SummaryInit {
  id: string
  title?: string
  cwd?: string
  parentId?: string
  running?: boolean
  updatedAt?: number
}

function summary(init: SummaryInit): SessionSummary {
  const s: SessionSummary = {
    id: sid(init.id),
    title: init.title ?? init.id,
    running: init.running ?? false,
    updatedAt: init.updatedAt ?? 0,
  }
  if (init.cwd !== undefined) s.cwd = init.cwd
  if (init.parentId !== undefined) s.parentId = sid(init.parentId)
  return s
}

function listStateOf(...summaries: SessionSummary[]): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  for (const s of summaries) byId[s.id] = s
  return { ids: summaries.map((s) => s.id), byId }
}

afterEach(cleanup)

function mount(...summaries: SessionSummary[]) {
  const list = createSnapshotStore<SessionListState>(listStateOf(...summaries))
  const tree: SidebarTreeStore = createSidebarTreeStore({ list })
  const current = createSnapshotStore<{ id: SessionId | undefined }>({ id: undefined })
  const actions: SidebarActions = {
    open: vi.fn((id: SessionId) => { current.update((d) => { d.id = id }) }),
    create: vi.fn(),
    toggleSidebar: vi.fn(),
  }
  const utils = render(
    <SidebarRoot
      useTree={tree.store.useSelector}
      useCurrent={() => current.useSelector((s) => s.id)}
      actions={actions}
      tree={tree}
    />,
  )
  return { list, tree, current, actions, ...utils }
}

const projectData = () => [
  summary({ id: 'root', title: 'root work', cwd: '/proj', updatedAt: 5 }),
  summary({ id: 'kid', title: 'forked child', cwd: '/proj', parentId: sid('root'), updatedAt: 4 }),
  summary({ id: 'lone', title: 'elsewhere', cwd: '/other', updatedAt: 3 }),
]

describe('SidebarRoot', () => {
  it('renders chrome and collapsed project rows', () => {
    mount(...projectData())
    expect(screen.getByText('HARNESS')).toBeTruthy()
    expect(screen.getByText('New Session')).toBeTruthy()
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('2 sessions')).toBeTruthy()
    expect(screen.getByText('1 session')).toBeTruthy()
    expect(screen.queryByText('root work')).toBeNull()
  })

  it('expands a project on click and unfolds a subtree via the twist', () => {
    mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('proj')) })
    expect(screen.getByText('root work')).toBeTruthy()
    expect(screen.queryByText('forked child')).toBeNull()
    act(() => { fireEvent.click(screen.getByLabelText('Expand')) })
    expect(screen.getByText('forked child')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByLabelText('Collapse')) })
    expect(screen.queryByText('forked child')).toBeNull()
  })

  it('opens a session on row click and marks it selected', () => {
    const { actions } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('proj')) })
    act(() => { fireEvent.click(screen.getByText('root work')) })
    expect(actions.open).toHaveBeenCalledWith('root')
    expect(screen.getByText('root work').closest('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('search filters across groups and forces ancestor chains visible', () => {
    mount(...projectData())
    const input = screen.getByPlaceholderText('Search name, keywords...')
    act(() => { fireEvent.change(input, { target: { value: 'forked' } }) })
    expect(screen.getByText('forked child')).toBeTruthy()
    expect(screen.getByText('root work')).toBeTruthy()
    expect(screen.queryByText('elsewhere')).toBeNull()
    expect(screen.queryByText(/^other$/)).toBeNull()
    act(() => { fireEvent.click(screen.getByLabelText('Clear search')) })
    expect(screen.queryByText('root work')).toBeNull()
    expect(screen.getByText('proj')).toBeTruthy()
  })

  it('shows the blank-list empty state without a query', () => {
    mount()
    expect(screen.getByText('No sessions yet')).toBeTruthy()
  })

  it('shows the no-match empty state', () => {
    mount(...projectData())
    const input = screen.getByPlaceholderText('Search name, keywords...')
    act(() => { fireEvent.change(input, { target: { value: 'zzz-none' } }) })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('routes the three creation entries with the right cwd', () => {
    const { actions } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('New Session')) })
    expect(actions.create).toHaveBeenLastCalledWith()
    act(() => { fireEvent.click(screen.getByLabelText('New workspace')) })
    expect(actions.create).toHaveBeenLastCalledWith()
    // Per-project "+" is hover-revealed by CSS; still clickable in jsdom.
    act(() => { fireEvent.click(screen.getAllByLabelText('New session here')[0]!) })
    expect(actions.create).toHaveBeenLastCalledWith('/proj')
  })

  it('collapse button and group-by menu behave', () => {
    const { actions } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByLabelText('Collapse sidebar')) })
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
    expect(screen.queryByText('Update')).toBeNull()
    act(() => { fireEvent.click(screen.getByLabelText('Group by')) })
    expect(screen.getByText('Update')).toBeTruthy()
    expect(screen.getByText('Status')).toBeTruthy()
    // Selecting the active strategy closes the list (only workspace is enabled).
    act(() => { fireEvent.click(screen.getByText('WorkSpace', { selector: 'button *' })) })
    expect(screen.queryByText('Update')).toBeNull()
    // Reopen and dismiss via Escape (Menu onClose channel).
    act(() => { fireEvent.click(screen.getByLabelText('Group by')) })
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByText('Update')).toBeNull()
  })

  it('re-renders when the sessions list gains a session', async () => {
    const { list } = mount(...projectData())
    act(() => {
      list.update((draft) => {
        draft.ids.push(sid('fresh'))
        draft.byId[sid('fresh')] = summary({ id: 'fresh', title: 'brand new', cwd: '/fresh', updatedAt: 99 })
      })
    })
    // Store notifications are microtask-batched.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('fresh')).toBeTruthy()
  })

  it('row "More" anchors swallow the click without opening or toggling', () => {
    const { actions, tree } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('proj')) })
    const before = tree.store.getSnapshot().expandedProjects.length
    // Project-row anchor: must not collapse the project.
    act(() => { fireEvent.click(screen.getAllByLabelText('More')[0]!) })
    expect(tree.store.getSnapshot().expandedProjects).toHaveLength(before)
    // Session-row anchor: must not open the session.
    act(() => { fireEvent.click(screen.getAllByLabelText('More')[1]!) })
    expect(actions.open).not.toHaveBeenCalled()
  })

  it('shows the running state dot only for running sessions', () => {
    mount(
      summary({ id: 'busy', title: 'busy one', cwd: '/p', running: true, updatedAt: 2 }),
      summary({ id: 'idle', title: 'idle one', cwd: '/p', updatedAt: 1 }),
    )
    act(() => { fireEvent.click(screen.getByText('p')) })
    const busyRow = screen.getByText('busy one').closest('[role="treeitem"]')!
    const idleRow = screen.getByText('idle one').closest('[role="treeitem"]')!
    expect(busyRow.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(idleRow.querySelector('[data-state="ongoing"]')).toBeNull()
  })
})
