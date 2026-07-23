// @vitest-environment jsdom
// Remaining chat branch tails: MessageItem context/unknown/steering arms,
// StatsLine no-cache join, PendingCard reason strip, AssistantMarkdown
// single-line reasoning. (Tool-row dispatch tails live with the keyed-slot
// machinery specs since the tool ring dissolved into renderSlot.)

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { MessageItem } from '../src/client/chat/MessageItem.tsx'
import { PendingCard } from '../src/client/chat/PendingCard.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'

afterEach(cleanup)

describe('MessageItem arms', () => {
  it('steering bubbles carry the interjection badge and non-text rest blocks', () => {
    const view = render(
      <MessageItem node={{
        kind: 'steering', seq: 2, turn: 1, source: null,
        content: [{ type: 'text', text: 'steer!' }, { type: 'image', data: 'x' }] as never,
      } as never}
      />,
    )
    expect(view.getByText('插话')).toBeTruthy()
    expect(view.getByText('steer!')).toBeTruthy()
    expect(view.getByText(/附加内容块/)).toBeTruthy()
  })

  it('context and unknown nodes render their JSON rows', () => {
    const ctxView = render(
      <MessageItem node={{ kind: 'context', seq: 3, content: [], source: null, meta: { k: 1 } } as never} />,
    )
    expect(ctxView.getByText(/上下文注入/)).toBeTruthy()
    const unknownView = render(
      <MessageItem node={{ kind: 'unknown', seq: 4, type: 'surface/next', data: { x: 1 } } as never} />,
    )
    expect(unknownView.getByText(/未知 surface 事件：surface\/next/)).toBeTruthy()
  })
})

describe('small branch tails', () => {
  it('PendingCard approval reason renders when present', () => {
    const view = render(
      <PendingCard item={{ kind: 'approval', rpcId: 'r1' as RpcId, approvalId: 'a1', toolName: 'rm', reason: 'careful' }} />,
    )
    expect(view.getByText('careful')).toBeTruthy()
  })

  it('AssistantMarkdown single-line reasoning summary skips the newline cut', () => {
    const view = render(
      <AssistantMarkdown blocks={[{ kind: 'reasoning', text: 'one-liner' }]} streaming={false} />,
    )
    expect(view.getByText('one-liner')).toBeTruthy()
  })

  it('StatsLine omits the cache-hit segment when no input accounting exists at all', () => {
    // cacheHitPct is null only when input+cacheRead are both zero (pure
    // output accounting) — any input makes it a real 0%.
    const snap = {
      nodes: [{ kind: 'assistant', seq: 1, turn: 1, step: 1, blocks: [], usage: { outputTokens: 10 } }],
    }
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsLine useSession={bindSnapshotSelector(source) as unknown as StatsLineProps['useSession']} />,
    )
    expect(view.getByText('10 tokens · 1 turns · 1 steps')).toBeTruthy()
  })
})
