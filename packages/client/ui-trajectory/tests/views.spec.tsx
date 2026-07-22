// @vitest-environment jsdom
/**
 * View registration acceptance on the real framework stack: the plugin fiber
 * registers trajectory/waterfall into a real ConversationService, tabs switch
 * inside ConversationRoot without collapsing chat, chrome.header renders the
 * span stats bar, and fiber disposal removes both tabs. Span derivation edge
 * cases ride along.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, Fragment, type FC, type ReactNode } from 'react'
import { bindSnapshotSelector, createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConversationSnapshot, SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationRoot, ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConvViewProps, ViewEntry, ViewId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply, deriveSpans, deriveSpanStats, inject, TrajectoryStatsHeader, TrajectoryView, WaterfallView,
} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-trajectory'

const SID = 's1' as SessionId

afterEach(cleanup)

/** Node fixture: user prologue, two turns, one tool result inside turn 1. */
const NODES = [
  { kind: 'user', seq: 1, content: [], source: null },
  { kind: 'assistant', seq: 2, turn: 1, step: 1, blocks: [] },
  { kind: 'tool-result', seq: 3, callId: 'c1', call: null, content: [], isError: false, callView: null, resultView: null },
  { kind: 'assistant', seq: 4, turn: 2, step: 1, blocks: [] },
] as unknown as ConversationSnapshot['nodes']

function fakeSession(nodes: ConversationSnapshot['nodes']) {
  const store = createSnapshotStore<{ nodes: ConversationSnapshot['nodes'] }>({ nodes })
  return { store, useSession: bindSnapshotSelector(store) as unknown as UseSession }
}

/** Real-stack bench: root Context + real ConversationService + the plugin fiber. */
async function bench() {
  const ctx = new Context()
  const svc = new ConversationService(ctx)
  const chatBody = vi.fn(() => <div data-testid="chat-body" />)
  svc.registerView({ id: 'chat' as ViewId, label: 'Chat', order: 0, component: chatBody as unknown as FC<ConvViewProps> })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, svc, fiber }
}

/** Mount ConversationRoot over the service's registry face, rendering chrome like the conversation apply does. */
function mount(svc: ConversationService, nodes: ConversationSnapshot['nodes'] = NODES) {
  const { useSession } = fakeSession(nodes)
  const activeStore = createSnapshotStore<string | undefined>(undefined)
  const ancestry: SessionSummary[] = [{ id: SID, title: 'self', running: false, updatedAt: 1 }]
  const viewProps = {
    sessionId: SID, useSession,
    useSelection: () => null,
    actions: { openDetails: vi.fn(), loadOlder: vi.fn() },
    slots: undefined,
  } as unknown as ConvViewProps
  const renderView = (entry: ViewEntry): ReactNode => {
    const children: ReactNode[] = []
    if (entry.chrome?.header !== undefined) {
      children.push(createElement(entry.chrome.header, { key: 'h', sessionId: SID, useSession }))
    }
    children.push(createElement(entry.component, { key: 'b', ...viewProps }))
    if (entry.chrome?.footer !== undefined) {
      children.push(createElement(entry.chrome.footer, { key: 'f', sessionId: SID, useSession }))
    }
    return createElement(Fragment, null, children)
  }
  const sessionSnapshot = createSnapshotStore<{ running: boolean; removed: boolean; promptError: null; nodes: ConversationSnapshot['nodes'] }>({
    running: false, removed: false, promptError: null, nodes,
  })
  return render(
    <ConversationRoot
      sessionId={SID}
      useSession={bindSnapshotSelector(sessionSnapshot) as unknown as UseSession}
      useAncestry={() => ancestry}
      views={{
        list: () => svc.views(),
        subscribe: (fn) => svc.subscribeViews(fn),
        version: () => svc.viewsVersion(),
      }}
      useActiveView={() => activeStore.useSelector((s) => s) as ViewId | undefined}
      composer={{ useDraft: () => '', setDraft: vi.fn(), send: vi.fn(), stop: vi.fn() }}
      actions={{ openView: ((v: string) => { activeStore.set(v) }) as (v: never) => void, open: vi.fn() }}
      renderView={renderView}
    />,
  )
}

describe('plugin registration', () => {
  it('registers trajectory and waterfall after chat, both with header chrome', async () => {
    const b = await bench()
    const views = b.svc.views()
    expect(views.map((v) => v.id)).toEqual(['chat', 'trajectory', 'waterfall'])
    expect(views[1]?.chrome?.header).toBeDefined()
    expect(views[2]?.chrome?.header).toBeDefined()
    expect(views[1]?.chrome?.footer).toBeUndefined()
  })

  it('fiber disposal removes both tabs and leaves chat standing', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.svc.views().map((v) => v.id)).toEqual(['chat'])
  })
})

describe('tab switching in ConversationRoot', () => {
  it('renders all three tabs, defaults to chat, and switches to trajectory with its header stats', async () => {
    const b = await bench()
    mount(b.svc)
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'Trajectory', 'Waterfall'])

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    // chrome.header stats over NODES: turns 0/1/2, 2 assistant steps, 1 tool call.
    expect(screen.getByText('3 turns · 2 steps · 1 tool calls')).toBeTruthy()
    expect(screen.getByText('turn 0')).toBeTruthy()
    expect(screen.getByText('1 steps · 1 calls · 2 nodes')).toBeTruthy()
    expect(screen.queryByTestId('chat-body')).toBeNull()
  })

  it('waterfall renders bars and switching back to chat does not collapse it', async () => {
    const b = await bench()
    mount(b.svc)
    fireEvent.click(screen.getByRole('tab', { name: 'Waterfall' }))
    expect(screen.getByTitle('2 nodes')).toBeTruthy()
    expect(screen.getByTitle('1 tool calls')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(screen.getByTestId('chat-body')).toBeTruthy()
  })

  it('empty window: placeholder copy in the body, header chrome renders nothing', async () => {
    const b = await bench()
    mount(b.svc, [] as unknown as ConversationSnapshot['nodes'])
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
    const { container } = render(createElement(TrajectoryStatsHeader, { sessionId: SID, useSession }))
    expect(container.firstChild).toBeNull()
    render(createElement(TrajectoryView as FC<ConvViewProps>, {
      sessionId: SID, useSession, useSelection: () => null,
      actions: { openDetails: vi.fn(), loadOlder: vi.fn() }, slots: undefined,
    } as unknown as ConvViewProps))
    expect(screen.getByText('暂无轨迹数据')).toBeTruthy()
  })
})

describe('WaterfallView standalone branches', () => {
  const props = (nodes: ConversationSnapshot['nodes']) => ({
    sessionId: SID, useSession: fakeSession(nodes).useSession, useSelection: () => null,
    actions: { openDetails: vi.fn(), loadOlder: vi.fn() }, slots: undefined,
  } as unknown as ConvViewProps)

  it('empty window renders the placeholder copy', () => {
    render(createElement(WaterfallView as FC<ConvViewProps>, props([] as unknown as ConversationSnapshot['nodes'])))
    expect(screen.getByText('暂无瀑布数据')).toBeTruthy()
  })

  it('a turn without tool calls renders the node bar only', () => {
    const nodes = [{ kind: 'user', seq: 1 }] as unknown as ConversationSnapshot['nodes']
    render(createElement(WaterfallView as FC<ConvViewProps>, props(nodes)))
    expect(screen.getByTitle('1 nodes')).toBeTruthy()
    expect(screen.queryByTitle(/tool calls/)).toBeNull()
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(nodeApply()).toBeUndefined()
  })
})
