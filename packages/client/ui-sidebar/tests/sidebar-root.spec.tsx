// @vitest-environment jsdom
/**
 * SidebarRoot interaction spec, props-direct (slot-parity test doctrine:
 * components are fed composed props, no assembly machinery). The standard
 * useSessions hook is stubbed with a real web-react SnapshotStore selector;
 * expansion/search live inside the component, so all viewing behavior is
 * driven through the DOM. Covers expand/collapse, subtree unfold, search
 * filtering, row activation, and the creation entries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, useSyncExternalStore } from 'react'
// Engine home: runtime/client since the store migration; the engine carries
// no hook (runtime is React-free), so the spec binds the selector locally.
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'

/** Minimal selector hook over an engine store (production binding lives in the renderer). */
function hookOf<T>(src: { getSnapshot(): T; subscribe(fn: () => void): () => void }) {
  return <S,>(sel: (s: T) => S, _eq?: (a: S, b: S) => boolean): S =>
    sel(useSyncExternalStore(src.subscribe.bind(src), src.getSnapshot.bind(src)))
}

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
  return { ids: summaries.map((s) => s.id), byId, current: undefined }
}

afterEach(cleanup)

function mount(...summaries: SessionSummary[]) {
  // Real engine store as the useSessions stub: same uSES selector shape the
  // framework delivers, so list updates re-render exactly like production.
  const sessions = createSnapshotStore<SessionListState>(listStateOf(...summaries))
  const onOpen = vi.fn((id: SessionId) => { sessions.update((d) => { d.current = id }) })
  const onCreate = vi.fn()
  // The owner decides collapsed in production (AppFrame maps the preference);
  // the harness mirrors that loop so the toggle drives a re-render.
  let collapsed = false
  const view = (width: number) => (
    <SidebarRoot
      collapsed={collapsed}
      width={width}
      useSessions={hookOf(sessions)}
      onOpen={onOpen}
      onCreate={onCreate}
      onToggleSidebar={onToggleSidebar}
    />
  )
  const onToggleSidebar = vi.fn(() => {
    collapsed = !collapsed
    utils.rerender(view(collapsed ? 56 : 300))
  })
  const utils = render(view(300))
  return { sessions, onOpen, onCreate, onToggleSidebar, ...utils }
}

const projectData = () => [
  summary({ id: 'root', title: 'root work', cwd: '/proj', updatedAt: 5 }),
  summary({ id: 'kid', title: 'forked child', cwd: '/proj', parentId: sid('root'), updatedAt: 4 }),
  summary({ id: 'lone', title: 'elsewhere', cwd: '/other', updatedAt: 3 }),
]

