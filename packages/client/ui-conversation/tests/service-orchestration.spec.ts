// @vitest-environment jsdom
/**
 * ConversationService orchestration half: scope-addressed send/cancel (result
 * folding, root throw), openDetails choreography, the startSession chain, and
 * the service-unavailable loud failures. Store semantics live in
 * service-stores.spec.ts.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string): SessionId => s as SessionId

/** Recover the module-private scope tag through the public seam (same probe as service-stores.spec). */
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
}

async function bench(opts?: { layout?: boolean; sessions?: boolean }) {
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
  const sessionsFake = {
    manager: {
      get: (id: SessionId) => {
        let s = sessionDoubles.get(id)
        if (s === undefined) {
          s = {
            prompt: vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } })),
            cancel: vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } })),
          }
          sessionDoubles.set(id, s)
        }
        return s
      },
    },
    create: createMock,
    scope: (id: SessionId) => (id === sid('new-1') ? mint(id) : scopes.get(id)),
  } as unknown as SessionsService
  if (opts?.sessions !== false) ctx.provide('sessions', sessionsFake)
  const layoutFake = { open: vi.fn(), openDetails: vi.fn() }
  if (opts?.layout !== false) ctx.provide('layout', layoutFake)
  const fiber = ctx.plugin((pluginCtx) => { void new ConversationService(pluginCtx) })
  await fiber.await()
  const svc = ctx.get('conversation') as ConversationService
  const scopedSvc = (id: SessionId) => mint(id).get('conversation') as ConversationService
  return { ctx, svc, scopedSvc, mint, sessionDoubles, sessionsFake, createMock, layoutFake }
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

describe('openDetails', () => {
  it('writes the scoped selection then opens the layout panel', async () => {
    const b = await bench()
    const s = b.scopedSvc(sid('s1'))
    s.openDetails({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(s.selection.getSnapshot()).toEqual({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
  })
})

describe('startSession chain', () => {
  it('creates, navigates, then sends through the new scope', async () => {
    const b = await bench()
    await b.svc.startSession({ cwd: '/proj', text: 'first', mode: 'queue' })
    expect(b.createMock).toHaveBeenCalledWith({ cwd: '/proj' })
    expect(b.layoutFake.open).toHaveBeenCalledWith(sid('new-1'))
    expect(b.sessionDoubles.get(sid('new-1'))!.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: 'first' }], 'queue')
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

  it('throws when layout is missing', async () => {
    const b = await bench({ layout: false })
    const s = b.scopedSvc(sid('s1'))
    expect(() => { s.openDetails({ turnSeq: 1 }) }).toThrow(/layout service unavailable/)
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

describe('views ordering and draft persistence branches', () => {
  it('orders by explicit order with undefined treated as zero (both comparator arms)', async () => {
    const b = await bench()
    const entry = (id: string, order?: number) => ({
      id, label: id, component: () => null,
      ...(order !== undefined ? { order } : {}),
    })
    b.svc.registerView(entry('z-late', 5) as never)
    b.svc.registerView(entry('default-zero') as never)
    b.svc.registerView(entry('first', -1) as never)
    expect(b.svc.views().map(v => v.id)).toEqual(['first', 'default-zero', 'z-late'])
  })

  it('draft store round-trips through localStorage and removes the key when emptied', async () => {
    const b = await bench()
    localStorage.setItem('dsh.conversation.draft.s9', 'restored')
    const s = b.scopedSvc(sid('s9'))
    expect(s.drafts.getSnapshot()).toBe('restored')
    s.drafts.set('typed')
    expect(localStorage.getItem('dsh.conversation.draft.s9')).toBe('typed')
    s.drafts.set('')
    expect(localStorage.getItem('dsh.conversation.draft.s9')).toBeNull()
  })
})
