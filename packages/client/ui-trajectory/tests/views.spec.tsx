// @vitest-environment jsdom
/**
 * View registration acceptance on the real framework stack: the plugin fiber
 * registers trajectory/waterfall into a real SlotsService view ring, tabs
 * switch inside ConversationRoot (renderSlot share driven by the same tab
 * projection apply uses) without collapsing chat, the span stats header
 * renders inside both view bodies, and fiber disposal removes both tabs.
 * Span derivation edge cases ride along.
 */
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type FC, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Export discipline: packages/client/AGENTS.md.
import { ConversationRoot, type ConversationRootProps } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.tsx'
import { createChatStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/stores.ts'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { deriveSpans, deriveSpanStats } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/spans.ts'
import { TrajectoryStatsHeader } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryStatsHeader.tsx'
import { TrajectoryView } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryView.tsx'
import { WaterfallView } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/WaterfallView.tsx'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-trajectory'

const SID = 's1' as SessionId
/** Fallback-only chain stub (no composer takeover in these benches). */
const fallbackRenderSlotChain: ConversationRootProps['renderSlotChain'] =
  (_key, _owner, opts) => opts?.fallback ?? null

afterEach(cleanup)
// The chat store persists under its declared key; clear so one case's active
// view cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
})

/** Node fixture: user prologue, two turns, one tool result inside turn 1. */
const NODES = [
  { kind: 'user', seq: 1, content: [], source: null },
  { kind: 'assistant', seq: 2, turn: 1, step: 1, blocks: [] },
  { kind: 'tool-result', seq: 3, callId: 'c1', call: null, content: [], isError: false, callView: null, resultView: null },
  { kind: 'assistant', seq: 4, turn: 2, step: 1, blocks: [] },
] as unknown as ConversationSnapshot['nodes']

function fakeSession(nodes: ConversationSnapshot['nodes']) {
  const store = createSnapshotStore<{ nodes: ConversationSnapshot['nodes'] }>({ nodes })
  return { store, useSession: bindSnapshotSelector(store) as unknown as UseSession<ConversationSnapshot> }
}

/** Empty sessions-list hook stub (breadcrumbs fall back to the raw id; engines carry no hook since the store migration — bind here). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined } as SessionListState)
  return bindSnapshotSelector(store)
}

/** SessionProvider seat stub (render-prop pass-through; ConversationRoot never invokes it). */
const SessionProviderStub: ConversationRootProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>

/** Standalone view props: the session-scope standard kit the outlet would bake. */
function standaloneProps(nodes: ConversationSnapshot['nodes']): ConvViewProps {
  return {
    sessionId: SID,
    useSession: fakeSession(nodes).useSession,
    useSessions: emptySessions(),
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

/** Mount ConversationRoot over the ring ledger with an outlet-faithful renderSlot. */
function mount(slots: SlotsService, nodes: ConversationSnapshot['nodes'] = NODES) {
  const sessionSnapshot = createSnapshotStore<{ running: boolean; removed: boolean; promptError: null; nodes: ConversationSnapshot['nodes'] }>({
    running: false, removed: false, promptError: null, nodes,
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
        {...({ sessionId: SID, useSession, useSessions: emptySessions() } as unknown as ConvViewProps)}
        key={key}
      />
    )
  }) as unknown as ConversationRootProps['renderSlot']
  return render(
    <ConversationRoot
      sessionId={SID}
      useSession={useSession}
      useSessions={emptySessions()}
      useStore={bindSnapshotSelector(chat)}
      actions={chat.actions}
      renderSlot={renderSlot}
      renderSlotChain={fallbackRenderSlotChain}
      SessionProvider={SessionProviderStub}
      views={{
        list: () => tabsOf(slots),
        subscribe: (fn) => slots.subscribe('conversation.view', fn),
        version: () => slots.getVersion('conversation.view'),
      }}
      send={vi.fn()}
      stop={vi.fn()}
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
    expect(tabsOf(b.slots).map((v) => v.id)).toEqual(['chat'])
  })
})

describe('tab switching in ConversationRoot', () => {
  it('renders all three tabs, defaults to chat, and switches to trajectory with its header stats', async () => {
    const b = await bench()
    mount(b.slots)
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'Trajectory', 'Waterfall'])

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    // In-body header stats over NODES: turns 0/1/2, 2 assistant steps, 1 tool call.
    expect(screen.getByText('3 turns · 2 steps · 1 tool calls')).toBeTruthy()
    expect(screen.getByText('turn 0')).toBeTruthy()
    expect(screen.getByText('1 steps · 1 calls · 2 nodes')).toBeTruthy()
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
    mount(b.slots, [] as unknown as ConversationSnapshot['nodes'])
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
    expect(deriveSpanStats(deriveSpans([] as unknown as ConversationSnapshot['nodes']))).toEqual({ turns: 0, steps: 0, calls: 0 })
    const { useSession } = fakeSession([] as unknown as ConversationSnapshot['nodes'])
    const { container } = render(createElement(TrajectoryStatsHeader, { useSession: useSession as never }))
    expect(container.firstChild).toBeNull()
    render(createElement(TrajectoryView as FC<ConvViewProps>,
      standaloneProps([] as unknown as ConversationSnapshot['nodes'])))
    expect(screen.getByText('暂无轨迹数据')).toBeTruthy()
  })
})

describe('WaterfallView standalone branches', () => {
  it('empty window renders the placeholder copy', () => {
    render(createElement(WaterfallView as FC<ConvViewProps>,
      standaloneProps([] as unknown as ConversationSnapshot['nodes'])))
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
    expect(nodeApply()).toBeUndefined()
  })
})
