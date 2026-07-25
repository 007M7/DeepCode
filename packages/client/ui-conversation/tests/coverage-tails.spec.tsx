// @vitest-environment jsdom
// Branch tails the acceptance specs do not reach: ToolRow stopped-state dot,
// PendingCard question arm, bash sample error pill, the node-half empty
// apply, and AssistantMarkdown reasoning/unknown block arms.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionListState, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { ToolRowOwnerProps, ToolRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as nodeApply } from '../src/index.ts'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import { ToolRow } from '../src/client/chat/ToolRow.tsx'
import { PendingCard } from '../src/client/chat/PendingCard.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { BashRow } from '../src/client/toolviews/bash-sample.tsx'

afterEach(cleanup)

describe('tails', () => {
  it('node-half apply is an intentional no-op', () => {
    expect(nodeApply()).toBeUndefined()
  })

  it('ToolRow stopped state renders the warning dot in the leading slot', () => {
    const view = render(
      <ToolRow variant="bash" icon={<i data-testid="icon" />} title="Bash" summary="s" body={null} state="stopped" />,
    )
    expect(view.queryByTestId('icon')).toBeNull()
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('PendingCard renders the question arm with its count', () => {
    const view = render(
      <PendingCard item={new PendingWait('question', RpcId('r1'), 's1' as SessionId, { questions: [{}, {}] } as PendingWait<'question'>['payload'], vi.fn())} />,
    )
    expect(view.getByText(/等待回答（2 题）/)).toBeTruthy()
  })

  it('AssistantMarkdown renders reasoning as a Think row and unknown blocks as JSON fallback', () => {
    const view = render(
      <AssistantMarkdown
        blocks={[
          { kind: 'reasoning', text: 'thinking hard\nsecond line' },
          { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' },
          { kind: 'other', block: { type: 'mystery' } },
        ]}
        streaming
      />,
    )
    expect(view.getByText('Think')).toBeTruthy()
    expect(view.getByText('thinking hard')).toBeTruthy()
    expect(view.getByText(/未知内容块/)).toBeTruthy()
    const stopped = render(
      <AssistantMarkdown blocks={[{ kind: 'text', text: 'partial words' }]} streaming={false} interrupted />,
    )
    expect(stopped.getByText('已停止')).toBeTruthy()
  })

  it('a settled others-variant row renders the sparkle icon in the leading slot', () => {
    const settled: ToolResultNode = {
      kind: 'tool-result', seq: 2, time: 2_000, callId: 'c5',
      call: { name: 'todo_write', argsRaw: '{"note":"x"}' },
      callTime: 1_000,
      content: [], isError: false, callView: null, resultView: null,
    }
    const props: ToolRowOwnerProps = {
      callId: 'c5', toolName: 'todo_write', block: settled, openDetails: vi.fn(),
    }
    const view = render(<GenericToolCard {...props} />)
    // Settled ok state keeps the variant icon (sparkle) instead of a StateDot.
    expect(view.container.querySelector('[data-variant="others"] svg')).not.toBeNull()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('BashRow shows the failed pill on error results (root session arm)', () => {
    const errorResult: ToolResultNode = {
      kind: 'tool-result', seq: 1, time: 1_000, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"boom"}' },
      callTime: 500,
      content: [], isError: true, callView: null, resultView: null,
    }
    // Root session (no parentId): the global arm renders, error pill visible.
    const sid = 'root-1' as SessionId
    const list = createSnapshotStore<SessionListState>({
      ids: [sid],
      byId: { [sid]: { id: sid, title: 'r', displayTitle: 'r', running: false, updatedAt: 0 } },
      current: undefined,
      intent: undefined,
      phase: 'ready',
    } as SessionListState)
    const props = {
      callId: 'c1', toolName: 'bash', block: errorResult, openDetails: vi.fn(),
      sessionId: sid, useSessions: bindSnapshotSelector(list),
    } as unknown as ToolRowProps
    const view = render(<BashRow {...props} />)
    expect(view.container.querySelector('[data-sample="bash-global"]')).not.toBeNull()
    expect(view.getByText('failed')).toBeTruthy()
  })
})
