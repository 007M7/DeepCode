// @vitest-environment jsdom
/**
 * Skeleton acceptance over the four-share props form: empty-state transition
 * (same InputBar component in hero position, startSession submit, in-component
 * cwd derivation), ConversationRoot view switching through the store's view
 * field, DetailsPanel selection through the shared store. Components stay
 * pure — the framework shares are stubbed (useSession/useSessions), the store
 * share is a REAL createChatStore().create() instance (same construction path
 * as production), injected callbacks are spies.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConversationSnapshot, PendingInteraction, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SelectionTarget, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
// Export discipline: packages/client/AGENTS.md.
import { createChatStore } from '../src/client/stores.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { EmptyState } from '../src/client/skeleton/EmptyState.tsx'

const sid = (s: string): SessionId => s as SessionId

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
})

/** Minimal conversation snapshot slice the skeleton reads. */
interface FakeSnapshot {
  nodes: readonly { kind: string; callId?: string; call?: { name: string; argsRaw: string } | null; content?: readonly { type: string; text?: string }[]; isError?: boolean }[]
  runningCalls: readonly { callId: string; name: string; argsRaw: string }[]
  running: boolean
  removed: boolean
  promptError: { op: 'send' | 'stop'; error: { message: string; code: string } } | null
  pending: readonly PendingInteraction[]
}

function fakeSession(init: Partial<FakeSnapshot> = {}) {
  const store = createSnapshotStore<FakeSnapshot>({
    nodes: [], runningCalls: [], running: false, removed: false, promptError: null, pending: [], ...init,
  })
  return { store, useSession: bindSnapshotSelector(store) as unknown as UseSession<ConversationSnapshot> }
}

/** Sessions-list stub: the standard useSessions hook over a snapshot store. */
function fakeSessions(rows: { id: string; title: string; cwd?: string; parentId?: string }[]) {
  const store = createSnapshotStore<SessionListState>({
    ids: rows.map(r => sid(r.id)),
    byId: Object.fromEntries(rows.map(r => [r.id, {
      id: sid(r.id), title: r.title, running: false, updatedAt: 1,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.parentId !== undefined ? { parentId: sid(r.parentId) } : {}),
    }])),
    current: undefined,
  } as SessionListState)
  return { store, useSessions: bindSnapshotSelector(store) }
}

/** SessionProvider seat stub (render-prop pass-through; ConversationRoot never invokes it). */
const SessionProviderStub: ConversationRootProps['SessionProvider'] = ({ children }) => <>{children(sid('s1'))}</>

