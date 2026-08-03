// @vitest-environment jsdom
// ChatView behavior: flow derivation, streaming isolation (Profiler counts),
// toolview dispatch and selection handoff — driven through a scripted
// ObservableSnapshot fake, no wire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type {
  AssistantMessageNode, CommandNode, ConversationNode, ConversationSnapshot,
  ModelRetryNode, RunningToolCall, SessionId, SessionListState, ToolResultNode, TurnErrorNode,
  UserMessageNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore, PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { ChatViewSlotProps, SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { zh } from '../src/client/locales.ts'
import { assistantActionsSeqs, deriveChatFlow, flowKeys } from '../src/client/chat/chat-flow.ts'

afterEach(cleanup)
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Scripted snapshot source: set() swaps the top-level object like the real Session. */
function makeSource(init?: Partial<ConversationSnapshot>) {
  let snap: ConversationSnapshot = { ...snapshotBase(), ...init }
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<ConversationSnapshot>) => {
      snap = { ...snap, ...next }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user',
  seq,
  time: seq * 1000,
  content: [{ type: 'text', text }] as never,
  source: null,
})
const assistant = (seq: number, text: string, turn = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: 1, blocks: [{ kind: 'text', text }],
})
const retry = (seq: number): ModelRetryNode => ({
  kind: 'model-retry', seq, time: seq * 1_000, turn: 1, step: 0,
  retryState: 'scheduled',
  provider: 'mock', mode: 'normal', policyKey: 'mock-normal',
  retry: 1, maxRetries: 2, delayMs: 450,
  failure: { code: 'TRANSPORT', message: '连接被重置' },
})
const turnError = (seq: number, code?: string): TurnErrorNode => ({
  kind: 'turn-error', seq, time: seq * 1_000, turn: 1, step: 0,
  message: seq === 2 ? 'API key is invalid' : 'plugin exploded',
  ...(code === undefined ? {} : { code }),
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null,
})
const runningCall = (callId: string, name = 'bash'): RunningToolCall => ({
  callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, callView: null,
})

