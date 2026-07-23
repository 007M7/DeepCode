// @vitest-environment jsdom
// ChatView behavior: flow derivation, streaming isolation (Profiler counts),
// toolview dispatch and selection handoff — driven through a scripted
// ObservableSnapshot fake, no wire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  AssistantMessageNode, ConversationNode, ConversationSnapshot, RunningToolCall, SessionId, ToolResultNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { hookOf } from './hook.ts'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps, SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createChatStore } from '../src/client/stores.ts'
import { createChatView } from '../src/client/chat/ChatView.tsx'
import { deriveChatFlow, flowKeys } from '../src/client/chat/chat-flow.ts'

afterEach(cleanup)
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  }
}

/** Scripted snapshot source: set() swaps the top-level object like the real Session. */
function makeSource(init?: Partial<ConversationSnapshot>) {
  let snap: ConversationSnapshot = { ...snapshotBase(), ...init }
  const subs = new Set<() => void>()
  return {
    set(next: Partial<ConversationSnapshot>) {
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
  kind: 'user', seq, content: [{ type: 'text', text }] as never, source: null,
})
const assistant = (seq: number, text: string): AssistantMessageNode => ({
  kind: 'assistant', seq, turn: 1, step: 1, blocks: [{ kind: 'text', text }],
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  content: [], isError: false, callView: null, resultView: null,
})
const runningCall = (callId: string, name = 'bash'): RunningToolCall => ({
  callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, callView: null,
})

function makeHarness(init?: Partial<ConversationSnapshot>) {
  const { set, source } = makeSource(init)
  const registry = new ToolViewRegistry()
  const ChatView = createChatView({ toolviews: registry, t: (k) => k })
  const openDetails = vi.fn<(t: SelectionTarget) => void>()
  const loadOlder = vi.fn()
  // Selection rides the REAL chat store (same construction path as
  // production; the view reads it through the ConvViewProps useStore share).
  const chat = createChatStore().create()
  const props: ConvViewProps = {
    sessionId: SID,
    useSession: hookOf(source) as unknown as UseSession,
    useStore: hookOf(chat),
    actions: { openDetails, loadOlder },
  }
  const setSelection = (next: SelectionTarget | null): void => { chat.actions.select(next) }
  return { set, registry, ChatView, props, openDetails, loadOlder, setSelection }
}

describe('chat-flow derivation', () => {
  it('groups consecutive tool results and keeps stable keys', () => {
    const nodes: ConversationNode[] = [
      user(1, 'hi'), assistant(2, 'let me look'), toolResult(3, 'a'), toolResult(4, 'b'),
      assistant(5, 'found'), toolResult(6, 'c'),
    ]
    const items = deriveChatFlow(nodes)
    expect(items.map((i) => i.kind)).toEqual(['node', 'node', 'tool-group', 'node', 'tool-group'])
    const group = items[2]!
    expect(group.kind === 'tool-group' && group.results.map((r) => r.callId)).toEqual(['a', 'b'])
    expect(flowKeys(items)).toBe('n1|n2|g3|n5|g6')
    expect(flowKeys(deriveChatFlow([...nodes, toolResult(7, 'd')]))).toBe('n1|n2|g3|n5|g6')
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
    act(() => h.set({ nodes: [assistant(2, 'older'), user(9, 'late')] }))
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
    let rowRenders = 0
    h.registry.register('bash', () => {
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

  it('tool row expands to the args body via the leading slot toggle', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/"command": "cmd-a"/)).toBeNull()
    fireEvent.click(view.container.querySelector('button[aria-expanded]')!)
    expect(view.getByText(/"command": "cmd-a"/)).toBeTruthy()
  })

  it('clicking a tool row opens details with callId and toolName; selection paints the outline', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('run a'))
    expect(h.openDetails).toHaveBeenCalledWith({ turnSeq: 3, callId: 'a', toolName: 'bash' })
    expect(view.container.querySelector('[data-selected]')).toBeNull()
    act(() => h.setSelection({ turnSeq: 3, callId: 'a', toolName: 'bash' }))
    expect(view.container.querySelector('[data-selected]')).not.toBeNull()
  })

  it('running calls render as a live tool group with the running state', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.getByText('cmd-r1')).toBeTruthy()
  })

  it('a scoped toolview registration takes over rendering for its session only', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.registry.register('bash', () => <div data-testid="custom-bash" />, { scope: (id) => id === SID })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('custom-bash')).toBeTruthy()
  })

  it('unregistering a toolview falls back to the generic row live', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const off = h.registry.register('bash', () => <div data-testid="custom-bash" />)
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('custom-bash')).toBeTruthy()
    act(() => off())
    expect(view.queryByTestId('custom-bash')).toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
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
    act(() => h.set({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a')] }))
    expect(scroller.scrollTop).toBe(600) // 0 + (1600 - 1000)
    // A new trailing user bubble (own words) force-scrolls to the bottom.
    act(() => h.set({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a'), user(9, 'mine')] }))
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
    act(() => h.set({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } }))
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(1000)
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('paging button loads older and shows its busy label', () => {
    const h = makeHarness({ nodes: [user(5, 'later')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('加载更早'))
    expect(h.loadOlder).toHaveBeenCalledTimes(1)
    act(() => h.set({ loadingOlder: true }))
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

  it('pending interactions render placeholder cards', () => {
    const h = makeHarness({
      pending: [{ kind: 'approval', rpcId: 'r1' as never, approvalId: 'ap1', toolName: 'bash' }],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText(/等待审批/)).toBeTruthy()
  })
})
