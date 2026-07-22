// @vitest-environment jsdom
/**
 * ConversationService store half: scope-addressed selection/drafts accounts
 * (lazy mint, per-scope isolation, root access throws, scope teardown
 * collects), view registry (order, duplicate throw, effect-scoped disposal,
 * uSES read face). Send/cancel/startSession orchestration live in
 * service-orchestration.spec.ts.
 */
import { Context } from 'cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConvViewProps, ViewEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string): SessionId => s as SessionId

/**
 * The scope tag symbol is module-private to the runtime package; recover it
 * through the public seam by recording which symbol scopeOf reads off a
 * spying proxy (keeps this bench honest against the real tagging shape
 * without dragging the full SessionsService + wire fake in here).
 */
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

/** Scope bench: real cordis scope fibers tagged like SessionsService.resolve mints them. */
interface Bench {
  ctx: Context
  svc: ConversationService
  mint: (id: SessionId) => Context
  dispose: (id: SessionId) => Promise<void>
}

function bench(): Bench {
  const ctx = new Context()
  const fibers = new Map<SessionId, { fiber: ReturnType<Context['plugin']>; ctx: Context }>()
  const mint = (id: SessionId): Context => {
    let rec = fibers.get(id)
    if (rec === undefined) {
      const fiber = ctx.plugin(() => {})
      const scoped = fiber.ctx.extend({ [SCOPE_TAG]: id })
      rec = { fiber, ctx: scoped }
      fibers.set(id, rec)
    }
    return rec.ctx
  }
  const dispose = async (id: SessionId): Promise<void> => {
    const rec = fibers.get(id)
    if (rec !== undefined) {
      await rec.fiber.dispose()
      fibers.delete(id)
    }
  }
  const sessions = { scope: (id: SessionId) => fibers.get(id)?.ctx } as unknown as SessionsService
  ctx.provide('sessions', sessions)
  const svc = new ConversationService(ctx)
  return { ctx, svc, mint, dispose }
}

/** Scoped service view: ctx.get binds the root singleton to the scoped ctx (scope addressing seam). */
function convo(scoped: Context): ConversationService {
  const service = scoped.get('conversation')
  if (service === undefined) throw new Error('bench: conversation unavailable')
  return service
}

const viewComp = (() => null) as unknown as FC<ConvViewProps>
const entry = (id: string, order?: number): ViewEntry =>
  ({ id, label: id, component: viewComp, ...(order !== undefined ? { order } : {}) }) as unknown as ViewEntry

beforeEach(() => { localStorage.clear() })

describe('scope addressing of stores', () => {
  it('root-context selection/drafts access throws with the addressing hint', () => {
    const b = bench()
    expect(() => b.svc.selection).toThrow(/requires a session scope/)
    expect(() => b.svc.drafts).toThrow(/requires a session scope/)
  })

  it('mints one store per scope and keeps identity per session', () => {
    const b = bench()
    const c1 = b.mint(sid('s1'))
    const c2 = b.mint(sid('s2'))
    const sel1 = convo(c1).selection
    const sel2 = convo(c2).selection
    expect(sel1).not.toBe(sel2)
    expect(convo(c1).selection).toBe(sel1)
    sel1.set({ turnSeq: 3 })
    expect(sel1.getSnapshot()).toEqual({ turnSeq: 3 })
    expect(sel2.getSnapshot()).toBeNull()
  })

  it('persists drafts keyed by session id and evolves independently', async () => {
    const b = bench()
    const c1 = b.mint(sid('s1'))
    convo(c1).drafts.set('hello')
    expect(localStorage.getItem('dsh.conversation.draft.s1')).toBe('hello')
    const c2 = b.mint(sid('s2'))
    expect(convo(c2).drafts.getSnapshot()).toBe('')
    // Re-minting after teardown rehydrates from storage; clearing removes the key.
    await b.dispose(sid('s1'))
    expect(convo(b.mint(sid('s1'))).drafts.getSnapshot()).toBe('hello')
    convo(b.mint(sid('s1'))).drafts.set('')
    expect(localStorage.getItem('dsh.conversation.draft.s1')).toBeNull()
  })

  it('scope fiber disposal collects the store account (fresh store on re-mint)', async () => {
    const b = bench()
    const c1 = b.mint(sid('s1'))
    const sel = convo(c1).selection
    sel.set({ turnSeq: 1 })
    await b.dispose(sid('s1'))
    const again = b.mint(sid('s1'))
    const sel2 = convo(again).selection
    expect(sel2).not.toBe(sel)
    expect(sel2.getSnapshot()).toBeNull()
  })
})

describe('view registry', () => {
  it('orders by order (ties keep registration sequence) with a stable cache reference', () => {
    const b = bench()
    b.svc.registerView(entry('chat', 0))
    b.svc.registerView(entry('waterfall', 2))
    b.svc.registerView(entry('trajectory', 1))
    const views = b.svc.views()
    expect(views.map(v => v.id)).toEqual(['chat', 'trajectory', 'waterfall'])
    expect(b.svc.views()).toBe(views)
  })

  it('duplicate id throws; disposer removes and bumps the version', () => {
    const b = bench()
    const fn = vi.fn()
    b.svc.subscribeViews(fn)
    const off = b.svc.registerView(entry('chat'))
    expect(() => b.svc.registerView(entry('chat'))).toThrow(/already registered/)
    const v1 = b.svc.viewsVersion()
    off()
    expect(b.svc.viewsVersion()).toBeGreaterThan(v1)
    expect(b.svc.views()).toEqual([])
    expect(fn).toHaveBeenCalled()
  })

  it('unsubscribe stops notifications', () => {
    const b = bench()
    const fn = vi.fn()
    const unsub = b.svc.subscribeViews(fn)
    unsub()
    b.svc.registerView(entry('chat'))
    expect(fn).not.toHaveBeenCalled()
  })

  it('a registering plugin fiber unloading collects its views (effect cascade)', async () => {
    const b = bench()
    const fiber = b.ctx.plugin((pluginCtx: Context) => {
      convo(pluginCtx).registerView(entry('chat'))
    })
    await fiber.await()
    expect(b.svc.views().map(v => v.id)).toEqual(['chat'])
    await fiber.dispose()
    expect(b.svc.views()).toEqual([])
  })
})
