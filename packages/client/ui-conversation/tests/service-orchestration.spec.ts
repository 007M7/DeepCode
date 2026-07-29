// @vitest-environment jsdom
// ConversationService scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { InputHub } from '../src/client/input/hub.ts'

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: { prompt, cancel, loadOlder },
  })
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx)
  const fiber = runtime.ctx.plugin(ConversationService, { input: hub })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationService
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationService
  return { runtime, hub, root, scoped, prompt, cancel, loadOlder }
}

describe('ConversationService', () => {
  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello', 'steer')
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'steer')
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    await b.runtime.dispose()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } as never)
    await expect(b.scoped.send('x', 'queue')).rejects.toThrow('conversation.send failed: agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope', details: {} } } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: internal: nope')
    await b.runtime.dispose()
  })

  it('releases draft images when the session scope is disposed', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })])
      if (attachment === undefined) throw new Error('draft attachment missing')
      // Land the id in the session shell exactly as the composer does.
      b.hub.shell(b.runtime.sessions.behavior('s1').sessionId).addImages([attachment.id])
      await b.runtime.sessions.remove('s1')
      // Scope teardown released the service-held File and its object URL.
      expect(b.root.draftImages([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('fails loudly from the root scope, on an unbound session, or without SessionsService', async () => {
    const b = await bench()
    await expect(b.root.send('x', 'queue')).rejects.toThrow(/requires a session scope/)
    await b.runtime.sessions.remove('s1')
    await expect(b.scoped.send('x', 'queue')).rejects.toThrow(/resolved no binding/)
    await b.runtime.dispose()
    // No SessionsService at all: a bare context (the runtime always provides one).
    const bare = new Context()
    await bare.plugin(ConversationService, {
      input: new InputHub(bare),
    }).await()
    const orphan = bare.get('conversation') as ConversationService
    await expect(orphan.send('x', 'queue')).rejects.toThrow(/sessions service unavailable/)
  })
})
