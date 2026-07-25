// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

afterEach(cleanup)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
const hook = <T,>(snapshot: T) => <S,>(selector: (state: T) => S): S => selector(snapshot)
const sessions: SessionListState = {
  ids: [], byId: {}, current: undefined, intent: undefined, phase: 'ready',
}
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, intent: undefined, state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

function mount(items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')], createWorkspace = vi.fn()) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <WorkspacePicker
      open
      anchorRef={anchor()}
      useSessions={hook(sessions)}
      useWorkspaces={hook(workspaceState(items))}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
    />,
  )
  return { view, onPick, onClose, createWorkspace }
}

function chooseCreateItem(name: 'Use an existing folder' | 'Create a new workspace'): void {
  const parent = screen.getByRole('menuitem', { name: 'Create workspace' })
  fireEvent.mouseEnter(parent.parentElement as HTMLElement)
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

describe('WorkspacePicker', () => {
  it('lists real Workspaces from useWorkspaces and forwards a selected id', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('alpha'))
  })

  it('creates a real Workspace from a name and focuses its frontend Session target', async () => {
    const created = workspace('new', 'New')
    const createWorkspace = vi.fn(async () => created)
    const b = mount([], createWorkspace)
    chooseCreateItem('Create a new workspace')
    const input = screen.getByLabelText('New workspace name')
    fireEvent.change(input, { target: { value: 'project-one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(createWorkspace).toHaveBeenCalledWith({ name: 'project-one' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
  })

  it('adopts an existing path through the same immediate create action', async () => {
    const created = workspace('adopted')
    const createWorkspace = vi.fn(async () => created)
    const b = mount([], createWorkspace)
    chooseCreateItem('Use an existing folder')
    fireEvent.change(screen.getByLabelText('Existing folder path'), { target: { value: ' /tmp/project ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }))
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
  })

  it('blocks a create-new name already present in the Workspace list', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseCreateItem('Create a new workspace')
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: ' Alpha ' } })
    expect(screen.getByRole('alert').textContent).toBe('A workspace named “Alpha” already exists.')
    expect((screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('New workspace name'), { key: 'Enter' })
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('exposes creation phase and error text while retaining the modal for retry', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<WorkspaceView>((_resolve, rejectPromise) => { reject = rejectPromise })
    const b = mount([], vi.fn(() => pending))
    chooseCreateItem('Create a new workspace')
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(screen.getByRole('status').textContent).toBe('Creating workspace…')
    await act(async () => { reject(new Error('disk unavailable')); await pending.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toBe('Workspace creation failed: disk unavailable')
    expect(b.view.getByRole('dialog')).toBeTruthy()
  })

  it('shows list loading through a stable status surface', () => {
    const state: WorkspaceListState = {
      ...workspaceState([]), phase: 'pending', state: 'loading', baselinesReady: false,
    }
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Loading workspaces…')
  })
})
