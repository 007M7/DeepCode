// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})
const sessionState = (items: readonly SessionSummary[], overrides: Partial<SessionListState> = {}): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  ...overrides,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '' } })
  fireEvent(row, event)
}

function mount(overrides: Partial<WorkspaceBrowserProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([])),
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    pickDirectory: vi.fn(async () => null),
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { view, props, store }
}

/** Re-render with (possibly) changed props — WorkspaceBrowser has no side channel. */
function rerender(b: ReturnType<typeof mount>, overrides: Partial<WorkspaceBrowserProps>) {
  Object.assign(b.props, overrides)
  b.view.rerender(<WorkspaceBrowser {...b.props} />)
}

describe('WorkspaceBrowser', () => {
  it('renders the grouped tree by default and switches to the flat list via Group by', () => {
    const sessions = sessionState([summary('alpha-s', 2), summary('beta-s', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s']), workspace('beta', ['beta-s'])])),
    })
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    // Sessions hidden while their group is folded.
    expect(screen.queryByText('alpha-s')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Group by' }))
    expect(screen.getByText('Group by')).toBeTruthy() // the menu heading label
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    // Store-driven flip: title changes, rows flatten newest-first, headers gone.
    expect(b.store.getSnapshot().groupBy).toBe('flat')
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.getByText('beta-s')).toBeTruthy()

    // Back to workspace grouping through the same menu.
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'WorkSpace' }))
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('Workspaces')).toBeTruthy()

    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
  })

  it('expands a group on click and opens a session row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha-s'))
    expect(open).toHaveBeenCalledWith(sid('alpha-s'))
    // Collapse hides the row again.
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-s')).toBeNull()
  })

  it('unfolds a session subtree through the row twist', () => {
    const parent = summary('parent-s', 2)
    const child = { ...summary('child-s', 1), parentId: parent.id }
    mount({
      useSessions: hook(sessionState([parent, child])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['parent-s', 'child-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('child-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByText('child-s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByText('child-s')).toBeNull()
  })

  it('auto-expands the selected session group and starts a session from the group ＋', () => {
    const startSession = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)], { current: sid('alpha-s') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      startSession,
    })
    // The current-group effect expanded the owning group without a click.
    expect(screen.getByText('alpha-s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New session in alpha' }))
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
  })

  it('auto-expands the Ungrouped bucket for a loose current session; its header has no menu and its ＋ is inert', () => {
    const startSession = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      startSession,
    })
    // The loose session's group is UNGROUPED_KEY: expanded by the effect.
    expect(screen.getByText('loose')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Workspace actions for Ungrouped' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New session in Ungrouped' }))
    expect(startSession).not.toHaveBeenCalled()
  })

  it('keeps an already-expanded group when the selection moves within it', () => {
    const first = sessionState([summary('a', 2), summary('b', 1)], { current: sid('a') })
    const b = mount({
      useSessions: hook(first),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a', 'b'])])),
    })
    expect(screen.getByText('a')).toBeTruthy()
    // Selection hop inside the same group: the effect re-runs and leaves the
    // expansion list unchanged (no duplicate key, group still open).
    rerender(b, { useSessions: hook({ ...first, current: sid('b') }) })
    expect(screen.getByText('b')).toBeTruthy()
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('b')).toBeNull()
  })

  it('shows only the current blank session as New Session in grouped, flat, and search modes', () => {
    const currentBlank = summary('alpha-blank', 9, { blank: true })
    const staleBlank = summary('beta-blank', 8, { blank: true })
    const sessions = sessionState(
      [currentBlank, staleBlank],
      { current: currentBlank.id },
    )
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-blank']), workspace('beta', ['beta-blank']),
      ])),
    })
    expect(screen.getByText('New Session')).toBeTruthy()
    expect(screen.queryByText('alpha-blank')).toBeNull()
    expect(screen.queryByText('beta-blank')).toBeNull()
    expect(screen.getByText('1 session')).toBeTruthy()

    rerender(b, { useSessions: hook({ ...sessions, current: staleBlank.id }) })
    expect(screen.getAllByText('New Session')).toHaveLength(1)
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getAllByText('New Session')).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText('Search name, keywords...'), { target: { value: 'new session' } })
    expect(screen.getAllByText('New Session')).toHaveLength(1)
  })

  it('searches across groups, clears via the clear button, and shows the empty states', () => {
    const sessions = sessionState([
      summary('needle-row', 2, { displayTitle: 'Needle row' }),
      summary('other-row', 1, { displayTitle: 'Other row' }),
    ])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-row', 'other-row'])])),
    })
    const input = screen.getByPlaceholderText<HTMLInputElement>('Search name, keywords...')
    fireEvent.change(input, { target: { value: 'needle' } })
    // Search forces matches visible without expansion state.
    expect(screen.getByText('Needle row')).toBeTruthy()
    expect(screen.queryByText('Other row')).toBeNull()
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByText('No matches')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(input.value).toBe('')
    // Clicking the field row focuses the input (wide mode).
    fireEvent.click(input.parentElement as HTMLElement)
    expect(document.activeElement).toBe(input)
  })

  it('shows the no-sessions empty state in both modes', () => {
    const b = mount()
    expect(screen.getByText('No sessions yet')).toBeTruthy()
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getByText('No sessions yet')).toBeTruthy()
    // Flat search misses show No matches.
    fireEvent.change(screen.getByPlaceholderText('Search name, keywords...'), { target: { value: 'x' } })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('rail state renders icon controls that request expansion', () => {
    vi.useFakeTimers()
    try {
      const expandSidebar = vi.fn()
      const b = mount({ wide: false, expandSidebar })
      // No wide chrome in rail state.
      expect(screen.queryByText('Workspaces')).toBeNull()
      expect(screen.queryByPlaceholderText('Search name, keywords...')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
      // The wide flip mounts the input and focuses it after the slide.
      rerender(b, { wide: true })
      const input = screen.getByPlaceholderText('Search name, keywords...')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(input)
      // Wide search button is decorative (tabIndex -1, no expand call).
      fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail create-workspace expands the shell and opens the picker; wide toggles in place', () => {
    const expandSidebar = vi.fn()
    const b = mount({ wide: false, expandSidebar, useWorkspaces: hook(workspaceState([workspace('alpha', [])])) })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(expandSidebar).toHaveBeenCalledTimes(1)
    rerender(b, { wide: true })
    // The picker menu is open (anchored on the ＋); picking starts a session.
    fireEvent.click(screen.getByRole('menuitem', { name: 'alpha' }))
    expect(b.props.startSession).toHaveBeenCalledWith(wid('alpha'))
    expect(screen.queryByRole('menu')).toBeNull()
    // Wide toggle: open and close without expand requests.
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(expandSidebar).toHaveBeenCalledTimes(1)

    // Escape closes the picker through its own onClose.
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('drag reorder reports the anchor to insertSessionBefore and skips no-op drops', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = screen.getAllByRole('treeitem').slice(1) // drop the group header
    const [one, , three] = rows as [HTMLElement, HTMLElement, HTMLElement]
    three.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34, x: 0, y: 200, toJSON: () => ({}),
    })
    const dataTransfer = { effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(one, { dataTransfer })
    // Drop on the top half of "three": insert one before three.
    fireDrag(three, 'dragOver', 205)
    fireDrag(three, 'drop', 205)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('three'))

    // Dropping right back onto its own position is a no-op — top half
    // (anchor = itself) and bottom half (anchor = the next root) alike.
    fireEvent.dragStart(one, { dataTransfer })
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(one, 'drop', 130)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
  })

  it('still sends the reorder when the dragged row left the group mid-drag', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: { effectAllowed: '', dropEffect: '' } })
    // The host dropped "one" from the workspace account while the drag is in
    // flight: the source index is gone but the drop still resolves its anchor.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['two'])])) })
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireDrag(two, 'drop', 155)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('two'))
  })

  it('drag end without a drop clears markers; bottom-half drop appends past the last row', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    const dataTransfer = { effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragEnd(one)
    // The drag ended: rows no longer accept drops.
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).not.toHaveBeenCalled()

    // Bottom half of the last row: append (anchor omitted).
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(two, 'dragOver', 180)
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('logs and keeps the order when the reorder call rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const insertSessionBefore = vi.fn(async () => { throw new Error('stale anchor') })
      const sessions = sessionState([summary('one', 2), summary('two', 1)])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
        insertSessionBefore,
      })
      fireEvent.click(screen.getByText('alpha'))
      const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
      two.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      const dataTransfer = { effectAllowed: '', dropEffect: '' }
      fireEvent.dragStart(one, { dataTransfer })
      fireDrag(two, 'drop', 180)
      await waitFor(() => { expect(warn).toHaveBeenCalledWith('session reorder rejected:', expect.any(Error)) })
    } finally {
      warn.mockRestore()
    }
  })

  it('renames a workspace through the row menu dialog', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha'), workspace('beta', [], 'Beta')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    expect(input.value).toBe('Alpha')
    // Unchanged and blank names stay blocked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    // A duplicate of another workspace's title shows the inline conflict.
    fireEvent.change(input, { target: { value: ' Beta ' } })
    expect(screen.getByRole('alert').textContent).toBe('A workspace named “Beta” already exists.')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Gamma')
    // While renaming: input disabled, close blocked, Enter ignored.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rename via Enter, failure surfaces the error, Cancel closes', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('rename conflict') })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    // Enter with a blocked draft (unchanged) does nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Renamed')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    // The dialog stays for retry; typing clears the error; Cancel closes.
    fireEvent.change(input, { target: { value: 'Renamed2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('confirms Workspace deletion, explains retention, and blocks duplicate submission', async () => {
    let resolveDelete!: () => void
    const deleteWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    const browser = mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', ['session'], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace' })
    expect(dialog.textContent).toContain('removes “Alpha” from the workspace list')
    expect(dialog.textContent).toContain('folder and session logs will be kept')
    expect(dialog.textContent).toContain('sessions will appear under Ungrouped')

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete workspace' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledWith(wid('alpha'))
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Deleting workspace…')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    await act(async () => { resolveDelete() })
    // RPC success alone does not close: the component waits until its
    // useWorkspaces projection has committed the removal, preventing a stale
    // duplicate-name frame from leaking into the next create gesture.
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    rerender(browser, { useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('keeps the delete dialog open on failure and allows retry or cancellation', async () => {
    const deleteWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce('denied')
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('storage unavailable') })
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('Cancel, Escape, and Close dismiss deletion without calling the action', () => {
    const deleteWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    }
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(deleteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull()
  })

  it('search hides drag affordances (rows are not draggable during search)', () => {
    const sessions = sessionState([summary('needle-a', 2, { displayTitle: 'Needle A' })])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-a'])])),
    })
    fireEvent.change(screen.getByPlaceholderText('Search name, keywords...'), { target: { value: 'needle' } })
    const row = screen.getByText('Needle A').closest('[role="treeitem"]') as HTMLElement
    expect(row.getAttribute('draggable')).toBe('false')
  })
})
