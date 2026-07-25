// @vitest-environment jsdom
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (id: string) => id as SessionId
const SCOPE_TAG: symbol = (() => {
  const reads: (string | symbol)[] = []
  const proxy = new Proxy(new Context(), {
    get(target, property, receiver): unknown {
      reads.push(property)
      return Reflect.get(target, property, receiver)
    },
  })
  void scopeOf(proxy)
  return reads.find((value): value is symbol => typeof value === 'symbol')!
})()

async function bench(withSessions = true) {
  const ctx = new Context()
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  const updatePendingPrompt = vi.fn()
  const retryPendingPrompt = vi.fn()
  const sessions = {
    binding: (sessionId: SessionId) => ({
      sessionId, session: { prompt, cancel, loadOlder, updatePendingPrompt, retryPendingPrompt },
    }),
    scopeOf,
  } as unknown as SessionsService
  if (withSessions) ctx.provide('sessions', sessions)
  await ctx.plugin(ConversationService).await()
  const root = ctx.get('conversation') as ConversationService
  const scoped = ctx.plugin(() => {}).ctx.extend({ [SCOPE_TAG]: sid('s1') }).get('conversation') as ConversationService
  return { root, scoped, prompt, cancel, loadOlder, updatePendingPrompt, retryPendingPrompt }
}

describe('ConversationService', () => {
  it('routes ordinary and retained-prompt operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello', 'steer')
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    b.scoped.updatePendingPrompt('revised')
    b.scoped.retryPendingPrompt()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'steer')
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    expect(b.updatePendingPrompt).toHaveBeenCalledWith('revised')
    expect(b.retryPendingPrompt).toHaveBeenCalledOnce()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } as never)
    await expect(b.scoped.send('x', 'queue')).rejects.toThrow('conversation.send failed: agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope', details: {} } } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: internal: nope')
  })

  it('fails loudly from the root scope or without SessionsService', async () => {
    const b = await bench()
    await expect(b.root.send('x', 'queue')).rejects.toThrow(/requires a session scope/)
    const missing = await bench(false)
    await expect(missing.root.send('x', 'queue')).rejects.toThrow(/sessions service unavailable/)
  })
})
