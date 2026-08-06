// @vitest-environment jsdom
// Remaining chat branch tails: MessageItem context/unknown arms,
// user IconActions, StatsLine no-cache join,
// AssistantMarkdown single-line reasoning. (Tool-row dispatch tails live
// with the keyed-slot machinery specs since the tool ring dissolved into
// renderSlot.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  formatMessageClock, msUntilNextLocalMidnight, startOfLocalDay,
} from '../src/client/chat/message-chrome.ts'
import { MessageItem, type MessageItemProps } from '../src/client/chat/MessageItem.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine, type StatsLineProps } from '../src/client/chat/StatsLine.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Mirrors the real lookup chain (conversation namespace, then common).
const t: MessageItemProps['t'] = makeTranslate(zh, commonZh)

describe('MessageItem arms', () => {
  it('user bubbles expose clock / copy / branch and no edit; copy writes the text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    // Same-day clock: construct "today at 14:24" so the label stays `HH:mm`.
    const now = new Date()
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 24).getTime()
    const onFork = vi.fn()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'hello bubble' }] as never,
        source: null,
      }}
      onFork={onFork}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '在新对话中分支' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('hello bubble')
    fireEvent.click(screen.getByRole('button', { name: '在新对话中分支' }))
    expect(onFork).toHaveBeenCalledWith(1)
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
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'fallback body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('keeps an unavailable branch focusable and explains why without sending a fork', () => {
    const onFork = vi.fn()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'open turn' }] as never,
        source: null,
      }}
      onFork={onFork}
      forkUnavailable
      />,
    )
    const branch = screen.getByRole('button', { name: '在新对话中分支' }) as HTMLButtonElement
    expect(branch.disabled).toBe(false)
    expect(branch.getAttribute('aria-disabled')).toBe('true')
    const reasonId = branch.getAttribute('aria-describedby')
    expect(reasonId).not.toBeNull()
    expect(document.getElementById(reasonId!)?.textContent).toBe('仅可从已完成轮次的最后一条消息分支')
    fireEvent.click(branch)
    expect(onFork).not.toHaveBeenCalled()
    fireEvent.focus(branch)
    expect(screen.getByRole('tooltip').textContent).toBe('仅可从已完成轮次的最后一条消息分支')
  })

  it('user copy never claims success when the host rejects the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'quiet' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('copy swaps to the check success chrome, gates re-clicks, and reverts after a second', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    const copy = screen.getByRole('button', { name: '复制' })
    fireEvent.click(copy)
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledTimes(1)
    // Two microtask ticks: writeClipboard's own await, then the .then that
    // lands the success chrome.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const done = screen.getByRole('button', { name: '复制成功' })
    fireEvent.click(done)
    expect(writeText).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('clears copy feedback work when the message unmounts', async () => {
    vi.useFakeTimers()
    let finishWrite!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const view = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    view.unmount()
    await act(async () => {
      finishWrite()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(0)

    const mounted = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 2, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('context uses the Tool calls disclosure chrome and keeps its JSON collapsed by default', () => {
    const ctxView = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'x\n"y":,[{}]' }],
        source: { kind: 'plugin', plugin: 'fixture', empty: {}, list: [] },
      } as never}
      />,
    )
    const disclosure = ctxView.getByRole('button', { name: '上下文注入' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(ctxView.container.querySelector('[data-context-injection-body]')).toBeNull()
    expect(ctxView.container.querySelector('svg')).not.toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(ctxView.container.querySelector('[data-context-injection-body]')?.textContent).toBe(
      '{ "content": [ { "type": "text", "text": "x\\n\\"y\\":,[{}]" } ], '
      + '"source": { "kind": "plugin", "plugin": "fixture", "empty": {}, "list": [] } }',
    )

    fireEvent.keyDown(disclosure, { key: ' ' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('context preserves the bounded JSON truncation contract', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'x'.repeat(21_000) }],
        source: null,
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '上下文注入' }))
    expect(view.container.querySelector('[data-context-injection-body]')?.textContent)
      .toMatch(/… 已截断，共 \d+ 字符$/)
  })

  it('unknown nodes retain the generic JSON row', () => {
    const unknownView = render(
      <MessageItem t={t} node={{ kind: 'unknown', seq: 4, type: 'surface/next', data: { x: 1 } } as never} />,
    )
    expect(unknownView.getByText(/未知 surface 事件：surface\/next/)).toBeTruthy()
  })

  it('a compaction marker discloses its summary and never shows the framed checkpoint', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'compaction', seq: 5, time: 1_000,
        summary: '## 摘要标题\n\n保留的事实。',
      }}
      />,
    )
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/保留的事实/)).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('heading', { name: '摘要标题' })).toBeTruthy()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('a marker whose provenance fell outside the window is not expandable', () => {
    const view = render(<MessageItem t={t} node={{ kind: 'compaction', seq: 6, time: 1_000, summary: null }} />)
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row).toHaveProperty('disabled', true)
    expect(row.getAttribute('aria-expanded')).toBeNull()
    expect(view.getByText('压缩摘要不可用')).toBeTruthy()
    fireEvent.click(row) // a disabled control stays collapsed
    expect(row.getAttribute('aria-expanded')).toBeNull()
  })

  it('collapses retry details behind the durable model retry status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const view = render(
      <MessageItem
        t={t}
        retryActive
        node={{
          kind: 'model-retry',
          seq: 5,
          time: 10_000,
          retryState: 'scheduled',
          turn: 1,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 1,
          maxRetries: 2,
          delayMs: 2_500.4,
          failure: { code: 'TRANSPORT', message: '连接被重置' },
        }}
      />,
    )
    const details = view.container.querySelector('details')
    const summary = view.container.querySelector('summary')
    expect(details?.open).toBe(false)
    expect(details?.dataset.active).toBe('true')
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 3s')
    expect(view.getByText('重试延迟：').parentElement?.textContent).toBe('重试延迟：2500ms')
    expect(view.getByText('失败原因：').parentElement?.textContent).toBe('失败原因：连接被重置')

    act(() => { vi.advanceTimersByTime(1_100) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 2s')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    view.rerender(
      <MessageItem
        t={t}
        retryActive
        node={{
          kind: 'model-retry',
          seq: 6,
          time: 12_100,
          retryState: 'scheduled',
          turn: 2,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 2,
          maxRetries: 2,
          delayMs: 3_500.4,
          failure: { code: 'TRANSPORT', message: '再次断开' },
        }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 4s')

    if (summary === null) throw new Error('retry summary missing')
    fireEvent.click(summary)
    expect(details?.open).toBe(true)

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        seq: 6,
        time: 12_100,
        retryState: 'started',
        turn: 2,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '再次断开' },
      }}
      />,
    )
    expect(details?.dataset.active).toBeUndefined()
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（2/2） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        seq: 7,
        time: 12_100,
        retryState: 'started',
        turn: 3,
        step: 0,
        provider: 'mock',
        mode: 'always',
        policyKey: 'mock-always',
        retry: 3,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '继续重试' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（3/∞） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        seq: 8,
        time: 12_100,
        retryState: 'cancelled',
        turn: 4,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '用户取消' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('模型请求重试已取消（1/2） · 4s')
  })

  it('synchronizes the countdown when an inactive retry becomes active at the one-second floor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const node = {
      kind: 'model-retry',
      seq: 5,
      time: 10_000,
      retryState: 'scheduled',
      turn: 1,
      step: 0,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'mock-normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 5_000,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
    } as const
    const view = render(<MessageItem t={t} node={node} />)
    expect(view.getByRole('status').textContent).toBe('等待重试模型请求（1/2） · 5s')

    act(() => { vi.advanceTimersByTime(4_200) })
    view.rerender(<MessageItem t={t} node={node} retryActive />)
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')
  })
})

