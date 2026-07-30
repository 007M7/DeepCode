// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createChatStore } from '../src/client/stores.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

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
      <StatsLine useSession={bindSnapshotSelector(source) as unknown as UseSession<ConversationSnapshot>} />,
    )
    expect(view.container.textContent).toBe('2 turns · 3 steps|Cache hit 0%|Input 9 tok · Output 6 tok')
  })

  it('AssistantMarkdown reasoning as the streaming tail renders the running ring', () => {
    const view = render(
      <AssistantMarkdown blocks={[{ kind: 'reasoning', text: 'still thinking' }]} streaming />,
    )
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('DetailsPanel title falls to 详情 when the selection has no toolName and no material', () => {
    localStorage.clear()
    const snap = snapshotBase()
    const chat = createChatStore().create()
    chat.actions.select({ turnSeq: 1, callId: 'ghost' } satisfies SelectionTarget)
    const emptyList = createSnapshotStore<SessionListState>(
      { ids: [], byId: {}, current: undefined, phase: 'ready' })
    const emptyWorkspaces = createSnapshotStore<WorkspaceListState>({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snap, subscribe: () => () => {} })}
        useSessions={bindSnapshotSelector(emptyList)}
        useWorkspaces={bindSnapshotSelector(emptyWorkspaces)}
        useProjection={(() => undefined)}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{ setDraft: () => {}, submit: () => {} }}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
      />,
    )
    expect(view.getByText('详情')).toBeTruthy()
    expect(view.getByText('该调用不在当前窗口内')).toBeTruthy()
  })

  it('DetailsPanel resolves a run_code sub-callId to its full logged args and output', () => {
    localStorage.clear()
    const snap = snapshotBase()
    const longText = 'x'.repeat(1_000)
    snap.codeDispatches = new Map([['p1', [{
      kind: 'tool-result', seq: 8, time: 8_000, callId: 'p1:code:1',
      call: { name: 'read', argsRaw: '{"path":"notes/demo.txt"}' },
      callTime: 8_000,
      content: [{ type: 'text', text: longText }], isError: false, callView: null, resultView: null,
    }]]])
    const chat = createChatStore().create()
    chat.actions.select({ turnSeq: 8, callId: 'p1:code:1', toolName: 'read' } satisfies SelectionTarget)
    const emptyList = createSnapshotStore<SessionListState>(
      { ids: [], byId: {}, current: undefined, phase: 'ready' })
    const emptyWorkspaces = createSnapshotStore<WorkspaceListState>({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snap, subscribe: () => () => {} })}
        useSessions={bindSnapshotSelector(emptyList)}
        useWorkspaces={bindSnapshotSelector(emptyWorkspaces)}
        useProjection={(() => undefined)}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{ setDraft: () => {}, submit: () => {} }}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
      />,
    )
    // Sub-call material: the sub-tool name titles the panel, args pretty-print,
    // and the COMPLETE logged output renders (no truncation anywhere).
    expect(view.getByText('read')).toBeTruthy()
    expect(view.getByText(/notes\/demo\.txt/)).toBeTruthy()
    expect(view.getByText(longText)).toBeTruthy()
  })
})
