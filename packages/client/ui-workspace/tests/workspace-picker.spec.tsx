// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceCreateError } from '@deepseek-ai/dsh-client-runtime/client'
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
  ids: [], byId: {}, current: undefined, phase: 'ready',
}
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, state: 'idle', phase: 'ready', error: null, baselinesReady: true,
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

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  pickDirectory = vi.fn(async () => null as string | null),
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useWorkspaces={hook(workspaceState(nextItems))}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      pickDirectory={pickDirectory}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, pickDirectory,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseItem(name: 'Open local folder…' | 'Create a new workspace'): void {
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
    chooseItem('Create a new workspace')
    const input = screen.getByLabelText('New workspace name')
    fireEvent.change(input, { target: { value: 'project-one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(createWorkspace).toHaveBeenCalledWith({ name: 'project-one' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
  })

  it('opens a native directory picker, adopts its path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const pickDirectory = vi.fn(async () => '/tmp/project')
    const b = mount([], createWorkspace, pickDirectory)
    chooseItem('Open local folder…')
    expect(pickDirectory).toHaveBeenCalledOnce()
    await waitFor(() => { expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' }) })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
  })

  it('treats native picker cancellation as a silent no-op', async () => {
    const b = mount([], vi.fn(), vi.fn(async () => null))
    chooseItem('Open local folder…')
    await waitFor(() => { expect(b.pickDirectory).toHaveBeenCalledOnce() })
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a name conflict and retries through the native picker', async () => {
    const pickDirectory = vi.fn()
      .mockResolvedValueOnce('/one/project')
      .mockResolvedValueOnce(null)
    const createWorkspace = vi.fn(async () => {
      throw new WorkspaceCreateError({
        code: 'workspace-name-conflict', message: 'project already exists', details: { name: 'project' },
      })
    })
    const b = mount([], createWorkspace, pickDirectory)
    chooseItem('Open local folder…')
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'A workspace with this name already exists' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('Choose a folder with a different name.')
    fireEvent.click(screen.getByRole('button', { name: 'Choose again' }))
    await waitFor(() => { expect(pickDirectory).toHaveBeenCalledTimes(2) })
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables the folder action while the native picker is already open', async () => {
    let resolve!: (path: string | null) => void
    const pending = new Promise<string | null>((settle) => { resolve = settle })
    const b = mount([], vi.fn(), vi.fn(() => pending))
    chooseItem('Open local folder…')
    expect((screen.getByRole('menuitem', { name: 'Open local folder…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Create a new workspace' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open local folder…' }))
    expect(b.pickDirectory).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(null); await pending })
  })

  it('reports non-Error native picker failures', async () => {
    const b = mount([], vi.fn(), vi.fn(async () => { throw 'picker unavailable' }))
    chooseItem('Open local folder…')
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('picker unavailable')
    })
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes a creation modal when the user cancels', () => {
    mount([])
    chooseItem('Create a new workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks a create-new name already present in the Workspace list', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseItem('Create a new workspace')
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: ' Alpha ' } })
    expect(screen.getByRole('alert').textContent).toBe('A workspace named “Alpha” already exists.')
    expect((screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('New workspace name'), { key: 'Enter' })
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('does not flash a duplicate alert when the successful create frame arrives before its unary response', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('fresh', 'same-name')
    const b = mount([], vi.fn(() => pending))
    chooseItem('Create a new workspace')
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'same-name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))

    b.rerenderItems([created])
    expect(screen.getByRole('status').textContent).toBe('Creating workspace…')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { resolve(created); await pending })
    expect(b.onPick).toHaveBeenCalledWith(created.workspaceId)
  })

  it('exposes creation phase and error text while retaining the modal for retry', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<WorkspaceView>((_resolve, rejectPromise) => { reject = rejectPromise })
    const createWorkspace = vi.fn(() => pending)
    const b = mount([], createWorkspace)
    chooseItem('Create a new workspace')
    const input = screen.getByLabelText('New workspace name')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.change(input, { target: { value: 'broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(screen.getByRole('status').textContent).toBe('Creating workspace…')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(createWorkspace).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { reject(new Error('disk unavailable')); await pending.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toBe('Workspace creation failed: disk unavailable')
    expect(b.view.getByRole('dialog')).toBeTruthy()
  })

  it('reports non-Error creation failures', async () => {
    const b = mount([], vi.fn(async () => { throw 'permission denied' }))
    chooseItem('Create a new workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Workspace creation failed: permission denied')
    })
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([]))}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()} pickDirectory={vi.fn()}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows list loading through a stable status surface', () => {
    const state: WorkspaceListState = {
      ...workspaceState([]), phase: 'pending', state: 'loading', baselinesReady: false,
    }
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()} pickDirectory={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Loading workspaces…')
  })
})