/** Empty sessions-list hook for the global standard-kit seat. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function makeHarness(init?: Partial<ConversationSnapshot>) {
  const { set, source } = makeSource(init)
  const openDetails = vi.fn<(t: SelectionTarget) => void>()
  const openFile = vi.fn<(path: string) => void>()
  const loadOlder = vi.fn()
  const inspectCall = vi.fn<(callId: string) => void>()
  // In-memory scroll memory matching the apply.ts per-session map contract.
  let savedScrollTop: number | null = null
  const chatScroll = {
    save: (top: number | null) => { savedScrollTop = top },
    read: () => savedScrollTop,
  }
  const forkAt = vi.fn()
  // Selection rides the REAL chat store (same construction path as
  // production; the view reads it through the PropsStore useStore share).
  // renderSlot stub renders the render-site fallback (an empty keyed ledger:
  // every tool lands on GenericToolCard); keyed dispatch to registered rows
  // is the slot machinery's behavior, covered by its own specs.
  const chat = createChatStore().create()
  const renderSlot = ((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) =>
    opts?.fallback ?? null) as unknown as ChatViewSlotProps['renderSlot']
  // SessionProvider seat arrives with the session-scope child declaration;
  // ChatView never invokes it (render-prop pass-through stub).
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(source),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (() => undefined),
    useInput: (() => { throw new Error('unused') }),
    inputActions: { setDraft: () => {}, submit: () => {} },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    renderSlot,
    SessionProvider: SessionProviderStub,
    openDetails,
    openFile,
    loadOlder,
    inspectCall,
    chatScroll,
    forkAt,
    // Mirrors the real lookup chain (conversation namespace, then common).
    t: makeTranslate(zh, commonZh),
  }
  const setSelection = (next: SelectionTarget | null): void => { chat.actions.select(next) }
  return { set, ChatView, props, openDetails, openFile, loadOlder, inspectCall, chatScroll, forkAt, setSelection }
}

describe('chat-flow derivation', () => {
  it('groups consecutive tool results and keeps stable keys', () => {
    const nodes: ConversationNode[] = [
      user(1, 'hi'), assistant(2, 'let me look'), toolResult(3, 'a'), toolResult(4, 'b'),
      assistant(5, 'found'), toolResult(6, 'c'),
    ]
    const items = deriveChatFlow(nodes)
    expect(items.map(i => i.kind)).toEqual(['node', 'node', 'tool-group', 'node', 'tool-group'])
    const group = items[2]!
    expect(group.kind === 'tool-group' && group.results.map(r => r.callId)).toEqual(['a', 'b'])
    expect(flowKeys(items)).toBe('n1|n2|g3|n5|g6')
    expect(flowKeys(deriveChatFlow([...nodes, toolResult(7, 'd')]))).toBe('n1|n2|g3|n5|g6')
  })

  it('reuses one stable row for consecutive retry turns', () => {
    const first = retry(2)
    const second = { ...retry(3), turn: 2, retry: 2 }
    const initial = deriveChatFlow([user(1, 'try'), first])
    const updated = deriveChatFlow([user(1, 'try'), first, second])
    expect(flowKeys(initial)).toBe('n1|n2')
    expect(flowKeys(updated)).toBe('n1|n2')
    expect(updated).toHaveLength(2)
    expect(updated[1]?.kind === 'node' && updated[1].node).toBe(second)
  })

  it('skips render-nothing assistant nodes so tool runs stay one group', () => {
    // A tool-call-only step message (and blank text/reasoning) renders nothing:
    // it must not split the run into two groups with an empty line between.
    const headsOnly: AssistantMessageNode = {
      kind: 'assistant', seq: 4, time: 4_000, turn: 1, step: 2,
      blocks: [{ kind: 'tool-call', callId: 'b', name: 'read', argsRaw: '{}' }, { kind: 'text', text: ' \n' }, { kind: 'reasoning', text: '' }],
    }
    const items = deriveChatFlow([toolResult(3, 'a'), headsOnly, toolResult(5, 'b')])
    expect(flowKeys(items)).toBe('g3')
    const group = items[0]!
    expect(group.kind === 'tool-group' && group.results.map(r => r.callId)).toEqual(['a', 'b'])
    // Interrupted and visible-content nodes still render (已停止 marker / prose).
    expect(flowKeys(deriveChatFlow([toolResult(3, 'a'), { ...headsOnly, interrupted: true }, toolResult(5, 'b')]))).toBe('g3|n4|g5')
    expect(flowKeys(deriveChatFlow([toolResult(3, 'a'), assistant(4, 'found'), toolResult(5, 'b')]))).toBe('g3|n4|g5')
  })

  it('assistantActionsSeqs keeps only the last content assistant per turn', () => {
    const thinkOnly: AssistantMessageNode = {
      kind: 'assistant', seq: 3, time: 3_000, turn: 1, step: 2,
      blocks: [{ kind: 'reasoning', text: 'planning' }],
    }
    const seqs = assistantActionsSeqs([
      user(1, 'hi'),
      assistant(2, 'looking', 1),
      thinkOnly,
      toolResult(4, 'a'),
      assistant(5, 'done', 1),
      user(6, 'again'),
      assistant(7, 'second turn', 2),
    ])
    expect([...seqs].sort((a, b) => a - b)).toEqual([5, 7])
  })
})

describe('ChatView', () => {
  it('a windowless tool result (call head truncated) renders with an empty tool name', () => {
    const h = makeHarness({
      nodes: [{ ...toolResult(3, 'w1'), call: null }],
    })
    const view = render(<h.ChatView {...h.props} />)
    // classifyTool('') → others; the summary slot falls back to the callId.
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('w1')).toBeTruthy()
  })

  it('prepend keeps the viewport anchored when the reader is NOT at the bottom (no lastKey force)', () => {
    // Covers the prepend early-return arm where lastItem exists but the key
    // path is not taken (anchor branch wins before the appended-user check).
    const h = makeHarness({ nodes: [user(9, 'late')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    scroller.scrollTop = 50
    fireEvent.scroll(scroller)
    fireEvent.click(view.getByText('加载更早'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1300, writable: true })
    act(() => { h.set({ nodes: [assistant(2, 'older'), user(9, 'late')] }) })
    expect(scroller.scrollTop).toBe(550) // 50 + (1300 - 800)
  })

  it('renders the fixture main line: bubble, narration, grouped tool rows', () => {
    const h = makeHarness({
      nodes: [user(1, 'do the thing'), assistant(2, 'running tools'), toolResult(3, 'a'), toolResult(4, 'b')],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('do the thing')).toBeTruthy()
    expect(view.getByText('running tools')).toBeTruthy()
    expect(view.getAllByText('Bash')).toHaveLength(2)
    expect(view.getByText('run a')).toBeTruthy()
  })

  it('renders Host-pending steering at the flow tail and hands off to the durable node', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const pending = {
      id: 'steer-occurrence' as never,
      messageId: 'steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'interrupt now' }],
      preview: 'interrupt now',
      text: 'interrupt now',
    }
    const queued = {
      id: 'queued-occurrence' as never,
      messageId: 'queued-message' as never,
      placement: 'queued' as const,
      content: [{ type: 'text' as const, text: 'later' }],
      preview: 'later',
      text: 'later',
    }
    const h = makeHarness({ nodes: [assistant(1, 'working')], queue: [queued, pending], running: true })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getByText('interrupt now').closest('[data-pending-steering]')).not.toBeNull()
    expect(view.queryByText('later')).toBeNull()
    const pendingBubble = view.getByText('interrupt now').closest('[data-pending-steering]')
    expect(pendingBubble).not.toBeNull()
    fireEvent.click(within(pendingBubble as HTMLElement).getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('interrupt now')
    expect(within(pendingBubble as HTMLElement).queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(view.getByRole('status').compareDocumentPosition(view.getByText('interrupt now'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    act(() => {
      h.set({
        queue: [queued],
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'steering', messageId: pending.messageId,
            seq: 2, time: 2_000, turn: 1,
            content: [{ type: 'text', text: 'interrupt now' }], source: null,
          },
        ],
      })
    })
    expect(view.getAllByText('interrupt now')).toHaveLength(1)
    expect(view.container.querySelector('[data-pending-steering]')).toBeNull()
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(2)
    const branchButtons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(branchButtons).toHaveLength(2)
    fireEvent.click(branchButtons[1]!)
    expect(h.forkAt).toHaveBeenCalledWith(2)
  })

  it('keeps a later pending occurrence visible when it reuses a durable MessageId', () => {
    const pending = {
      id: 'steer-occurrence-later' as never,
      messageId: 'shared-steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'same steering' }],
      preview: 'same steering',
      text: 'same steering',
    }
    const h = makeHarness({
      queue: [pending],
      nodes: [{
        kind: 'steering', messageId: pending.messageId,
        seq: 2, time: 2_000, turn: 1,
        content: pending.content, source: null,
      }],
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getAllByText('same steering')).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)
  })

  it('animates only the latest unresolved model retry', () => {
    const retryNode = retry(2)
    const nextRetry = { ...retry(3), turn: 2, retry: 2 }
    const context = {
      kind: 'context', seq: 4, time: 4_000, content: [], source: null,
    } as const satisfies ConversationNode
    const h = makeHarness({ nodes: [user(1, 'try'), retryNode], running: true })
    const view = render(<h.ChatView {...h.props} />)
    const disclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(disclosure.dataset.active).toBe('true')
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    act(() => {
      h.set({ nodes: [user(1, 'try'), retryNode, nextRetry] })
    })
    expect(within(disclosure).getAllByRole('status')).toHaveLength(1)
    expect(view.container.querySelector('details')).toBe(disclosure)
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 1s')

    act(() => {
      h.set({
        nodes: [
          user(1, 'try'),
          retryNode,
          { ...nextRetry, retryState: 'started' },
          context,
          assistant(5, 'done'),
        ],
        running: false,
      })
    })
    expect(disclosure.dataset.active).toBeUndefined()
    expect(within(disclosure).getByRole('status').textContent).toBe('已重试模型请求（2/2） · 1s')

    act(() => {
      h.set({ nodes: [user(1, 'try'), { ...retry(6), retryState: 'cancelled' }], running: true })
    })
    const cancelledDisclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(cancelledDisclosure.dataset.active).toBeUndefined()
    expect(within(cancelledDisclosure).getByRole('status').textContent).toContain('重试已取消')
  })

  it('renders terminal turn failures inline with their durable message and optional code', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), turnError(2, 'AUTH'), turnError(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '本轮运行失败API key is invalidAUTH',
      '本轮运行失败plugin exploded',
    ])
  })

  it('the expanded row Inspect pill hands the call id to inspectCall', () => {
    const h = makeHarness({
      nodes: [toolResult(3, 'a')],
    })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByRole('button', { name: /Bash/ }))
    fireEvent.click(view.getByText('Inspect'))
    expect(h.inspectCall).toHaveBeenCalledWith('a')
  })

  it('shows assistant IconActions only on the last content message of each turn', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text'),
        toolResult(3, 'a'),
        assistant(4, 'final answer'),
        user(5, 'next'),
        assistant(6, 'second turn', 2),
      ],
    })
    const view = render(<h.ChatView {...h.props} />)
    // 2 user + 2 turn-tail assistants; mid-turn text at seq 2 stays chrome-free.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
    expect(view.getAllByRole('button', { name: '在新对话中分支' })).toHaveLength(4)
  })

  it('forks from both user and finalized assistant message actions at their event seq', () => {
    const h = makeHarness({ nodes: [user(1, 'question'), assistant(2, 'answer')] })
    const view = render(<h.ChatView {...h.props} />)
    const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    expect(h.forkAt.mock.calls).toEqual([[1], [2]])
  })

  it('renders assistant Markdown across history, streaming, final, and interrupted states while user text stays literal', () => {
    const markdown = '# Rendered\n\n- **one**\n- `two`'
    const h = makeHarness({ nodes: [user(1, markdown), assistant(2, markdown)] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('h1')).toHaveLength(1)
    const literal = view.getByText((_content, element) => (
      element?.tagName === 'DIV' && element.childElementCount === 0 && element.textContent === markdown
    ))
    expect(literal.querySelector('h1')).toBeNull()

    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: markdown }] } })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"] h1')?.textContent).toBe('Rendered')

    act(() => {
      h.set({
        nodes: [user(1, markdown), assistant(2, markdown), assistant(3, markdown)],
        partial: null,
      })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"]')).toBeNull()

    act(() => {
      h.set({
        nodes: [
          user(1, markdown),
          assistant(2, markdown),
          { ...assistant(3, markdown), interrupted: true },
        ],
      })
    })
    expect(view.getByText('已停止')).toBeTruthy()
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
  })

  it('streaming partial frames re-render only the tail (Profiler count)', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old answer'), toolResult(3, 'a')],
    })
    let renders = 0
    const counting = (
      <Profiler id="chat" onRender={() => { renders += 1 }}>
        <h.ChatView {...h.props} />
      </Profiler>
    )
    const view = render(counting)
    const before = renders
    const beforeHtml = view.container.querySelector('[class*="toolGroup"]')!.innerHTML
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming…' }] } })
    })
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming… more' }] } })
    })
    expect(view.getByText('streaming… more')).toBeTruthy()
    // Each chunk commits exactly one profiler pass (the tail), never a full-tree storm.
    expect(renders - before).toBe(2)
    expect(view.container.querySelector('[class*="toolGroup"]')!.innerHTML).toBe(beforeHtml)
  })

  it('streaming leaves neighbor tool rows and history items at zero re-renders', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old'), toolResult(3, 'a')],
    })
    // Count renderSlot invocations: the memo boundary holds when CallRow does
    // not re-render, so the row's renderSlot call count freezes during chunks.
    let rowRenders = 0
    h.props.renderSlot = ((_key: string, _owner: object) => {
      rowRenders += 1
      return <div data-testid="counting-row" />
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('counting-row')).toBeTruthy()
    const afterMount = rowRenders
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1' }] } })
    })
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1 chunk2' }] } })
    })
    expect(rowRenders).toBe(afterMount)
  })

  it('tool row expands to the args body via the whole-row toggle', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/"command": "cmd-a"/)).toBeNull()
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.getByText(/"command": "cmd-a"/)).toBeTruthy()
  })

  it('clicking a bash summary does not open details; selection still marks data-selected', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('run a'))
    expect(h.openDetails).not.toHaveBeenCalled()
    expect(h.openFile).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-selected]')).toBeNull()
    act(() => { h.setSelection({ turnSeq: 3, callId: 'a', toolName: 'bash' }) })
    expect(view.container.querySelector('[data-selected]')).not.toBeNull()
  })

  it('clicking a file-tool path summary opens the host file, not details', () => {
    const h = makeHarness({
      nodes: [{
        kind: 'tool-result', seq: 3, time: 3_000, callId: 'r1',
        call: { name: 'read', argsRaw: '{"path":"src/a.ts"}' },
        callTime: 2_500, content: [], isError: false, callView: null, resultView: null,
      }],
    })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('src/a.ts'))
    expect(h.openFile).toHaveBeenCalledWith('src/a.ts')
    expect(h.openDetails).not.toHaveBeenCalled()
  })

  it('running calls render as a live tool group with the running state', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.getByText('cmd-r1')).toBeTruthy()
    expect(view.getByRole('status').textContent).toBe('Deep diving...')
  })

  it('dispatches each tool row through the keyed slot with the tool name as entryKey', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const calls: { key: string; entryKey?: string }[] = []
    h.props.renderSlot = ((key: string, _owner: object, opts?: { entryKey?: string; fallback?: React.ReactNode }) => {
      calls.push({ key, ...(opts?.entryKey !== undefined ? { entryKey: opts.entryKey } : {}) })
      return opts?.fallback ?? null
    })
    render(<h.ChatView {...h.props} />)
    // Keyed dispatch: slot name is the declared hole, entryKey the wire tool
    // name, and the fallback (GenericToolCard) renders on an empty ledger.
    // (Registered-row takeover and live unload are slot machinery behavior,
    // owned by the slot system's own specs.)
    expect(calls).toEqual([{ key: 'conversation.chat.toolview', entryKey: 'bash' }])
  })

  it('prepend compensates scrollTop by the height delta; a trailing user node force-scrolls', () => {
    const h = makeHarness({ nodes: [user(5, 'later'), assistant(6, 'a')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    // jsdom has no layout: fake the metrics the anchor math reads.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, writable: true })
    // Arm the paging anchor, then deliver an older page (head seq decreases).
    fireEvent.click(view.getByText('加载更早'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, writable: true })
    act(() => { h.set({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a')] }) })
    expect(scroller.scrollTop).toBe(600) // 0 + (1600 - 1000)
    // A new trailing user bubble (own words) force-scrolls to the bottom.
    act(() => { h.set({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a'), user(9, 'mine')] }) })
    expect(scroller.scrollTop).toBe(1600)
  })

  it('scrolling away disables follow and shows the back-to-bottom button; clicking returns', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    scroller.scrollTop = 100 // far from bottom
    fireEvent.scroll(scroller)
    const backButton = view.getByLabelText('回到底部')
    expect(backButton).toBeTruthy()
    // Streaming growth must NOT drag a scrolled-away reader down.
    act(() => { h.set({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } }) })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(1000)
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('entering the at-bottom threshold does not snap the remaining scroll distance', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    // Inside FOLLOW_THRESHOLD (24) but not flush with the floor — the chrome
    // re-render from setAtBottom must not force scrollTop to scrollHeight.
    scroller.scrollTop = 690 // distance-to-bottom = 10
    fireEvent.scroll(scroller)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(scroller.scrollTop).toBe(690)
  })

  it('under data-conversation-scroll, bottom-follow targets the host scrollport', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // Open jump uses the host, not the local .scroll node.
      expect(host.scrollTop).toBe(2000)
      host.scrollTop = 100
      fireEvent.scroll(host)
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      fireEvent.click(view.getByLabelText('回到底部'))
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('a remount restores the saved scroll position instead of re-jumping to the bottom', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      // Fresh open (nothing saved): the bottom jump stands.
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(2000)
      // Reader scrolls up; the position is recorded continuously.
      host.scrollTop = 100
      fireEvent.scroll(host)
      // View-tab switch away and back: the view unmounts, then remounts.
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(100)
      // The restored position is above the floor: follow stays disarmed.
      expect(view.getByLabelText('回到底部')).toBeTruthy()
    } finally {
      host.remove()
    }
  })

  it('a remount while pinned to the bottom keeps the bottom jump', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // At the bottom: the scroll event records the pinned state (null).
      fireEvent.scroll(host)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('paging button loads older and shows its busy label', () => {
    const h = makeHarness({ nodes: [user(5, 'later')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('加载更早'))
    expect(h.loadOlder).toHaveBeenCalledTimes(1)
    act(() => { h.set({ loadingOlder: true }) })
    expect(view.getByText('加载中…')).toBeTruthy()
  })

  it('shows open error and loading states', () => {
    const h = makeHarness({
      openState: 'error',
      openError: { code: 'internal', message: 'boom' } as never,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText(/历史加载失败：boom/)).toBeTruthy()
    const loading = makeHarness({ openState: 'loading' })
    const lv = render(<loading.ChatView {...loading.props} />)
    expect(lv.getByText('载入历史…')).toBeTruthy()
  })

  it('pending waits leave the flow entirely — questions and approvals both take over the composer', () => {
    const h = makeHarness({
      pending: [
        new PendingWait('approval', RpcId('r1'), SID,
          { approvalId: 'ap1', toolName: 'bash' } as PendingWait<'approval'>['payload'], vi.fn()),
        new PendingWait('question', RpcId('r2'), SID,
          { questions: [{ id: 'q1', question: '选择' }] }, vi.fn()),
      ],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/等待回答/)).toBeNull()
    expect(view.queryByText(/等待审批/)).toBeNull()
  })

  it('renders command nodes as durable rows: settled text, error state, executing spinner, run-less soft-fall', () => {
    const command = (over: Partial<CommandNode>): CommandNode => ({
      kind: 'command', seq: 5, time: 5_000, commandId: 'cmd-1' as CommandNode['commandId'],
      name: 'plan', args: '', outcome: { kind: 'success', text: '已进入 plan mode' },
      ...over,
    })
    // Settled success: the bare command name is the title, the outcome text
    // the summary — neither the dispatched `/` nor its arguments reach the row
    // (the settlement text already says what the command did).
    const settled = makeHarness({ nodes: [user(1, 'hi'), command({ args: ' now' })] })
    const view = render(<settled.ChatView {...settled.props} />)
    expect(view.getByText('plan')).toBeTruthy()
    expect(view.queryByText('/plan')).toBeNull()
    expect(view.queryByText('/plan now')).toBeNull()
    expect(view.getByText('已进入 plan mode')).toBeTruthy()

    // Error outcome flips the row state; a text-less error gets the default copy.
    const failed = makeHarness({
      nodes: [command({ seq: 6, commandId: 'cmd-2' as CommandNode['commandId'], outcome: { kind: 'error' } })],
    })
    const fv = render(<failed.ChatView {...failed.props} />)
    expect(fv.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(fv.getByText('命令失败')).toBeTruthy()

    // Still executing: running state with the executing copy.
    const executing = makeHarness({
      nodes: [command({ seq: 7, commandId: 'cmd-3' as CommandNode['commandId'], outcome: null })],
    })
    const xv = render(<executing.ChatView {...executing.props} />)
    expect(xv.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(xv.getByText('执行中…')).toBeTruthy()

    // Cross-window soft-fall (run page truncated): generic title, outcome preserved.
    const orphan = makeHarness({
      nodes: [command({ seq: 8, commandId: 'cmd-4' as CommandNode['commandId'], name: null, args: null, outcome: { kind: 'success' } })],
    })
    const ov = render(<orphan.ChatView {...orphan.props} />)
    expect(ov.getByText('命令')).toBeTruthy()
    expect(ov.getByText('已完成')).toBeTruthy()
  })
})
