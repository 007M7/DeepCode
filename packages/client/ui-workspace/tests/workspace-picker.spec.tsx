// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceCreateError } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
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

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const { probe, renderSlot } = flowProbe()
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useWorkspaces={hook(workspaceState(nextItems))}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, probe, occupancy,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseItem(name: '打开本地文件夹…' | '新建工作区'): void {
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
    chooseItem('新建工作区')
    const input = screen.getByLabelText('新工作区名称')
    fireEvent.change(input, { target: { value: 'project-one' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    expect(createWorkspace).toHaveBeenCalledWith({ name: 'project-one' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
  })

  it('opens the composed directory flow, adopts its picked path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const b = mount([], createWorkspace)
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    chooseItem('打开本地文件夹…')
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    await act(async () => { b.probe.owner!.onPicked('/tmp/project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    // Successful adoption withdraws the flow request.
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('treats flow cancellation as a silent no-op', () => {
    const b = mount([])
    chooseItem('打开本地文件夹…')
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a name conflict and retries by reopening the flow', async () => {
    const createWorkspace = vi.fn(async () => {
      throw new WorkspaceCreateError({
        code: 'workspace-name-conflict', message: 'project already exists', details: { name: 'project' },
      })
    })
    const b = mount([], createWorkspace)
    chooseItem('打开本地文件夹…')
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '已存在同名工作区' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('请选择其他名称的文件夹。')
    // The failed adoption withdrew the flow; Choose again reopens it.
    expect(b.probe.owner!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(b.probe.owner!.open).toBe(true)
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables every menu action from flow open through adoption, and reports busy to the flow', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseItem('打开本地文件夹…')
    // The flow is open but nothing is picked yet: a chooser pending on the
    // host display must already block concurrent workspace actions.
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '新建工作区' }).disabled).toBe(true)
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '打开本地文件夹…' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '新建工作区' }).disabled).toBe(true)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('shows the flow-reported failure in the folder-error surface', () => {
    const b = mount([])
    chooseItem('打开本地文件夹…')
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes a creation modal when the user cancels', () => {
    mount([])
    chooseItem('新建工作区')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks a create-new name already present in the Workspace list', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseItem('新建工作区')
    fireEvent.change(screen.getByLabelText('新工作区名称'), { target: { value: ' Alpha ' } })
    expect(screen.getByRole('alert').textContent).toBe('已存在名为“Alpha”的工作区。')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建工作区' }).disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('新工作区名称'), { key: 'Enter' })
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('does not flash a duplicate alert when the successful create frame arrives before its unary response', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('fresh', 'same-name')
    const b = mount([], vi.fn(() => pending))
    chooseItem('新建工作区')
    fireEvent.change(screen.getByLabelText('新工作区名称'), { target: { value: 'same-name' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))

    b.rerenderItems([created])
    expect(screen.getByRole('status').textContent).toBe('正在创建工作区…')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { resolve(created); await pending })
    expect(b.onPick).toHaveBeenCalledWith(created.workspaceId)
  })

  it('exposes creation phase and error text while retaining the modal for retry', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<WorkspaceView>((_resolve, rejectPromise) => { reject = rejectPromise })
    const createWorkspace = vi.fn(() => pending)
    const b = mount([], createWorkspace)
    chooseItem('新建工作区')
    const input = screen.getByLabelText('新工作区名称')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.change(input, { target: { value: 'broken' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    expect(screen.getByRole('status').textContent).toBe('正在创建工作区…')
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
    chooseItem('新建工作区')
    // The name field starts empty (no prefill); a name is required to submit.
    fireEvent.change(screen.getByLabelText('新工作区名称'), { target: { value: 'broken' } })
    fireEvent.click(screen.getByRole('button', { name: '创建工作区' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Workspace creation failed: permission denied')
    })
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([]))}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows list loading through a stable status surface', () => {
    const state: WorkspaceListState = {
      ...workspaceState([]), phase: 'pending', state: 'loading', baselinesReady: false,
    }
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('正在加载工作区…')
  })

  it('hides the folder entry while the directory-flow hole is empty', () => {
    mount([], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menuitem', { name: '新建工作区' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '打开本地文件夹…' })).toBeNull()
  })

  it('shows the folder entry when a flow package activates after the first paint', () => {
    const b = mount([], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '打开本地文件夹…' })).toBeNull()
    // Registration changes flow through the subscription, no re-render needed.
    act(() => { b.occupancy.flip(true) })
    expect(screen.getByRole('menuitem', { name: '打开本地文件夹…' })).toBeTruthy()
  })

  it('keeps Choose again inert while the flow occupant is gone, and snaps back a flow opened over an empty hole', async () => {
    const b = mount([], vi.fn(async () => { throw new Error('adoption failed') }))
    chooseItem('打开本地文件夹…')
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy() })
    // The occupant unloads while the error dialog is up: retrying would open
    // a flow nobody can serve or cancel, so the button goes inert.
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新选择' }).disabled).toBe(true)
    // Cancel stays the way out, and the menu actions are usable again.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '新建工作区' }).disabled).toBe(false)
  })

  it('withdraws an open flow when its occupant unloads, re-enabling the menu actions', () => {
    const b = mount([])
    chooseItem('打开本地文件夹…')
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    // The flow plugin unloads mid-interaction (HMR): nobody is left to
    // cancel, so the owner withdraws and the actions come back.
    act(() => { b.occupancy.flip(false) })
    expect(b.probe.owner!.open).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '新建工作区' }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: '打开本地文件夹…' })).toBeNull()
  })
})
