// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const hook = <T,>(snapshot: T) => <S,>(selector: (state: T) => S): S => selector(snapshot)
const workspace: WorkspaceView = {
  workspaceId: wid('project'), path: '/projects/project', title: 'Project', sessionIds: [sid('s1')],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const sessions: SessionListState = {
  ids: [sid('s1')],
  byId: { [sid('s1')]: { id: sid('s1'), displayTitle: 'First session', running: false, updatedAt: 1 } },
  current: undefined, phase: 'ready',
  intent: undefined,
}
const workspaces: WorkspaceListState = {
  items: [workspace], state: 'idle', phase: 'ready', error: null,
  intent: undefined, baselinesReady: true, recentWorkspaceId: workspace.workspaceId,
}

function mount(sessionState: SessionListState = sessions) {
  const startSession = vi.fn()
  const open = vi.fn()
  let pickerOwner: unknown
  const view = render(
    <SidebarRoot
      collapsed={false} width={300}
      useSessions={hook(sessionState)} useWorkspaces={hook(workspaces)}
      startSession={startSession} open={open} toggleSidebar={vi.fn()}
      renderSlot={((_key: string, owner: unknown) => { pickerOwner = owner; return null }) as SidebarRootComponentProps['renderSlot']}
    />,
  )
  return { view, startSession, open, pickerOwner: () => pickerOwner }
}

function mountSidebar({
  sessionState = sessions,
  workspaceState = workspaces,
  collapsed = false,
  width = 300,
}: {
  sessionState?: SessionListState
  workspaceState?: WorkspaceListState
  collapsed?: boolean
  width?: number
} = {}) {
  const startSession = vi.fn()
  const open = vi.fn()
  const toggleSidebar = vi.fn()
  let pickerOwner: unknown
  let current = { sessionState, workspaceState, collapsed, width }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      useSessions={hook(current.sessionState)} useWorkspaces={hook(current.workspaceState)}
      startSession={startSession} open={open} toggleSidebar={toggleSidebar}
      renderSlot={((_key: string, owner: unknown) => { pickerOwner = owner; return null }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    open,
    toggleSidebar,
    pickerOwner: () => pickerOwner,
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot', () => {
  it('renders real Workspaces from useWorkspaces and routes New Session', () => {
    const b = mount()
    expect(screen.getByText('Project')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(b.startSession).toHaveBeenCalledWith()
  })

  it('shows a frontend Session under its real Workspace and routes its row plus', () => {
    const intent = { sessionId: sid('intent'), target: { kind: 'workspace' as const, workspaceId: workspace.workspaceId }, prompt: '', phase: 'connecting' as const }
    const b = mount({
      ...sessions,
      current: intent.sessionId,
      intent,
    })
    expect(screen.getByText('New session')).toBeTruthy()
    expect(screen.getByText('2 sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New session in Project' }))
    expect(b.startSession).toHaveBeenCalledWith(workspace.workspaceId)
  })

  it('forwards Workspace picker selection and closes the picker', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    const owner = b.pickerOwner() as { open: boolean; onPick(id: WorkspaceId): void }
    expect(owner.open).toBe(true)
    owner.onPick(workspace.workspaceId)
    expect(b.startSession).toHaveBeenCalledWith(workspace.workspaceId)
  })

  it('opens a real Session through the owner action', () => {
    const b = mount({ ...sessions, current: sid('intent'), intent: {
      sessionId: sid('intent'), target: { kind: 'workspace', workspaceId: workspace.workspaceId }, prompt: '', phase: 'ready',
    } })
    fireEvent.click(screen.getByText('Project'))
    fireEvent.click(screen.getByText('First session'))
    expect(b.open).toHaveBeenCalledWith(sid('s1'))
  })

  it('opens, selects, dismisses, and toggles the group-by menu', () => {
    mount()
    const button = screen.getByRole('button', { name: 'Group by' })

    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('routes every Workspace picker close path', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    const owner = b.pickerOwner() as { open: boolean; onClose(): void }
    expect(owner.open).toBe(true)
    act(() => { owner.onClose() })
    expect((b.pickerOwner() as { open: boolean }).open).toBe(false)
  })

  it('focuses, filters, and clears search while distinguishing both empty states', () => {
    mount()
    const input = screen.getByPlaceholderText('Search name, keywords...')
    fireEvent.click(input.parentElement!)
    expect(document.activeElement).toBe(input)
    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))

    fireEvent.change(input, { target: { value: 'missing' } })
    expect(screen.getByText('No matches')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.queryByText('No matches')).toBeNull()

    cleanup()
    const emptySessions = listState()
    const emptyWorkspaces: WorkspaceListState = { ...workspaces, items: [], recentWorkspaceId: undefined }
    mountSidebar({ sessionState: emptySessions, workspaceState: emptyWorkspaces })
    expect(screen.getByText('No sessions yet')).toBeTruthy()
  })

  it('toggles Workspace and nested Session expansion in both directions', () => {
    const parent = sid('parent')
    const child = sid('child')
    const nestedSessions: SessionListState = {
      ...sessions,
      ids: [parent, child],
      byId: {
        [parent]: { id: parent, displayTitle: 'Parent', running: false, updatedAt: 2 },
        [child]: { id: child, displayTitle: 'Child', running: false, updatedAt: 1, parentId: parent },
      },
    }
    const nestedWorkspace: WorkspaceListState = {
      ...workspaces,
      items: [{ ...workspace, sessionIds: [parent, child] }],
    }
    mountSidebar({ sessionState: nestedSessions, workspaceState: nestedWorkspace })

    fireEvent.click(screen.getByText('Project'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByText('Child')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByText('Child')).toBeNull()
    fireEvent.click(screen.getByText('Project'))
    expect(screen.queryByText('Parent')).toBeNull()
  })

  it('does not start a Session from an Ungrouped row create action', () => {
    const loose = sid('loose')
    const looseSessions: SessionListState = {
      ...listState(),
      ids: [loose],
      byId: { [loose]: { id: loose, displayTitle: 'Loose', running: false, updatedAt: 1 } },
      current: loose,
    }
    const b = mountSidebar({
      sessionState: looseSessions,
      workspaceState: { ...workspaces, items: [], recentWorkspaceId: undefined },
    })
    fireEvent.click(screen.getByRole('button', { name: 'New session in Ungrouped' }))
    expect(b.startSession).not.toHaveBeenCalled()
  })

  it('keeps an already expanded selected Workspace open and resolves later Workspace matches', () => {
    const b = mountSidebar()
    fireEvent.click(screen.getByText('Project'))
    const other = { ...workspace, workspaceId: wid('other'), title: 'Other', sessionIds: [] }
    b.rerender({
      sessionState: { ...sessions, current: sid('s1') },
      workspaceState: { ...workspaces, items: [other, workspace] },
    })
    expect(screen.getByText('First session')).toBeTruthy()

    b.rerender({
      sessionState: {
        ...sessions,
        current: sid('draft'),
        intent: { sessionId: sid('draft'), target: { kind: 'workspace-intent' }, prompt: '', phase: 'ready' },
      },
    })
    expect(screen.getByText('Project')).toBeTruthy()
  })

  it('renders the static collapsed rail and expands rail search into focused input', () => {
    vi.useFakeTimers()
    const b = mountSidebar({ collapsed: true })
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('Search name, keywords...')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
    expect(b.toggleSidebar).toHaveBeenCalledTimes(2)
    b.rerender({ collapsed: false })
    const input = screen.getByPlaceholderText('Search name, keywords...')
    act(() => { vi.advanceTimersByTime(300) })
    expect(document.activeElement).toBe(input)
  })

  it('keeps wide content during live collapse, then settles to the rail', () => {
    vi.useFakeTimers()
    const b = mountSidebar({ width: 320 })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    b.rerender({ collapsed: true, width: 56 })
    expect(screen.getByPlaceholderText('Search name, keywords...')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByPlaceholderText('Search name, keywords...')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })
})

function listState(): SessionListState {
  return { ids: [], byId: {}, current: undefined, phase: 'ready', intent: undefined }
}
