// @vitest-environment jsdom
/**
 * ConversationService orchestration half after the store-seat slimming:
 * scope-addressed send/cancel (result folding, root throw), the startSession
 * chain (create → scoped send → sessions.open), and the service-unavailable
 * loud failures. Selection/draft state left this service for the declared
 * chat store (chat-store.spec.ts / selection-survival.spec.ts); the view
 * registry left for the 'conversation.view' slot (views-type-chain.spec.tsx).
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string): SessionId => s as SessionId

/** Recover the module-private scope tag through the public seam (same probe as apply-inject.spec). */
const SCOPE_TAG: symbol = (() => {
  const recorded: (string | symbol)[] = []
  const spy = new Proxy(new Context(), {
    get(target, prop, receiver): unknown {
      recorded.push(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  void scopeOf(spy)
  const symbol = recorded.find((p): p is symbol => typeof p === 'symbol')
  if (symbol === undefined) throw new Error('scopeOf probe recorded no symbol read')
  return symbol
})()

interface SessionDouble {
  prompt: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  readAttachment: ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function bench(opts?: {
  sessions?: boolean
  description?: ReturnType<SessionsService['hostDescription']>
}) {
  const ctx = new Context()
  const sessionDoubles = new Map<SessionId, SessionDouble>()
  const scopes = new Map<SessionId, Context>()
  const mint = (id: SessionId): Context => {
    let scoped = scopes.get(id)
    if (scoped === undefined) {
      const fiber = ctx.plugin(() => {})
      scoped = fiber.ctx.extend({ [SCOPE_TAG]: id })
      scopes.set(id, scoped)
    }
    return scoped
  }
  const createMock = vi.fn(() => Promise.resolve(sid('new-1')))
  const openMock = vi.fn()
  const sessionsFake = {
    manager: {
      get: (id: SessionId) => {
        let s = sessionDoubles.get(id)
        if (s === undefined) {
          s = {
            prompt: vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } })),
            cancel: vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } })),
            readAttachment: vi.fn(() => Promise.reject(new Error('attachment response not configured'))),
          }
          sessionDoubles.set(id, s)
        }
        return s
      },
    },
    create: createMock,
    open: openMock,
    scope: (id: SessionId) => (id === sid('new-1') ? mint(id) : scopes.get(id)),
    scopeOf,
    hostDescription: () => opts?.description,
  } as unknown as SessionsService
  if (opts?.sessions !== false) ctx.provide('sessions', sessionsFake)
  // Class-plugin mount — the same form apply.ts uses in production.
  const fiber = ctx.plugin(ConversationService)
  await fiber.await()
  const svc = ctx.get('conversation') as ConversationService
  const scopedSvc = (id: SessionId) => mint(id).get('conversation') as ConversationService
  return { ctx, svc, scopedSvc, mint, sessionDoubles, sessionsFake, createMock, openMock }
}

