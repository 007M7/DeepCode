// @vitest-environment jsdom
/**
 * View registration acceptance on the real framework stack: the plugin fiber
 * registers trajectory/waterfall into a real SlotsService view ring, tabs
 * switch inside ConversationRoot (renderSlot share driven by the same tab
 * projection apply uses) without collapsing chat, trajectory renders the
 * turn-list chrome (no span stats bar), waterfall keeps in-body stats, and
 * fiber disposal removes both tabs. Span derivation edge cases ride along.
 */
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type FC, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Export discipline: packages/client/AGENTS.md.
import { ConversationSession, type ConversationSessionProps } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationSession.tsx'
import { createChatStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/stores.ts'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { deriveSpans, deriveSpanStats, deriveSubSpans } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/spans.ts'
import { TrajectoryStatsHeader } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryStatsHeader.tsx'
import { TrajectoryView } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryView.tsx'
import { WaterfallView } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/WaterfallView.tsx'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-trajectory'

const SID = 's1' as SessionId
afterEach(cleanup)
// The chat store persists under its declared key; clear so one case's active
// view cannot rehydrate into the next.
beforeEach(() => {
  // Node 22+ exposes an experimental localStorage global that is undefined
  // without --localstorage-file; only clear when a real Storage is present.
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

/** Node fixture: user prologue, two turns, one tool result inside turn 1. */
const NODES = [
  { kind: 'user', seq: 1, time: 1_000, content: [], source: null },
  { kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [] },
  {
    kind: 'tool-result', seq: 3, time: 3_000, callId: 'c1', call: null, callTime: null,
    content: [], isError: false, callView: null, resultView: null,
  },
  { kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 1, blocks: [] },
] as unknown as ConversationSnapshot['nodes']

function fakeSession(nodes: ConversationSnapshot['nodes']) {
  const store = createSnapshotStore({
    nodes, partial: null, runningCalls: [] as ConversationSnapshot['runningCalls'], codeDispatches: new Map(),
  })
  return { store, useSession: bindSnapshotSelector(store) as unknown as UseSession<ConversationSnapshot> }
}

/** Empty sessions-list hook; breadcrumbs therefore fall back to the raw id. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready' })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/** Standalone view props: the session-scope standard kit the outlet would bake. */
function standaloneProps(nodes: ConversationSnapshot['nodes']): ConvViewProps {
  return {
    sessionId: SID,
    useSession: fakeSession(nodes).useSession,
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
  } as unknown as ConvViewProps
}

/** Real-stack bench: root Context + real SlotsService ring + the plugin fiber. */
async function bench() {
  const ctx = new Context()
  const slots = new SlotsService(ctx)
  // The conversation entry's role: declare the ring, then seed the chat entry.
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_p: { renderSlot?: unknown }) => null)
  const chatBody = vi.fn(() => <div data-testid="chat-body" />)
  slots.register(
    { name: 'conversation.view', id: 'chat', order: 0, label: 'Chat' } as never, chatBody as never)
  // 'conversation' inject is an ordering edge; the bench declares the ring
  // itself, so a stub satisfies the wait.
  ctx.provide('conversation', {})
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

/** Tab projection twin of apply's viewTabs (the render-side consumption path). */
function tabsOf(slots: SlotsService): ViewTab[] {
  return slots.entries('conversation.view')
    .map(e => ({ id: e.options.id!, label: e.options.label ?? e.options.id! }))
}

/** Mount the strict session content over the ring ledger with an outlet-faithful renderSlot. */
function mount(slots: SlotsService, nodes: ConversationSnapshot['nodes'] = NODES) {
  const sessionSnapshot = createSnapshotStore({
    running: false, removed: false, promptError: null, nodes,
    partial: null, runningCalls: [] as ConversationSnapshot['runningCalls'], codeDispatches: new Map(),
  })
  const useSession = bindSnapshotSelector(sessionSnapshot) as unknown as UseSession<ConversationSnapshot>
  const chat = createChatStore().create()
  // Minimal outlet twin: resolve the ring entry by the `only` filter and
  // render it with the session standard kit (what SlotOutlet does for a
  // list-kind session slot, minus machinery).
  const renderSlot = ((key: string, _owner: object, opts?: { only?: string }): ReactNode => {
    const entry = slots.entries('conversation.view').find(e => e.options.id === opts?.only)
    if (entry === undefined) return null
    const View = entry.component as FC<ConvViewProps>
    return (
      <View
        {...({ sessionId: SID, useSession, useSessions: emptySessions(), useWorkspaces: emptyWorkspaces() } as unknown as ConvViewProps)}
        key={key}
      />
    )
  }) as unknown as ConversationSessionProps['renderSlot']
  return render(
    <ConversationSession
      sessionId={SID}
      SessionProvider={({ children }) => children(SID)}
      useSession={useSession}
      useSessions={emptySessions()}
      useWorkspaces={emptyWorkspaces()}
      useStore={bindSnapshotSelector(chat)}
      actions={chat.actions}
      renderSlot={renderSlot}
      views={{
        list: () => tabsOf(slots),
        subscribe: (fn: () => void) => slots.subscribe('conversation.view', fn),
        version: () => slots.getVersion('conversation.view'),
      }}
      useInput={bindSnapshotSelector(createSnapshotStore({ draft: '', draftRev: 0, phase: 'plain', queue: [] })) as never}
      inputActions={{ setDraft: vi.fn(), submit: vi.fn() }}
      bindDraftMirror={() => () => {}}
      open={vi.fn()}
    />,
  )
}

describe('plugin registration', () => {
  it('registers trajectory and waterfall after chat on the ring', async () => {
    const b = await bench()
    expect(tabsOf(b.slots)).toEqual([
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
      { id: 'waterfall', label: 'Waterfall' },
    ])
  })

  it('fiber disposal removes both tabs and leaves chat standing', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(tabsOf(b.slots).map(v => v.id)).toEqual(['chat'])
  })
})

describe('tab switching in ConversationRoot', () => {
  it('renders all three tabs, defaults to chat, and switches to trajectory without stats chrome', async () => {
    const b = await bench()
    mount(b.slots)
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Chat', 'Trajectory', 'Waterfall'])

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    expect(screen.queryByText(/turns ·/)).toBeNull()
    expect(screen.getByText('Turn 1')).toBeTruthy()
    expect(screen.getByText('Turn 2')).toBeTruthy()
    expect(screen.getAllByText('Message').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Step 1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Input').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('chat-body')).toBeNull()
  })

  it('waterfall renders bars and switching back to chat does not collapse it', async () => {
    const b = await bench()
    mount(b.slots)
    fireEvent.click(screen.getByRole('tab', { name: 'Waterfall' }))
    expect(screen.getByTitle('2 nodes')).toBeTruthy()
    expect(screen.getByTitle('1 tool calls')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(screen.getByTestId('chat-body')).toBeTruthy()
  })

  it('empty window: placeholder copy in the body, the stats header renders nothing', async () => {
    const b = await bench()
    mount(b.slots, [])
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    expect(screen.getByText('暂无轨迹数据')).toBeTruthy()
    expect(screen.queryByText(/turns ·/)).toBeNull()
  })
})

describe('span derivation', () => {
  it('attributes prologue to turn 0 and follows steering turn tags', () => {
    const nodes = [
      { kind: 'user', seq: 1 },
      { kind: 'steering', seq: 2, turn: 5 },
      { kind: 'user', seq: 3 },
    ] as unknown as ConversationSnapshot['nodes']
    const spans = deriveSpans(nodes)
    expect(spans).toEqual([
      { turn: 0, steps: 0, calls: 0, nodes: 1 },
      { turn: 5, steps: 0, calls: 0, nodes: 2 },
    ])
    expect(deriveSpanStats(spans)).toEqual({ turns: 2, steps: 0, calls: 0 })
  })

  it('empty inputs produce zero stats and standalone components render their empty forms', () => {
    expect(deriveSpanStats(deriveSpans([]))).toEqual({ turns: 0, steps: 0, calls: 0 })
    const { useSession } = fakeSession([])
    const { container } = render(createElement(TrajectoryStatsHeader, { useSession: useSession }))
    expect(container.firstChild).toBeNull()
    render(createElement(TrajectoryView as FC<ConvViewProps>,
      standaloneProps([])))
    expect(screen.getByText('暂无轨迹数据')).toBeTruthy()
  })
})

describe('WaterfallView standalone branches', () => {
  it('empty window renders the placeholder copy', () => {
    render(createElement(WaterfallView as FC<ConvViewProps>,
      standaloneProps([])))
    expect(screen.getByText('暂无瀑布数据')).toBeTruthy()
  })

  it('a turn without tool calls renders the node bar only', () => {
    const nodes = [{ kind: 'user', seq: 1 }] as unknown as ConversationSnapshot['nodes']
    render(createElement(WaterfallView as FC<ConvViewProps>, standaloneProps(nodes)))
    expect(screen.getByTitle('1 nodes')).toBeTruthy()
    expect(screen.queryByTitle(/tool calls/)).toBeNull()
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

describe('deriveSubSpans (waterfall lanes)', () => {
  const dispatchNodes = [
    { kind: 'assistant', seq: 2, time: 6_000, turn: 3, step: 1, blocks: [] },
    {
      kind: 'tool-result', seq: 3, time: 9_000, callId: 'p1',
      call: { name: 'run_code', argsRaw: '{}' }, callTime: 6_100,
      content: [], isError: false, callView: null, resultView: null,
    },
  ] as unknown as ConversationSnapshot['nodes']

  it('scales settled lanes into the dispatch window with real durations', () => {
    const codeDispatches = new Map([['p1', [
      {
        kind: 'tool-result', seq: 101, time: 7_000, callId: 'p1:code:1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 6_200,
        content: [], isError: false, callView: null, resultView: null,
      },
      {
        kind: 'tool-result', seq: 102, time: 8_200, callId: 'p1:code:2',
        call: { name: 'read', argsRaw: '{}' }, callTime: 7_000,
        content: [], isError: false, callView: null, resultView: null,
      },
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const lanes = deriveSubSpans(dispatchNodes, codeDispatches)
    const turn3 = lanes.get(3)
    expect(turn3).toHaveLength(2)
    // Window = 6200..8200 (2000ms). bash: 0..0.4; read: 0.4..1.0.
    expect(turn3?.[0]).toMatchObject({ name: 'bash', durationMs: 800, timing: 'measured', offsetFraction: 0 })
    expect(turn3?.[0]?.widthFraction).toBeCloseTo(0.4)
    expect(turn3?.[1]).toMatchObject({ name: 'read', durationMs: 1200 })
    expect(turn3?.[1]?.offsetFraction).toBeCloseTo(0.4)
  })

  it('a running lane extends to the window end with a null duration', () => {
    const codeDispatches = new Map([['p1', [
      {
        kind: 'tool-result', seq: 101, time: 8_000, callId: 'p1:code:1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 6_200,
        content: [], isError: false, callView: null, resultView: null,
      },
      { callId: 'p1:code:2', name: 'grep', argsRaw: '{}', turn: 0, step: 0, time: 7_000, callView: null },
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const lanes = deriveSubSpans(dispatchNodes, codeDispatches)
    const running = lanes.get(3)?.find(lane => lane.name === 'grep')
    expect(running).toMatchObject({ durationMs: null, timing: 'running' })
    // Extends from its start to the window end.
    expect(running!.offsetFraction + running!.widthFraction).toBeCloseTo(1)
  })

  it('a settle-only entry (null callTime) is unknown timing, never a measured 0 ms', () => {
    const codeDispatches = new Map([['p1', [
      {
        kind: 'tool-result', seq: 101, time: 8_000, callId: 'p1:code:1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: null,
        content: [], isError: false, callView: null, resultView: null,
      },
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const lane = deriveSubSpans(dispatchNodes, codeDispatches).get(3)?.[0]
    expect(lane).toMatchObject({ durationMs: null, timing: 'unknown' })
  })

  it('waterfall renders sub-span lanes under the owning turn row', () => {
    const codeDispatches = new Map([['p1', [
      {
        kind: 'tool-result', seq: 101, time: 8_000, callId: 'p1:code:1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 6_200,
        content: [], isError: false, callView: null, resultView: null,
      },
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const store = createSnapshotStore({
      nodes: dispatchNodes, partial: null,
      runningCalls: [] as ConversationSnapshot['runningCalls'], codeDispatches,
    })
    const props = {
      sessionId: SID,
      useSession: bindSnapshotSelector(store) as unknown as UseSession<ConversationSnapshot>,
      useSessions: emptySessions(),
      useWorkspaces: emptyWorkspaces(),
    } as unknown as ConvViewProps
    const view = render(createElement(WaterfallView as FC<ConvViewProps>, props))
    const lane = view.container.querySelector('[data-subspan]')
    expect(lane).not.toBeNull()
    expect(lane!.textContent).toContain('bash')
    expect(lane!.querySelector('[title*="1.80s"]')).not.toBeNull()
    expect(lane!.querySelector('[data-timing="measured"]')).not.toBeNull()
  })

  it('waterfall labels a settle-only lane as duration unknown', () => {
    const codeDispatches = new Map([['p1', [
      {
        kind: 'tool-result', seq: 101, time: 8_000, callId: 'p1:code:1',
        call: { name: 'read', argsRaw: '{}' }, callTime: null,
        content: [], isError: false, callView: null, resultView: null,
      },
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const store = createSnapshotStore({
      nodes: dispatchNodes, partial: null,
      runningCalls: [] as ConversationSnapshot['runningCalls'], codeDispatches,
    })
    const props = {
      sessionId: SID,
      useSession: bindSnapshotSelector(store) as unknown as UseSession<ConversationSnapshot>,
      useSessions: emptySessions(),
      useWorkspaces: emptyWorkspaces(),
    } as unknown as ConvViewProps
    const view = render(createElement(WaterfallView as FC<ConvViewProps>, props))
    const bar = view.container.querySelector('[data-timing="unknown"]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('title')).toContain('duration unknown')
  })
})
