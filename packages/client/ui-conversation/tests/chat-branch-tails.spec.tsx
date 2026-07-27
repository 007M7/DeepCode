// @vitest-environment jsdom
// Remaining chat branch tails: MessageItem context/unknown/steering arms,
// user IconActions, StatsLine no-cache join, PendingCard reason strip,
// AssistantMarkdown single-line reasoning. (Tool-row dispatch tails live
// with the keyed-slot machinery specs since the tool ring dissolved into
// renderSlot.)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { MessageItem } from '../src/client/chat/MessageItem.tsx'
import { PendingCard } from '../src/client/chat/PendingCard.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'

afterEach(cleanup)

describe('MessageItem arms', () => {
  it('user bubbles expose copy / branch / edit actions; copy writes the text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MessageItem node={{
        kind: 'user', seq: 1,
        content: [{ type: 'text', text: 'hello bubble' }] as never,
      } as never}
      />,
    )
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '在新对话中分支' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('hello bubble')
  })

  it('user copy falls back to execCommand when clipboard.writeText is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
    render(
      <MessageItem node={{
        kind: 'user', seq: 1,
        content: [{ type: 'text', text: 'fallback body' }] as never,
      } as never}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('user copy stays quiet when execCommand throws or is absent', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('denied')
      },
    })
    render(
      <MessageItem node={{
        kind: 'user', seq: 1,
        content: [{ type: 'text', text: 'quiet' }] as never,
      } as never}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: undefined,
    })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
  })

  it('steering bubbles carry the interjection badge and non-text rest blocks, without user actions', () => {
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
    expect(view.queryByRole('button', { name: '复制' })).toBeNull()
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
      <PendingCard item={new PendingWait('approval', RpcId('r1'), 's1' as SessionId, { approvalId: 'a1', toolName: 'rm', reason: 'careful' } as PendingWait<'approval'>['payload'], vi.fn())} />,
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
