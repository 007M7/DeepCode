// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'

afterEach(cleanup)
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
})
