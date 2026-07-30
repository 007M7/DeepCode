// @vitest-environment jsdom
// ConversationService scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationService } from '../src/client/service.ts'

async function bench(readAttachment?: SessionFace['readAttachment']) {
  const runtime = await SlotTestRuntime.create()
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: { prompt, updateQueue, cancel, loadOlder, ...(readAttachment === undefined ? {} : { readAttachment }) },
  })
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx)
  const fiber = runtime.ctx.plugin(ConversationService, { input: hub })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationService
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationService
  return { runtime, fiber, hub, root, scoped, prompt, updateQueue, cancel, loadOlder }
}

describe('ConversationService', () => {
  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello', 'steer')
    await b.scoped.updateQueue('item-1' as never, { kind: 'remove' })
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'steer')
    expect(b.updateQueue).toHaveBeenCalledWith('item-1', { kind: 'remove' })
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

  it('checks media type before preview allocation and leaves deployment limits to the host', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(file => `blob:${(file as File).name}`)
    try {
      const files = Array.from(
        { length: 11 },
        (_, index) => new File([Uint8Array.of(index)], `${index}.png`, { type: 'image/png' }),
      )
      expect(b.root.createDraftImages(files)).toHaveLength(11)
      expect(created).toHaveBeenCalledTimes(11)

      const beforeRejectedBatch = created.mock.calls.length
      expect(() => {
        b.root.createDraftImages([
          new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
          new File([Uint8Array.of(2)], 'invalid.svg', { type: 'image/svg+xml' }),
        ])
      }).toThrow('不支持的图片格式：image/svg+xml')
      expect(created).toHaveBeenCalledTimes(beforeRejectedBatch)
    } finally {
      created.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('releases in-flight send images when the scope dies before the failure lands', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:inflight-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([new File([new Uint8Array(4)], 'b.png', { type: 'image/png' })])
      if (attachment === undefined) throw new Error('draft attachment missing')
      const shell = b.hub.shell(b.runtime.sessions.behavior('s1').sessionId)
      shell.addImages([attachment.id])
      let reject!: (error: Error) => void
      b.prompt.mockReturnValueOnce(new Promise((_resolve, rej) => { reject = rej }) as never)
      shell.setDraft('x')
      shell.submit('queue')
      // commitSend already removed the ids from the shell; kill the scope
      // while the RPC is still pending, then land the failure.
      await b.runtime.sessions.remove('s1')
      reject(new Error('transport died'))
      await vi.waitFor(() => {
        expect(revoked).toHaveBeenCalledWith('blob:inflight-1')
      })
      expect(b.root.draftImages([attachment.id])).toEqual([])
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('does not publish a historical image URL after disposal', async () => {
    let resolveRead!: (result: Awaited<ReturnType<SessionFace['readAttachment']>>) => void
    const readAttachment: SessionFace['readAttachment'] = vi.fn(() => new Promise<Awaited<ReturnType<SessionFace['readAttachment']>>>(
      (resolve) => { resolveRead = resolve },
    ))
    const b = await bench(readAttachment)
    const created = vi.spyOn(URL, 'createObjectURL')
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const attachment = {
      attachmentId: AttachmentId('image-1'),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    } as const
    const pending = b.root.resolveImage(sessionId, attachment)
    await b.fiber.dispose()
    await expect(b.root.resolveImage(sessionId, attachment)).rejects.toThrow('service is disposed')
    resolveRead({
      ok: true,
      value: {
        attachment,
        data: Uint8Array.of(1),
      },
    })
    await expect(pending).rejects.toThrow('service was disposed before loading completed')
    expect(created).not.toHaveBeenCalled()
    created.mockRestore()
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