describe('send / cancel', () => {
  it('sends one text block through the scoped session with the mode', async () => {
    const b = await bench()
    await b.scopedSvc(sid('s1')).send('hello', 'steer')
    expect(b.sessionDoubles.get(sid('s1'))!.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: 'hello' }], 'steer')
  })

  it('folds business failure into a thrown error carrying code and message', async () => {
    const b = await bench()
    const s = b.scopedSvc(sid('s1'))
    // Materialize the double first (manager.get is the lazy mint point).
    b.sessionsFake.manager.get(sid('s1'))
    const double = b.sessionDoubles.get(sid('s1'))!
    double.prompt.mockResolvedValue({ ok: false, error: { code: 'agent-busy', message: 'busy' } })
    await expect(s.send('x', 'queue')).rejects.toThrow(/send failed: agent-busy: busy/)
  })

  it('uploads temporary browser files as base64 image parts at the send boundary', async () => {
    const b = await bench()
    const file = new File([Uint8Array.of(1, 2, 3)], 'pixel.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(Uint8Array.of(1, 2, 3).buffer),
    })
    await b.scopedSvc(sid('s1')).send('describe', 'queue', [file])
    expect(b.sessionDoubles.get(sid('s1'))!.prompt).toHaveBeenCalledWith([
      { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'pixel.png' },
      { type: 'text', text: 'describe' },
    ], 'queue')
  })

  it('rejects unsupported browser media before prompting the session', async () => {
    const b = await bench()
    const file = new File([Uint8Array.of(1)], 'clip.mp4', { type: 'video/mp4' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(Uint8Array.of(1).buffer),
    })
    await expect(b.scopedSvc(sid('s1')).send('', 'queue', [file]))
      .rejects.toThrow(/不支持的图片格式/)
    expect(b.sessionDoubles.get(sid('s1'))?.prompt).not.toHaveBeenCalled()
  })

  it('cancel resolves on ok and throws the folded business error', async () => {
    const b = await bench()
    const s = b.scopedSvc(sid('s1'))
    await s.cancel()
    const double = b.sessionDoubles.get(sid('s1'))!
    expect(double.cancel).toHaveBeenCalledTimes(1)
    double.cancel.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'nope' } })
    await expect(s.cancel()).rejects.toThrow(/cancel failed: internal: nope/)
  })

  it('root-context send and cancel throw the addressing hint', async () => {
    const b = await bench()
    await expect(b.svc.send('x', 'queue')).rejects.toThrow(/requires a session scope/)
    await expect(b.svc.cancel()).rejects.toThrow(/requires a session scope/)
  })
})

