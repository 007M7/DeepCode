// @vitest-environment jsdom
// Remaining chat branch tails: MessageItem context/unknown/steering arms,
// ToolViewOutlet inject cache + crash fallback + retry, StatsLine no-cache
// join, PendingCard reason strip, AssistantMarkdown single-line reasoning,
// ChatView view-body fallbacks, and apply's action lambdas.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { act } from '@testing-library/react'
import type { SessionId, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { hookOf } from './hook.ts'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolViewProps, Translate } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MessageItem } from '../src/client/chat/MessageItem.tsx'
import { PendingCard } from '../src/client/chat/PendingCard.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { ToolViewOutlet } from '../src/client/chat/ToolViewOutlet.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

const result = (callId: string): ToolResultNode => ({
  kind: 'tool-result', seq: 3, callId,
  call: { name: 'bash', argsRaw: '{"command":"x"}' },
  content: [], isError: false, callView: null, resultView: null,
})

const viewProps = (): ToolViewProps => ({
  callId: 'c1', toolName: 'bash', block: result('c1'),
  useSession: (() => { throw new Error('unused') }) as unknown as UseSession,
  actions: { openDetails: vi.fn() },
  t: ((k: string) => k) as Translate,
})

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
      <StatsLine sessionId={SID} useSession={hookOf(source) as unknown as UseSession} />,
    )
    expect(view.getByText('10 tokens · 1 turns · 1 steps')).toBeTruthy()
  })
})

describe('ToolViewOutlet dispatch', () => {
  it('caches the inject factory per (registration x session) and merges its props', () => {
    const registry = new ToolViewRegistry()
    const inject = vi.fn((sessionId: SessionId) => ({ extra: `injected:${sessionId}` }))
    registry.register('bash',
      (p: ToolViewProps & { extra: string }) => <div data-testid="row">{p.extra}</div>,
      { inject })
    // Pure props machinery: the outlet feeds its own sessionId to the
    // factory — no provider/context needed (terminal channel form).
    const view = render(
      <ToolViewOutlet registry={registry} sessionId={SID} toolName="bash" viewProps={viewProps()} />,
    )
    expect(view.getByTestId('row').textContent).toBe(`injected:${SID}`)
    expect(inject).toHaveBeenCalledTimes(1)
    // Remount under the SAME session: cache hit, factory not re-run.
    view.unmount()
    const second = render(
      <ToolViewOutlet registry={registry} sessionId={SID} toolName="bash" viewProps={viewProps()} />,
    )
    expect(second.getByTestId('row').textContent).toBe(`injected:${SID}`)
    expect(inject).toHaveBeenCalledTimes(1)
    // A different session is a distinct cache key: factory runs once more.
    second.unmount()
    const other = render(
      <ToolViewOutlet registry={registry} sessionId={'s2' as SessionId} toolName="bash" viewProps={viewProps()} />,
    )
    expect(other.getByTestId('row').textContent).toBe('injected:s2')
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('a crashing custom row falls back to GenericToolCard and retries on re-registration', () => {
    const registry = new ToolViewRegistry()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // React dev builds re-dispatch boundary-caught errors as window 'error'
    // events (invokeGuardedCallback); swallow them so vitest sees the caught path.
    const swallow = (e: Event): void => { e.preventDefault() }
    window.addEventListener('error', swallow)
    try {
      const Bomb = () => { throw new Error('row bomb') }
      registry.register('bash', Bomb as never)
      const view = render(
        <ToolViewOutlet registry={registry} sessionId={SID} toolName="bash" viewProps={viewProps()} />,
      )
      // Crash caught: generic row rendered instead.
      expect(view.getByText('Bash')).toBeTruthy()
      // A new registration bumps the version; the boundary retries the custom row.
      act(() => { registry.register('bash', (() => <div data-testid="fixed" />) as never) })
      expect(view.getByTestId('fixed')).toBeTruthy()
    } finally {
      window.removeEventListener('error', swallow)
      consoleError.mockRestore()
    }
  })

  it('registry miss renders the generic row directly', () => {
    const registry = new ToolViewRegistry()
    const view = render(
      <ToolViewOutlet registry={registry} sessionId={SID} toolName="bash" viewProps={viewProps()} />,
    )
    expect(view.getByText('Bash')).toBeTruthy()
  })
})
