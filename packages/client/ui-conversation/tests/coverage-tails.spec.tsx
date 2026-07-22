// @vitest-environment jsdom
// Branch tails the acceptance specs do not reach: ToolRow stopped-state dot,
// PendingCard question arm, bash sample error pill, registry disposer
// idempotence re-entry, register.ts explicit bashSampleScope override, the
// node-half empty apply, and AssistantMarkdown reasoning/unknown block arms.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { UseSession } from '@deepseek-ai/dsh-client-web-react'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationService, Translate, ToolViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as nodeApply } from '../src/index.ts'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import { ToolRow } from '../src/client/chat/ToolRow.tsx'
import { PendingCard } from '../src/client/chat/PendingCard.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { BashRow } from '../src/client/toolviews/bash-sample.tsx'
import { registerChat } from '../src/client/chat/register.ts'

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
      <PendingCard item={{ kind: 'question', rpcId: 'r1' as RpcId, questions: [{}, {}] }} />,
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
      kind: 'tool-result', seq: 2, callId: 'c5',
      call: { name: 'todo_write', argsRaw: '{"note":"x"}' },
      content: [], isError: false, callView: null, resultView: null,
    }
    const props: ToolViewProps = {
      callId: 'c5', toolName: 'todo_write', block: settled,
      useSession: (() => { throw new Error('unused') }) as unknown as UseSession,
      actions: { openDetails: vi.fn() },
      t: ((k: string) => k) as Translate,
    }
    const view = render(<GenericToolCard {...props} />)
    // Settled ok state keeps the variant icon (sparkle) instead of a StateDot.
    expect(view.container.querySelector('[data-variant="others"] svg')).not.toBeNull()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('BashRow shows the failed pill on error results', () => {
    const errorResult: ToolResultNode = {
      kind: 'tool-result', seq: 1, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"boom"}' },
      content: [], isError: true, callView: null, resultView: null,
    }
    const props: ToolViewProps = {
      callId: 'c1', toolName: 'bash', block: errorResult,
      useSession: (() => { throw new Error('unused') }) as unknown as UseSession,
      actions: { openDetails: vi.fn() },
      t: ((k: string) => k) as Translate,
    }
    const view = render(<BashRow {...props} />)
    expect(view.getByText('failed')).toBeTruthy()
  })

  it('registry disposer re-entry is a no-op after the entry was already removed', () => {
    const registry = new ToolViewRegistry()
    const off = registry.register('bash', (() => null) as never)
    const v1 = registry.getVersion()
    off()
    const v2 = registry.getVersion()
    off()
    expect(registry.getVersion()).toBe(v2)
    expect(v2).toBeGreaterThan(v1)
  })

  it('registerChat registers the chat view with the stats footer and disposes cleanly', () => {
    const disposer = vi.fn()
    const calls: unknown[] = []
    const conversation = {
      registerView: (entry: unknown) => {
        calls.push(entry)
        return disposer
      },
    } as unknown as ConversationService
    const toolviews = new ToolViewRegistry()
    const off = registerChat({ conversation, toolviews, t: ((k: string) => k) as Translate })
    const entry = calls[0] as { id: string; chrome?: { footer?: unknown } }
    expect(entry.id).toBe('chat')
    // footer is a memo exotic component (object, not plain function).
    expect(entry.chrome?.footer).toBeDefined()
    off()
    expect(disposer).toHaveBeenCalledTimes(1)
  })
})