describe('image admission and URL lifecycle', () => {
  const description: NonNullable<ReturnType<SessionsService['hostDescription']>> = {
    version: '0',
    cwd: '/f',
    attachedSessions: 0,
    activeModel: {
      provider: 'anthropic',
      id: 'claude-opus-4-8',
      name: 'Opus',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    imageLimits: {
      maxImageBytes: 3,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 4,
      maxImagePixels: 100,
      mediaTypes: ['image/png'],
    },
  }

  it('preflights host limits before allocating previews and releases draft URLs', async () => {
    const createObjectURL = vi.fn(() => 'blob:draft')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const b = await bench({ description })
    const first = new File([Uint8Array.of(1, 2, 3)], 'first.png', { type: 'image/png' })
    const second = new File([Uint8Array.of(4, 5)], 'second.png', { type: 'image/png' })

    const attachments = b.svc.createDraftImages([first])
    expect(attachments[0]).toMatchObject({
      kind: 'image',
      file: first,
      previewUrl: 'blob:draft',
    })
    expect(() => b.svc.createDraftImages([second], attachments)).toThrow(/总大小/)
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    b.svc.releaseDraftImages(attachments)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:draft')
  })

  it('rejects unsupported model capability, media type, count, and per-image bytes', async () => {
    const createObjectURL = vi.fn(() => 'blob:unexpected')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const textOnly = await bench({
      description: {
        ...description,
        activeModel: { ...description.activeModel!, inputModalities: ['text'] },
      },
    })
    const png = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    expect(() => textOnly.svc.createDraftImages([png], [], true))
      .toThrow(/当前模型不支持图片/)

    const b = await bench({ description })
    const video = new File([Uint8Array.of(1)], 'clip.mp4', { type: 'video/mp4' })
    expect(() => b.svc.createDraftImages([video])).toThrow(/不支持的图片格式/)
    const large = new File([Uint8Array.of(1, 2, 3, 4)], 'large.png', {
      type: 'image/png',
    })
    expect(() => b.svc.createDraftImages([large])).toThrow(/单张大小限制/)
    const existing = b.svc.createDraftImages([png, png])
    expect(() => b.svc.createDraftImages([png], existing)).toThrow(/最多添加 2 张/)
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('deduplicates historical loads and revokes their URLs when the session scope ends', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:history-1')
      .mockReturnValueOnce('blob:history-2')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const b = await bench()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    b.sessionsFake.manager.get(sid('s1'))
    const session = b.sessionDoubles.get(sid('s1'))!
    session.readAttachment.mockResolvedValue({
      ok: true,
      value: { attachment: ref, data: [1] },
    })

    await expect(Promise.all([
      b.svc.resolveImage(sid('s1'), ref),
      b.svc.resolveImage(sid('s1'), ref),
    ])).resolves.toEqual(['blob:history-1', 'blob:history-1'])
    expect(session.readAttachment).toHaveBeenCalledTimes(1)

    b.svc.releaseSessionImages(sid('s1'))
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:history-1')
    })
    await expect(b.svc.resolveImage(sid('s1'), ref)).resolves.toBe('blob:history-2')
    expect(session.readAttachment).toHaveBeenCalledTimes(2)
  })

  it('revokes a historical URL whose load completes after its session scope was released', async () => {
    const createObjectURL = vi.fn(() => 'blob:late')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const b = await bench()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const response = Promise.withResolvers<{
      ok: true
      value: { attachment: ImageAttachmentRef; data: number[] }
    }>()
    b.sessionsFake.manager.get(sid('s1'))
    b.sessionDoubles.get(sid('s1'))!.readAttachment.mockReturnValue(response.promise)

    const pending = b.svc.resolveImage(sid('s1'), ref)
    b.svc.releaseSessionImages(sid('s1'))
    response.resolve({ ok: true, value: { attachment: ref, data: [1] } })

    await expect(pending).rejects.toThrow(/scope was released/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:late')
  })
})

describe('startSession chain', () => {
  it('creates, sends through the new scope, then navigates through sessions.open', async () => {
    const b = await bench()
    await b.svc.startSession({ cwd: '/proj', text: 'first', mode: 'queue' })
    expect(b.createMock).toHaveBeenCalledWith({ cwd: '/proj' })
    expect(b.openMock).toHaveBeenCalledWith(sid('new-1'))
    const prompt = b.sessionDoubles.get(sid('new-1'))!.prompt
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'first' }], 'queue')
    // Navigation is the publication point: it must not precede send acceptance.
    expect(b.openMock.mock.invocationCallOrder[0]!).toBeGreaterThan(prompt.mock.invocationCallOrder[0]!)
  })

  it('does not navigate when the first send is rejected (empty state keeps the draft)', async () => {
    const b = await bench()
    const doomed = b.sessionsFake.manager.get(sid('new-1')) as unknown as SessionDouble
    doomed.prompt.mockResolvedValue({ ok: false, error: { code: 'agent-busy', message: 'nope' } })
    await expect(b.svc.startSession({ text: 'first', mode: 'queue' })).rejects.toThrow(/agent-busy/)
    expect(b.openMock).not.toHaveBeenCalled()
  })

  it('omits cwd from create when not chosen', async () => {
    const b = await bench()
    await b.svc.startSession({ text: 't', mode: 'steer' })
    expect(b.createMock).toHaveBeenCalledWith({})
  })

  it('fails loud when the created session resolves no scope', async () => {
    const b = await bench()
    ;(b.sessionsFake.create as ReturnType<typeof vi.fn>).mockResolvedValue(sid('ghost'))
    await expect(b.svc.startSession({ text: 't', mode: 'queue' })).rejects.toThrow(/resolved no scope/)
  })
})

describe('service-unavailable loud failures', () => {
  it('throws when sessions is missing', async () => {
    const b = await bench({ sessions: false })
    await expect(b.svc.startSession({ text: 't', mode: 'queue' })).rejects.toThrow(/sessions service unavailable/)
  })

  it('startSession fails loud when the new scope cannot resolve conversation', async () => {
    const b = await bench()
    // A scope minted outside the service tree: scoped.get('conversation') finds nothing.
    const foreign = new Context()
    const foreignScope = foreign.plugin(() => {}).ctx.extend({})
    ;(b.sessionsFake.scope as unknown) = () => foreignScope
    await expect(b.svc.startSession({ text: 't', mode: 'queue' }))
      .rejects.toThrow(/conversation service unavailable through the new scope/)
  })
})
