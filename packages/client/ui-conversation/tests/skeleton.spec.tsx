// @vitest-environment jsdom
/**
 * Skeleton acceptance: empty-state transition (same InputBar component in
 * hero position, startSession submit), ConversationRoot view switching over
 * the registry face, DetailsPanel open/close linkage against a layout-shaped
 * fake. Components stay framework-free — everything arrives via props here,
 * exactly as the inject factories will assemble them.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import { bindSnapshotSelector, createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ConversationRoot, DetailsPanel, EmptyState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SelectionTarget, ViewEntry, ViewId } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string): SessionId => s as SessionId

afterEach(cleanup)

/** Minimal conversation snapshot slice the skeleton reads. */
interface FakeSnapshot {
  nodes: readonly { kind: string; callId?: string; call?: { name: string; argsRaw: string } | null; content?: readonly { type: string; text?: string }[]; isError?: boolean }[]
  runningCalls: readonly { callId: string; name: string; argsRaw: string }[]
  running: boolean
  removed: boolean
  promptError: { op: 'send' | 'stop'; error: { message: string; code: string } } | null
}

function fakeSession(init: Partial<FakeSnapshot> = {}) {
  const store = createSnapshotStore<FakeSnapshot>({
    nodes: [], runningCalls: [], running: false, removed: false, promptError: null, ...init,
  })
  return { store, useSession: bindSnapshotSelector(store) as unknown as UseSession }
}

describe('EmptyState', () => {
  it('submits startSession with the typed text and picked cwd; failure surfaces locally', async () => {
    const cwds = createSnapshotStore<readonly string[]>(['/w/app', '/w/lib'])
    let reject!: (e: Error) => void
    const startSession = vi.fn(() => new Promise<void>((_res, rej) => { reject = rej }))
    render(<EmptyState useCwds={cwds.useSelector} actions={{ startSession }} />)

    fireEvent.change(screen.getByRole('combobox', { name: '项目目录' }), { target: { value: '/w/app' } })
    const box = screen.getByPlaceholderText('Message to run task, plan and build')
    fireEvent.change(box, { target: { value: '造一个轮子' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(startSession).toHaveBeenCalledWith({ text: '造一个轮子', mode: 'queue', cwd: '/w/app' })

    reject(new Error('后端拒收'))
    expect(await screen.findByText(/后端拒收/)).toBeTruthy()
    // Draft survives the failure for retry.
    expect((box as HTMLTextAreaElement).value).toBe('造一个轮子')
  })

  it('new-directory option swaps the select for a free-form input', () => {
    const cwds = createSnapshotStore<readonly string[]>([])
    render(<EmptyState useCwds={cwds.useSelector} actions={{ startSession: () => Promise.resolve() }} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '::new-directory' } })
    const custom = screen.getByPlaceholderText(/目录路径/)
    fireEvent.change(custom, { target: { value: '/tmp/fresh' } })
    expect((custom as HTMLInputElement).value).toBe('/tmp/fresh')
  })
})

describe('ConversationRoot', () => {
  function bench(views: ViewEntry[], active?: string) {
    const { useSession } = fakeSession({ nodes: [{ kind: 'user' }, { kind: 'user' }] })
    const activeStore = createSnapshotStore<string | undefined>(active)
    const openView = vi.fn((v: string) => { activeStore.set(v) })
    const open = vi.fn()
    const drafts = createSnapshotStore<string>('')
    const send = vi.fn()
    const stop = vi.fn()
    const ancestry: SessionSummary[] = [
      { id: sid('root'), title: 'proj', running: false, updatedAt: 1 },
      { id: sid('s1'), title: 'child', running: false, updatedAt: 1, parentId: sid('root') },
    ]
    const rendered: string[] = []
    const ui = render(
      <ConversationRoot
        sessionId={sid('s1')}
        useSession={useSession}
        useAncestry={() => ancestry}
        views={{
          list: () => views,
          subscribe: () => () => {},
          version: () => 1,
        }}
        useActiveView={() => activeStore.useSelector(s => s) as ViewId | undefined}
        composer={{
          useDraft: () => drafts.useSelector(s => s),
          setDraft: (t) => { drafts.set(t) },
          send, stop,
        }}
        actions={{ openView: openView as (v: never) => void, open }}
        renderView={(entry) => { rendered.push(entry.id); return <div data-testid={`view-${entry.id}`} /> }}
      />)
    return { ui, openView, open, rendered, send, drafts }
  }

  const comp = (() => null) as unknown as FC<never>
  const view = (id: string, label: string): ViewEntry =>
    ({ id, label, component: comp }) as unknown as ViewEntry

  it('renders breadcrumb chain, meta turns, and the active view (default chat)', () => {
    const { rendered, open } = bench([view('chat', 'Chat'), view('trajectory', 'Trajectory')])
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('child')).toBeTruthy()
    expect(screen.getByText(/2 turns/)).toBeTruthy()
    expect(rendered).toEqual(['chat'])
    // Ancestor crumb navigates; current crumb is disabled.
    fireEvent.click(screen.getByRole('button', { name: 'proj' }))
    expect(open).toHaveBeenCalledWith('root')
    expect((screen.getByRole('button', { name: 'child' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('switches views through actions.openView and re-renders the new body', () => {
    const { openView } = bench([view('chat', 'Chat'), view('trajectory', 'Trajectory')])
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    expect(openView).toHaveBeenCalledWith('trajectory')
    expect(screen.getByTestId('view-trajectory')).toBeTruthy()
  })

  it('hides the tab strip with a single view and wires the composer send', () => {
    const { send } = bench([view('chat', 'Chat')])
    expect(screen.queryByRole('tablist')).toBeNull()
    const box = screen.getByPlaceholderText(/输入消息/)
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('queue')
  })
})

describe('DetailsPanel', () => {
  function benchDetails(snapshot: Partial<FakeSnapshot>, selection: SelectionTarget | null) {
    const { useSession } = fakeSession(snapshot)
    const selectionStore = createSnapshotStore<SelectionTarget | null>(selection)
    const closeDetails = vi.fn()
    render(
      <DetailsPanel
        sessionId={sid('s1')}
        useSession={useSession}
        useSelection={selectionStore.useSelector}
        actions={{ closeDetails }}
      />)
    return { closeDetails, selectionStore }
  }

  it('renders the selected call args and result; close fires the layout-linked action', () => {
    const { closeDetails } = benchDetails({
      nodes: [{
        kind: 'tool-result', callId: 'c1',
        call: { name: 'bash', argsRaw: '{"cmd":"ls"}' },
        content: [{ type: 'text', text: 'file-a\nfile-b' }],
        isError: false,
      }],
    }, { turnSeq: 1, callId: 'c1' })
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText(/"cmd": "ls"/)).toBeTruthy()
    expect(screen.getByText(/file-a/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(closeDetails).toHaveBeenCalledTimes(1)
  })

  it('shows the empty hint without a selection and the running state for open calls', () => {
    benchDetails({ runningCalls: [{ callId: 'c9', name: 'bash', argsRaw: '{}' }] }, null)
    expect(screen.getByText(/点击消息流中的工具行/)).toBeTruthy()
    cleanup()
    benchDetails({ runningCalls: [{ callId: 'c9', name: 'bash', argsRaw: '{}' }] }, { turnSeq: 1, callId: 'c9' })
    expect(screen.getByText('运行中…')).toBeTruthy()
  })

  it('reports an out-of-window call distinctly', () => {
    benchDetails({}, { turnSeq: 1, callId: 'ghost' })
    expect(screen.getByText(/不在当前窗口内/)).toBeTruthy()
  })
})