/** Flush the store's microtask-batched notification into React. */
const flush = async () => { await act(async () => { await Promise.resolve() }) }

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

  it('opens a session on row click and marks it selected', async () => {
    const { onOpen } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('proj')) })
    act(() => { fireEvent.click(screen.getByText('root work')) })
    expect(onOpen).toHaveBeenCalledWith('root')
    // The mock routed the open into sessions.current — highlight follows.
    await flush()
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
    const { onCreate } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('New Session')) })
    expect(onCreate).toHaveBeenLastCalledWith()
    act(() => { fireEvent.click(screen.getByLabelText('New workspace')) })
    expect(onCreate).toHaveBeenLastCalledWith()
    // Per-project "+" is hover-revealed by CSS; still clickable in jsdom.
    act(() => { fireEvent.click(screen.getAllByLabelText('New session here')[0]!) })
    expect(onCreate).toHaveBeenLastCalledWith('/proj')
  })

  it('collapse fades the wide content out, then the rail keeps the four controls', () => {
    vi.useFakeTimers()
    try {
      const { onToggleSidebar, onCreate } = mount(...projectData())
      act(() => { fireEvent.click(screen.getByLabelText('Collapse sidebar')) })
      expect(onToggleSidebar).toHaveBeenCalledOnce()
      // Fade window: the wide chrome is still mounted while it fades.
      expect(screen.getByText('HARNESS')).toBeTruthy()
      expect(screen.getByRole('tree')).toBeTruthy()
      // Settle: wide content unmounts, the rail controls remain.
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.queryByText('HARNESS')).toBeNull()
      expect(screen.queryByText('New Session')).toBeNull()
      expect(screen.queryByRole('tree')).toBeNull()
      // Rail order mirrors the expanded rows: expand, new session, new workspace, search.
      const rail = ['Expand sidebar', 'New session', 'New workspace', 'Search sessions', 'Settings']
        .map((label) => screen.getByLabelText(label))
      for (let i = 1; i < rail.length; i++) {
        expect(rail[i - 1]!.compareDocumentPosition(rail[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
      // Rail creation entries route like their expanded counterparts.
      act(() => { fireEvent.click(screen.getByLabelText('New session')) })
      expect(onCreate).toHaveBeenLastCalledWith()
      act(() => { fireEvent.click(screen.getByLabelText('Expand sidebar')) })
      expect(onToggleSidebar).toHaveBeenCalledTimes(2)
      expect(screen.getByLabelText('Collapse sidebar')).toBeTruthy()
      expect(screen.getByText('New Session')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail search expands the sidebar and focuses the search box', () => {
    vi.useFakeTimers()
    try {
      const { onToggleSidebar } = mount(...projectData())
      act(() => { fireEvent.click(screen.getByLabelText('Collapse sidebar')) })
      act(() => { vi.advanceTimersByTime(300) })
      act(() => { fireEvent.click(screen.getByLabelText('Search sessions')) })
      expect(onToggleSidebar).toHaveBeenCalledTimes(2)
      const input = screen.getByPlaceholderText('Search name, keywords...')
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expanded search focuses without toggling the sidebar', () => {
    const { onToggleSidebar } = mount(...projectData())
    const input = screen.getByPlaceholderText('Search name, keywords...')
    act(() => { fireEvent.click(screen.getByLabelText('Search sessions')) })
    expect(document.activeElement).toBe(input)
    expect(onToggleSidebar).not.toHaveBeenCalled()
  })

  it('the search query survives a collapse/expand round trip', () => {
    vi.useFakeTimers()
    try {
      mount(...projectData())
      const input = screen.getByPlaceholderText('Search name, keywords...')
      act(() => { fireEvent.change(input, { target: { value: 'forked' } }) })
      act(() => { fireEvent.click(screen.getByLabelText('Collapse sidebar')) })
      act(() => { vi.advanceTimersByTime(300) })
      act(() => { fireEvent.click(screen.getByLabelText('Expand sidebar')) })
      const restored = screen.getByPlaceholderText('Search name, keywords...') as HTMLInputElement
      expect(restored.value).toBe('forked')
      expect(screen.getByText('forked child')).toBeTruthy()
      expect(screen.queryByText('elsewhere')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('group-by menu behaves', () => {
    mount(...projectData())
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
    const { sessions } = mount(...projectData())
    act(() => {
      sessions.update((draft) => {
        draft.ids.push(sid('fresh'))
        draft.byId[sid('fresh')] = summary({ id: 'fresh', title: 'brand new', cwd: '/fresh', updatedAt: 99 })
      })
    })
    // Store notifications are microtask-batched.
    await flush()
    expect(screen.getByText('fresh')).toBeTruthy()
  })

  it('row "More" anchors swallow the click without opening or toggling', () => {
    const { onOpen } = mount(...projectData())
    act(() => { fireEvent.click(screen.getByText('proj')) })
    // Project-row anchor: must not collapse the project (rows stay visible).
    act(() => { fireEvent.click(screen.getAllByLabelText('More')[0]!) })
    expect(screen.getByText('root work')).toBeTruthy()
    // Session-row anchor: must not open the session.
    act(() => { fireEvent.click(screen.getAllByLabelText('More')[1]!) })
    expect(onOpen).not.toHaveBeenCalled()
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
