// @vitest-environment jsdom
// Final branch tails for the coverage gate, post slot-phase-2: apply's need()
// throw + cwd cache hit/empty-cwd skip, AssistantMarkdown non-final reasoning,
// StatsLine usage-less node, ChatView tool-group selected passthrough +
// running-empty guard, DetailsPanel titleless selection, registry disposer
// after a foreign removal emptied the list.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Context } from 'cordis'
import { createSnapshotStore, bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

afterEach(cleanup)

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  } as ConversationSnapshot
}

describe('apply need() and cwd cache', () => {
  it('apply fails loud when a required service is absent', () => {
    // Call apply directly (no fiber machinery): need('sessions') on a bare
    // context throws synchronously — the loud-failure branch without the
    // fiber runner's internal rejection surface. Mount semantics (inject
    // gating) are covered by the full bench in apply-inject.spec.
    void inject
    const ctx = new Context()
    expect(() => { (apply as (c: Context) => void)(ctx) }).toThrow(/sessions service unavailable/)
  })

  it('cwd derivation caches per list state and skips empty cwd values', async () => {
    const ctx = new Context()
    const slotsFiber = ctx.plugin(SlotsService)
    await slotsFiber.await()
    const listStore = createSnapshotStore<SessionListState>({
      ids: [SID, 'x2' as SessionId, 'x3' as SessionId],
      byId: {
        [SID]: { id: SID, title: 'a', cwd: '/proj', running: false, updatedAt: 1 },
        ['x2' as SessionId]: { id: 'x2' as SessionId, title: 'b', cwd: '', running: false, updatedAt: 1 },
        ['x3' as SessionId]: { id: 'x3' as SessionId, title: 'c', running: false, updatedAt: 1 },
      },
    })
    ctx.provide('sessions', { list: listStore, manager: { get: vi.fn() }, ancestry: () => [], scope: () => undefined, create: vi.fn() })
    ctx.provide('layout', { current: createSnapshotStore<{ viewFor: Record<string, string> }>({ viewFor: {} }), open: vi.fn(), openView: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() })
    ctx.provide('i18n', { bind: () => (k: string) => k })
    const slots = ctx.get('slots') as SlotsService
    slots.define('conversation', { kind: 'single', scope: 'session' })
    slots.define('details', { kind: 'single', scope: 'session' })
    slots.define('conversation.empty', { kind: 'single', scope: 'root' })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('conversation.empty')[0]! as unknown as {
      options: { inject: (b: unknown) => { useCwds: (sel: (s: readonly string[]) => readonly string[]) => readonly string[] } }
    }
    const injected = entry.options.inject({ ctx })
    const Probe = () => {
      const cwds = injected.useCwds(s => s)
      const again = injected.useCwds(s => s)
      // Cache hit: same state object yields the same derived array reference.
      return <i data-testid="cwds">{`${cwds.join(',')}|${String(cwds === again)}`}</i>
    }
    const view = render(<Probe />)
    expect(view.getByTestId('cwds').textContent).toBe('/proj|true')
  })
})

describe('render branch tails', () => {
  it('AssistantMarkdown reasoning row is ok-state when not the streaming tail', () => {
    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'reasoning', text: 'done thinking' }, { kind: 'text', text: 'answer' }]}
        streaming
      />,
    )
    // reasoning at index 0 with a later block: running is false → ok state.
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('StatsLine skips usage-less nodes and defaults each absent counter to zero', () => {
    const snap = {
      nodes: [
        { kind: 'assistant', seq: 1, turn: 1, step: 1, blocks: [] },
        { kind: 'assistant', seq: 2, turn: 1, step: 2, blocks: [], usage: { inputTokens: 4, outputTokens: 6 } },
        // outputTokens absent: the tokens sum's ?? 0 arm for output.
        { kind: 'assistant', seq: 3, turn: 2, step: 1, blocks: [], usage: { inputTokens: 5 } },
      ],
    }
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsLine sessionId={SID} useSession={bindSnapshotSelector(source) as unknown as UseSession} />,
    )
    expect(view.getByText('cache hit 0% · 15 tokens · 2 turns · 3 steps')).toBeTruthy()
  })

  it('AssistantMarkdown reasoning as the streaming tail renders the running ring', () => {
    const view = render(
      <AssistantMarkdown blocks={[{ kind: 'reasoning', text: 'still thinking' }]} streaming />,
    )
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('DetailsPanel title falls to 详情 when the selection has no toolName and no material', () => {
    const SEL: SelectionTarget = { turnSeq: 1, callId: 'ghost' }
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snapshotBase(), subscribe: () => () => {} }) as unknown as UseSession}
        useSelection={bindSnapshotSelector({ getSnapshot: () => SEL, subscribe: () => () => {} })}
        actions={{ closeDetails: vi.fn() }}
      />,
    )
    expect(view.getByText('详情')).toBeTruthy()
    expect(view.getByText('该调用不在当前窗口内')).toBeTruthy()
  })

  it('registry disposer tolerates the list already emptied by a sibling disposer', () => {
    const registry = new ToolViewRegistry()
    const offA = registry.register('bash', () => null)
    const offB = registry.register('bash', () => null)
    offA()
    offB()
    // Both entries gone; a re-register works from a fresh list.
    registry.register('bash', () => null)
    expect(registry.resolve('bash', SID)).toBeDefined()
  })
})