describe('formatMessageClock', () => {
  const now = new Date(2026, 6, 29, 10, 0).getTime()

  it('keeps HH:mm on the same calendar day', () => {
    expect(formatMessageClock(new Date(2026, 6, 29, 14, 24).getTime(), t, now)).toBe('14:24')
  })

  it('prefixes month and day across days in the same year', () => {
    expect(formatMessageClock(new Date(2026, 0, 1, 14, 24).getTime(), t, now)).toBe('1月1日 14:24')
  })

  it('prefixes year, month, and day across years', () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 9, 5).getTime(), t, now)).toBe('2025年12月31日 09:05')
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
      <MessageItem t={t} node={{
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
      <AssistantMarkdown t={t} blocks={[{ kind: 'reasoning', text: 'one-liner' }]} streaming={false} />,
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
    const onFork = vi.fn()
    const settled = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'text', text: 'answer body' }, { kind: 'reasoning', text: 'hidden' }]}
        streaming={false}
        time={time}
        seq={3}
        onFork={onFork}
      />,
    )
    expect(settled.getByText('14:24')).toBeTruthy()
    expect(settled.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(settled.getByRole('button', { name: '在新对话中分支' })).toBeTruthy()
    fireEvent.click(settled.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('answer body')
    fireEvent.click(settled.getByRole('button', { name: '在新对话中分支' }))
    expect(onFork).toHaveBeenCalledWith(3)
    settled.unmount()

    const thinkOnly = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'only thinking' }]}
        streaming={false}
        time={time}
      />,
    )
    expect(thinkOnly.queryByRole('button', { name: '复制' })).toBeNull()
    expect(thinkOnly.queryByText('14:24')).toBeNull()
    thinkOnly.unmount()

    const streaming = render(
      <AssistantMarkdown t={t} blocks={[{ kind: 'text', text: 'partial' }]} streaming time={time} />,
    )
    expect(streaming.queryByRole('button', { name: '复制' })).toBeNull()
    expect(streaming.queryByText('14:24')).toBeNull()
  })

  it('StatsLine omits the cache-hit segment when no input accounting exists at all', () => {
    // Cache hit is null only when all three prompt buckets are zero (pure
    // output accounting) — any billed input makes it a real 0%.
    const snap = {
      nodes: [{ kind: 'assistant', seq: 1, turn: 1, step: 1, blocks: [], usage: { outputTokens: 10 } }],
    }
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsLine
        useSession={bindSnapshotSelector(source) as unknown as StatsLineProps['useSession']}
        useProjection={(key: string) => key === 'tokenUsage'
          ? { uncachedInputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : undefined}
      />,
    )
    expect(view.container.textContent).toBe('1 turns · 1 steps| Input 0 tok · Output 10 tok')
  })
})