describe('EmptyState', () => {
  it('derives cwd options from the sessions list, submits startSession, failure surfaces locally', async () => {
    const { useSessions } = fakeSessions([
      { id: 'a', title: 'a', cwd: '/w/app' },
      { id: 'b', title: 'b', cwd: '/w/lib' },
      { id: 'c', title: 'c', cwd: '/w/app' }, // duplicate cwd dedupes
    ])
    let reject!: (e: Error) => void
    const startSession = vi.fn(() => new Promise<void>((_res, rej) => { reject = rej }))
    render(<EmptyState useSessions={useSessions} startSession={startSession} />)

    const select = screen.getByRole('combobox', { name: '项目目录' })
    expect([...(select as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['', '/w/app', '/w/lib', '::new-directory'])
    fireEvent.change(select, { target: { value: '/w/app' } })
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
    const { useSessions } = fakeSessions([])
    render(<EmptyState useSessions={useSessions} startSession={() => Promise.resolve()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '::new-directory' } })
    const custom = screen.getByPlaceholderText(/目录路径/)
    fireEvent.change(custom, { target: { value: '/tmp/fresh' } })
    expect((custom as HTMLInputElement).value).toBe('/tmp/fresh')
  })
})

describe('ConversationRoot', () => {
  function bench(
    tabs: ViewTab[], activeView?: string, init: Partial<FakeSnapshot> = {},
    renderSlotChain?: ConversationRootProps['renderSlotChain'],
  ) {
    const { useSession } = fakeSession({ nodes: [{ kind: 'user' }, { kind: 'user' }], ...init })
    const { useSessions } = fakeSessions([
      { id: 'root', title: 'proj' },
      { id: 's1', title: 'child', parentId: 'root' },
    ])
    const chat = createChatStore().create()
    if (activeView !== undefined) chat.actions.setView(activeView)
    const send = vi.fn()
    const stop = vi.fn()
    const open = vi.fn()
    // The renderSlot share as the outlet would bake it: renders a marker for
    // the ring key carrying the active-id filter (a Mock cannot satisfy the
    // generic method type directly — cast once at the prop seam).
    const renderSlot = vi.fn((key: string, _owner: object, opts?: { only?: string }) => (
      <div data-testid={`view-${opts?.only ?? '(all)'}`} data-slot={key} />
    ))
    const ui = render(
      <ConversationRoot
        sessionId={sid('s1')}
        useSession={useSession}
        useSessions={useSessions}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        renderSlot={renderSlot as unknown as ConversationRootProps['renderSlot']}
        renderSlotChain={renderSlotChain ?? ((_key, _owner, opts) => opts?.fallback ?? null)}
        SessionProvider={SessionProviderStub}
        views={{
          list: () => tabs,
          subscribe: () => () => {},
          version: () => 1,
        }}
        send={send}
        stop={stop}
        open={open}
      />)
    return { ui, chat, send, stop, open, renderSlot }
  }

  const tab = (id: string, label: string): ViewTab => ({ id, label })

  it('renders breadcrumb chain (useSessions-derived), meta turns, and the default chat view', () => {
    const { open } = bench([tab('chat', 'Chat'), tab('trajectory', 'Trajectory')])
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('child')).toBeTruthy()
    expect(screen.getByText(/2 turns/)).toBeTruthy()
    expect(screen.getByTestId('view-chat')).toBeTruthy()
    // Ancestor crumb navigates; current crumb is disabled.
    fireEvent.click(screen.getByRole('button', { name: 'proj' }))
    expect(open).toHaveBeenCalledWith('root')
    expect((screen.getByRole('button', { name: 'child' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('switches views through the store view field and falls back on unknown ids', () => {
    const { chat } = bench([tab('chat', 'Chat'), tab('trajectory', 'Trajectory')])
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    expect(chat.store.getSnapshot().view).toBe('trajectory')
    expect(screen.getByTestId('view-trajectory')).toBeTruthy()
    cleanup()
    // A stale persisted id (its view plugin unloaded) falls to the first view.
    bench([tab('chat', 'Chat'), tab('trajectory', 'Trajectory')], 'ghost-view')
    expect(screen.getByTestId('view-chat')).toBeTruthy()
  })

  it('renders the active view through the declared ring slot with the only filter', () => {
    const { renderSlot } = bench([tab('chat', 'Chat')])
    // No owner share: views take everything from the standard kit (contract).
    expect(renderSlot).toHaveBeenCalledWith('conversation.view', {}, { only: 'chat' })
    expect(screen.getByTestId('view-chat').getAttribute('data-slot')).toBe('conversation.view')
  })

  it('hides the tab strip with a single view; composer writes the store draft and sends it', () => {
    const { chat, send } = bench([tab('chat', 'Chat')])
    expect(screen.queryByRole('tablist')).toBeNull()
    const box = screen.getByPlaceholderText(/输入消息/)
    fireEvent.change(box, { target: { value: 'hi' } })
    // Typing goes through actions.setDraft into the shared store.
    expect(chat.store.getSnapshot().draft).toBe('hi')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('hi', 'queue')
  })

  it('dispatches the pending list to the composer chain; all-decline falls back to InputBar', () => {
    const wait = new PendingWait('question', RpcId('rq'), sid('s1'),
      { questions: [{ id: 'mode', question: 'Choose?', options: [{ label: 'Fast' }] }] } as PendingWait<'question'>['payload'], vi.fn())
    // A matching entry takes the composer over.
    const renderSlotChain = vi.fn(() => <div>question takeover</div>) as unknown as ConversationRootProps['renderSlotChain']
    bench([tab('chat', 'Chat')], undefined, { pending: [wait] }, renderSlotChain)
    expect(screen.getByText('question takeover')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/输入消息/)).toBeNull()
    // The owner dispatches the raw pending list (chain currency); routing
    // lives in entry selectors, not here.
    expect(renderSlotChain).toHaveBeenCalledWith(
      'conversation.composer',
      expect.objectContaining({
        interactions: expect.arrayContaining([expect.objectContaining({ key: 'q:rq' })]),
      }),
      expect.objectContaining({ fallback: expect.anything() }),
    )
    cleanup()
    // Zero registered entries (default all-decline stub): the fallback IS the
    // default InputBar — behavior equals the pre-chain composer.
    bench([tab('chat', 'Chat')], undefined, { pending: [wait] })
    expect(screen.getByPlaceholderText(/输入消息/)).toBeTruthy()
  })
})

describe('DetailsPanel', () => {
  function benchDetails(snapshot: Partial<FakeSnapshot>, selection: SelectionTarget | null) {
    const { useSession } = fakeSession(snapshot)
    const { useSessions } = fakeSessions([])
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const closeDetails = vi.fn()
    render(
      <DetailsPanel
        sessionId={sid('s1')}
        useSession={useSession}
        useSessions={useSessions}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={closeDetails}
      />)
    return { closeDetails, chat }
  }

  it('renders the selected call args and result off the shared store; close fires the injected callback', () => {
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
