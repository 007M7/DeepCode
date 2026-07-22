// @vitest-environment jsdom
/**
 * LayoutService over the real snapshot-store engine (persist rides jsdom
 * localStorage). ctx is faked down to the one surface the service reads:
 * ctx.sessions.list as a real store, so prune subscriptions are exercised
 * for real.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { LayoutService, DETAILS_DEFAULT, SIDEBAR_DEFAULT } from '@deepseek-ai/dsh-client-ui-layout/client'

function makeCtx() {
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {} })
  // The service resolves sessions via ctx.get (typed merge suspended, see service).
  const ctx = { get: (name: string) => (name === 'sessions' ? { list } : undefined) } as unknown as Context
  return { ctx, list }
}

/** Test-side brand: specs mint ids the wire would normally brand. */
const sid = (s: string): SessionId => s as SessionId
const summary = (id: SessionId) => ({ id, title: id as string, running: false, updatedAt: 1 })

beforeEach(() => { localStorage.clear() })

describe('LayoutService', () => {
  it('defaults: sidebar open 300, details closed 360, empty nav', () => {
    const svc = new LayoutService(makeCtx().ctx)
    expect(svc.sidebar.getSnapshot()).toEqual({ open: true, width: SIDEBAR_DEFAULT })
    expect(svc.details.getSnapshot()).toEqual({ open: false, width: DETAILS_DEFAULT })
    expect(svc.current.getSnapshot()).toEqual({ viewFor: {} })
    svc.dispose()
  })

  it('open validates against sessions.list and selects', () => {
    const { ctx, list } = makeCtx()
    const svc = new LayoutService(ctx)
    expect(() => { svc.open(sid('nope')) }).toThrow(/unknown session/)
    list.update((d) => { d.ids.push(sid('s1')); d.byId[sid('s1')] = summary(sid('s1')) })
    svc.open(sid('s1'))
    expect(svc.current.getSnapshot().sessionId).toBe('s1')
    svc.dispose()
  })

  it('width setters clamp into contract ranges', () => {
    const svc = new LayoutService(makeCtx().ctx)
    svc.setSidebarWidth(10)
    expect(svc.sidebar.getSnapshot().width).toBe(240)
    svc.setSidebarWidth(10_000)
    expect(svc.sidebar.getSnapshot().width).toBe(420)
    svc.setDetailsWidth(10)
    expect(svc.details.getSnapshot().width).toBe(300)
    svc.setDetailsWidth(10_000)
    expect(svc.details.getSnapshot().width).toBe(520)
    svc.dispose()
  })

  it('toggle and open/close flip flags without touching widths', () => {
    const svc = new LayoutService(makeCtx().ctx)
    svc.toggleSidebar()
    expect(svc.sidebar.getSnapshot()).toEqual({ open: false, width: SIDEBAR_DEFAULT })
    svc.openDetails()
    expect(svc.details.getSnapshot().open).toBe(true)
    svc.closeDetails()
    expect(svc.details.getSnapshot().open).toBe(false)
    svc.dispose()
  })

  it('prune clears viewFor entries and the current selection of removed sessions', () => {
    const { ctx, list } = makeCtx()
    const svc = new LayoutService(ctx)
    list.update((d) => {
      d.ids.push(sid('s1'), sid('s2'))
      d.byId[sid('s1')] = summary(sid('s1'))
      d.byId[sid('s2')] = summary(sid('s2'))
    })
    svc.open(sid('s1'))
    svc.openView(sid('s1'), 'chat')
    svc.openView(sid('s2'), 'chat')
    list.update((d) => { d.ids = [sid('s2')]; d.byId = { [sid('s2')]: d.byId[sid('s2')]! } })
    expect(svc.current.getSnapshot().sessionId).toBeUndefined()
    expect(svc.current.getSnapshot().viewFor).toEqual({ s2: 'chat' })
    svc.dispose()
  })

  it('prune leaves untouched state alone (no gratuitous store writes)', () => {
    const { ctx, list } = makeCtx()
    const svc = new LayoutService(ctx)
    list.update((d) => { d.ids.push(sid('s1')); d.byId[sid('s1')] = summary(sid('s1')) })
    svc.open(sid('s1'))
    const before = svc.current.getSnapshot()
    list.update((d) => { d.byId[sid('s1')] = { ...d.byId[sid('s1')]!, title: 'renamed' } })
    expect(svc.current.getSnapshot()).toBe(before)
    svc.dispose()
  })

  it('persists panel state and nav across instances (fresh service, same storage)', () => {
    const first = new LayoutService(makeCtx().ctx)
    first.setSidebarWidth(320)
    first.openDetails()
    first.dispose()
    const second = new LayoutService(makeCtx().ctx)
    expect(second.sidebar.getSnapshot().width).toBe(320)
    expect(second.details.getSnapshot().open).toBe(true)
    second.dispose()
  })

  it('dispose stops pruning', () => {
    const { ctx, list } = makeCtx()
    const svc = new LayoutService(ctx)
    list.update((d) => { d.ids.push(sid('s1')); d.byId[sid('s1')] = summary(sid('s1')) })
    svc.open(sid('s1'))
    svc.dispose()
    list.update((d) => { d.ids = []; d.byId = {} })
    expect(svc.current.getSnapshot().sessionId).toBe('s1')
  })
})

describe('LayoutService — construction and prune edge branches', () => {
  it('throws loud when the sessions service is absent', () => {
    const bare = { get: () => undefined } as unknown as Context
    expect(() => new LayoutService(bare)).toThrow(/sessions service unavailable/)
  })

  it('prunes stale viewFor while the current selection stays valid', () => {
    // Covers the prune branch where staleView holds but staleCurrent does not.
    const { ctx, list } = makeCtx()
    const svc = new LayoutService(ctx)
    list.update((d) => { d.ids.push(sid('s1'), sid('s2')); d.byId[sid('s1')] = summary(sid('s1')); d.byId[sid('s2')] = summary(sid('s2')) })
    svc.open(sid('s1'))
    svc.openView(sid('s2'), 'chat')
    list.update((d) => { d.ids = [sid('s1')]; d.byId = { [sid('s1')]: d.byId[sid('s1')]! } })
    expect(svc.current.getSnapshot().sessionId).toBe('s1')
    expect(svc.current.getSnapshot().viewFor).toEqual({})
    svc.dispose()
  })
})
