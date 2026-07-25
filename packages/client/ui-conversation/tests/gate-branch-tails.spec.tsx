// @vitest-environment jsdom
// Final branch tails for the coverage gate, terminal slot form:
// AssistantMarkdown non-final reasoning, StatsLine usage-less node,
// DetailsPanel titleless selection. (The old cwd WeakMap-cache account
// retired with the mechanism — derivation lives in EmptyState now, covered
// by the skeleton specs.)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createChatStore } from '../src/client/stores.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [],
    pending: [], running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, lastAgentError: null,
  } as ConversationSnapshot
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
    expect(view.getByText('cache hit 0% · 15 tokens · 2 turns · 3 steps')).toBeTruthy()
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
      { ids: [], byId: {}, current: undefined } as SessionListState)
    const view = render(
      <DetailsPanel
        sessionId={SID}
        useSession={bindSnapshotSelector({ getSnapshot: () => snap, subscribe: () => () => {} }) as unknown as UseSession<ConversationSnapshot>}
        useSessions={bindSnapshotSelector(emptyList)}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
      />,
    )
    expect(view.getByText('详情')).toBeTruthy()
    expect(view.getByText('该调用不在当前窗口内')).toBeTruthy()
  })
})
