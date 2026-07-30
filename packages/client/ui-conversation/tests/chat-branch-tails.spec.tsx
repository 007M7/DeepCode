// @vitest-environment jsdom
// Remaining chat branch tails: MessageItem context/unknown/steering arms,
// user IconActions, StatsLine no-cache join,
// AssistantMarkdown single-line reasoning. (Tool-row dispatch tails live
// with the keyed-slot machinery specs since the tool ring dissolved into
// renderSlot.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import {
  formatMessageClock, msUntilNextLocalMidnight, startOfLocalDay,
} from '../src/client/chat/message-chrome.ts'
import { MessageItem } from '../src/client/chat/MessageItem.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'

afterEach(cleanup)

describe('MessageItem arms', () => {
  it('user bubbles expose clock / copy / branch / edit; copy writes the text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    // Same-day clock: construct "today at 14:24" so the label stays `HH:mm`.
    const now = new Date()
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 24).getTime()
    render(
      <MessageItem node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'hello bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
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
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'fallback body' }] as never,
        source: null,
      }}
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
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'quiet' }] as never,
        source: null,
      }}
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
      <MessageItem node={{ kind: 'context', seq: 3, content: [], source: null } as never} />,
    )
    expect(ctxView.getByText(/上下文注入/)).toBeTruthy()
    const unknownView = render(
      <MessageItem node={{ kind: 'unknown', seq: 4, type: 'surface/next', data: { x: 1 } } as never} />,
    )
    expect(unknownView.getByText(/未知 surface 事件：surface\/next/)).toBeTruthy()
  })
})

describe('formatMessageClock', () => {
  const now = new Date(2026, 6, 29, 10, 0).getTime()

  it('keeps HH:mm on the same calendar day', () => {
    expect(formatMessageClock(new Date(2026, 6, 29, 14, 24).getTime(), now)).toBe('14:24')
  })

  it('prefixes month and day across days in the same year', () => {
    expect(formatMessageClock(new Date(2026, 0, 1, 14, 24).getTime(), now)).toBe('1月1日 14:24')
  })

  it('prefixes year, month, and day across years', () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 9, 5).getTime(), now)).toBe('2025年12月31日 09:05')
  })

  it('arms the next local midnight from an in-day instant', () => {
    const noon = new Date(2026, 6, 29, 12, 0).getTime()
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 6, 29).getTime())
    expect(msUntilNextLocalMidnight(noon)).toBe(12 * 3_600_000)
  })
})

describe('useCalendarDay boundary refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('widens a same-day user clock after local midnight', () => {
    const dayStart = new Date(2026, 6, 29, 23, 50).getTime()
    vi.setSystemTime(dayStart)
    const time = new Date(2026, 6, 29, 14, 24).getTime()
    render(
      <MessageItem node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'night bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(msUntilNextLocalMidnight(dayStart) + 1)
    })
    expect(screen.getByText('7月29日 14:24')).toBeTruthy()
  })
})

describe('small branch tails', () => {
  it('AssistantMarkdown single-line reasoning summary skips the newline cut', () => {
    const view = render(
      <AssistantMarkdown blocks={[{ kind: 'reasoning', text: 'one-liner' }]} streaming={false} />,
    )
    expect(view.getByText('one-liner')).toBeTruthy()
  })

  it('finalized content messages expose copy / branch / clock; Think-only and streaming omit them', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const now = new Date()
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 24).getTime()
    const settled = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'answer body' }, { kind: 'reasoning', text: 'hidden' }]}
        streaming={false}
        time={time}
      />,
    )
    expect(settled.getByText('14:24')).toBeTruthy()
    expect(settled.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(settled.getByRole('button', { name: '在新对话中分支' })).toBeTruthy()
    fireEvent.click(settled.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('answer body')
    settled.unmount()

    const thinkOnly = render(
      <AssistantMarkdown
        blocks={[{ kind: 'reasoning', text: 'only thinking' }]}
        streaming={false}
        time={time}
      />,
    )
    expect(thinkOnly.queryByRole('button', { name: '复制' })).toBeNull()
    expect(thinkOnly.queryByText('14:24')).toBeNull()
    thinkOnly.unmount()

    const streaming = render(
      <AssistantMarkdown blocks={[{ kind: 'text', text: 'partial' }]} streaming time={time} />,
    )
    expect(streaming.queryByRole('button', { name: '复制' })).toBeNull()
    expect(streaming.queryByText('14:24')).toBeNull()
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
