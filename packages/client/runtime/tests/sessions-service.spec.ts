/**
 * SessionsService: list store projection (manager → {ids, byId, current}
 * with derived titles), the migrated current-selection account (open
 * validation, persisted mask semantics, cell resolution), scope-tree
 * lifecycle (lazy mint / frozen survival / removed teardown with staged
 * deferral — the stage follows list.current), binding identity, ancestry
 * walk, create.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionsService, scopeOf } from '../src/client/sessions/service.ts'
import { FakeApiClient, ok } from './fake-api.ts'

const sid = (s: string): SessionId => s as SessionId

interface Bench {
  ctx: Context
  api: FakeApiClient
  svc: SessionsService
}

function bench(): Bench {
  const ctx = new Context()
  const api = new FakeApiClient()
  const svc = new SessionsService(ctx, api)
  return { ctx, api, svc }
}

/** Refresh the manager list from programmable rows and flush the microtask batch. */
async function feedList(b: Bench, rows: { id: string; cwd?: string; parentId?: string; running?: boolean }[]): Promise<void> {
  b.api.onList = () => Promise.resolve(ok({
    items: rows.map(r => ({
      sessionId: sid(r.id), updatedAt: 1, running: r.running ?? false,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.parentId !== undefined ? { parentSessionId: sid(r.parentId) } : {}),
    })),
  }) as never)
  await b.svc.manager.refreshList()
  await Promise.resolve() // manager notifier flush
}

describe('list store projection', () => {
  it('projects durable titles separately from cwd/id display fallbacks and parent links', async () => {
    const b = bench()
    b.svc.manager.handleMuxEnvelope({
      rpcId: 'title' as never,
      payload: { type: 'session/title', sessionId: sid('s1'), title: 'Durable title', eventSeq: 2, updatedAt: 3 },
    })
    await feedList(b, [
      { id: 's1', cwd: '/home/u/proj-a/' },
      { id: 's2', parentId: 's1', running: true },
    ])
    const state = b.svc.list.getSnapshot()
    expect(state.ids).toEqual(['s1', 's2'])
    expect(state.byId[sid('s1')]).toMatchObject({ title: 'Durable title', displayTitle: 'Durable title', cwd: '/home/u/proj-a/' })
    expect(state.byId[sid('s2')]).toMatchObject({ displayTitle: 's2', parentId: 's1', running: true })
    expect(state.byId[sid('s2')]?.title).toBeUndefined()
  })

  it('reflects live increments (host stream via manager) into the store', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.manager.handleHostEnvelope({ rpcId: 'r1' as never, payload: { type: 'host/session-added', sessionId: sid('s2') } as never })
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().ids).toContain('s2')
  })
})

describe('scope tree', () => {
  it('mints lazily on first resolution, tags the ctx, and keeps binding identity stable', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    expect(b.svc.scope(sid('unknown'))).toBeUndefined()
    const scoped = b.svc.scope(sid('s1'))
    expect(scoped).toBeDefined()
    expect(scopeOf(scoped as Context)).toBe('s1')
    expect(scopeOf(b.ctx)).toBeUndefined()
    const binding = b.svc.binding(sid('s1'))
    expect(binding?.session).toBe(b.svc.manager.get(sid('s1')))
    expect(b.svc.binding(sid('s1'))).toBe(binding)
    expect(binding?.ctx).toBe(scoped)
  })

  it('tears down an off-stage removed session but defers the staged one until the stage moves', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    const ctx1 = b.svc.scope(sid('s1'))
    b.svc.open(sid('s1')) // s1 staged (current)
    b.svc.scope(sid('s2')) // s2 scoped but off stage

    await feedList(b, [{ id: 's1' }]) // s2 removed, off stage: torn down
    expect(b.svc.scope(sid('s2'))).toBeUndefined()

    await feedList(b, []) // s1 removed while staged (current masks): deferred, scope survives
    expect(b.svc.scope(sid('s1'))).toBe(ctx1)

    await feedList(b, [{ id: 's3' }])
    b.svc.open(sid('s3')) // stage moves: deferred teardown sweeps s1
    expect(b.svc.scope(sid('s1'))).toBeUndefined()
  })

  it('keeps the scope when the session merely stops running (frozen ≠ removed)', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', running: true }])
    const scoped = b.svc.scope(sid('s1'))
    await feedList(b, [{ id: 's1', running: false }])
    expect(b.svc.scope(sid('s1'))).toBe(scoped)
  })

  it('cancels a deferred teardown when the id reappears in the list', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    const scoped = b.svc.scope(sid('s1'))
    b.svc.open(sid('s1'))
    await feedList(b, []) // removed while staged → deferred
    await feedList(b, [{ id: 's1' }, { id: 's2' }]) // reappears (current resurfaces, stage unchanged)
    b.svc.open(sid('s2')) // stage moves; sweep must NOT tear down the re-listed s1
    expect(b.svc.scope(sid('s1'))).toBe(scoped)
  })
})

describe('current selection (migrated from ui-layout, arbitrated into the list snapshot)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('open() writes list.current; unknown ids fail loud', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    b.svc.open(sid('s1'))
    expect(b.svc.list.getSnapshot().current).toBe('s1')
    expect(() => { b.svc.open(sid('ghost')) }).toThrow(/unknown session ghost/)
    expect(b.svc.list.getSnapshot().current).toBe('s1') // failed open leaves the selection alone
  })

  it('clear() blanks list.current and the persisted selection', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
      removeItem: (k: string) => { storage.delete(k) },
      clear: () => { storage.clear() },
    })
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    expect(storage.get('dsh.sessions.current')).toContain('s1')
    b.svc.clear()
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    // Persisted wipe: a fresh service with the same storage stays on empty.
    const again = bench()
    await feedList(again, [{ id: 's1' }])
    expect(again.svc.list.getSnapshot().current).toBeUndefined()
  })

  it('masks (not destroys) the selection while its session is off the list', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    b.svc.open(sid('s1'))
    await feedList(b, [{ id: 's2' }]) // s1 removed → current falls to the empty state
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    await feedList(b, [{ id: 's1' }, { id: 's2' }]) // s1 returns → selection resurfaces
    expect(b.svc.list.getSnapshot().current).toBe('s1')
  })

  it('persists the selection under dsh.sessions.current and rehydrates it into a fresh service', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
    })
    const first = bench()
    await feedList(first, [{ id: 's1' }])
    first.svc.open(sid('s1'))
    expect(storage.get('dsh.sessions.current')).toContain('s1')
    // A fresh boot (same storage) recovers the selection once the list holds the session.
    const second = bench()
    await feedList(second, [{ id: 's1' }])
    expect(second.svc.list.getSnapshot().current).toBe('s1')
  })
})

describe('cell (render-layer session kit)', () => {
  it('resolves an identity-stable {sessionId, session} cell; unknown ids yield undefined', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    const cell = b.svc.cell('s1')
    expect(cell).toBeDefined()
    expect(cell?.sessionId).toBe('s1')
    // Bare-source form (store migration): the cell carries the Session
    // observable itself; hook binding happens in the React machinery.
    expect(cell?.session).toBe(b.svc.manager.get(sid('s1')))
    expect(b.svc.cell('s1')).toBe(cell)
    expect(b.svc.cell('ghost')).toBeUndefined()
  })

  it('cell()/binding() are pure resolution: no staging, no deferred sweep', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    b.svc.open(sid('s1')) // staged
    b.svc.cell('s2') // resolution only — must NOT move the stage
    b.svc.binding(sid('s2'))
    await feedList(b, [{ id: 's2' }]) // s1 removed: still staged → deferred, scope survives
    expect(b.svc.scope(sid('s1'))).toBeDefined()
  })

  it('staging (current write) opens the session event window; resolution and re-staging do not re-pull', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    const historyCalls = () => b.api.calls.filter(c => c.method === 'session.history')
    // Resolution is addressing, not staging: no window pull.
    b.svc.scope(sid('s1'))
    b.svc.cell('s1')
    b.svc.binding(sid('s1'))
    expect(historyCalls()).toHaveLength(0)
    b.svc.open(sid('s1'))
    expect(historyCalls().map(c => (c.payload as { sessionId: string }).sessionId)).toEqual(['s1'])
    // Same current again: no second pull.
    b.svc.open(sid('s1'))
    expect(historyCalls()).toHaveLength(1)
    // Stage moves: the new occupant opens.
    b.svc.open(sid('s2'))
    expect(historyCalls().map(c => (c.payload as { sessionId: string }).sessionId)).toEqual(['s1', 's2'])
  })

  it('startup restore: a persisted selection validated by the first projection opens its window unprompted', async () => {
    const storage = new Map<string, string>([
      ['dsh.sessions.current', JSON.stringify({ sessionId: 's1' })],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
    })
    try {
      const b = bench()
      expect(b.api.calls.filter(c => c.method === 'session.history')).toHaveLength(0)
      await feedList(b, [{ id: 's1' }]) // projection validates the persisted id → current lands → stage follows
      const historyCalls = b.api.calls.filter(c => c.method === 'session.history')
      expect(historyCalls.map(c => (c.payload as { sessionId: string }).sessionId)).toEqual(['s1'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('slot-store scope prune hook', () => {
  it('notifies ctx.slots.pruneStoreScope when a scope dies (both teardown paths)', async () => {
    const b = bench()
    const pruneStoreScope = vi.fn()
    b.ctx.reflect.provide('slots', { pruneStoreScope })
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    b.svc.scope(sid('s1'))
    b.svc.scope(sid('s2'))
    b.svc.open(sid('s2')) // s2 staged
    await feedList(b, []) // s1 off stage → immediate drop; s2 staged → deferred
    expect(pruneStoreScope).toHaveBeenCalledWith('s1')
    expect(pruneStoreScope).not.toHaveBeenCalledWith('s2')
    await feedList(b, [{ id: 's3' }])
    b.svc.open(sid('s3')) // stage moves → deferred sweep drops s2
    expect(pruneStoreScope).toHaveBeenCalledWith('s2')
  })

  it('tolerates a slots-less boot (object-layer benches carry no slot service)', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.scope(sid('s1'))
    await feedList(b, []) // teardown without ctx.slots must not throw
    expect(b.svc.scope(sid('s1'))).toBeUndefined()
  })
})

describe('ancestry', () => {
  it('walks parentId links root-first including self; broken links stop the walk', async () => {
    const b = bench()
    await feedList(b, [
      { id: 'root', cwd: '/w/app' },
      { id: 'mid', parentId: 'root' },
      { id: 'leaf', parentId: 'mid' },
      { id: 'orphan', parentId: 'ghost' },
    ])
    expect(b.svc.ancestry(sid('leaf')).map(s => s.id)).toEqual(['root', 'mid', 'leaf'])
    expect(b.svc.ancestry(sid('orphan')).map(s => s.id)).toEqual(['orphan'])
    expect(b.svc.ancestry(sid('ghost'))).toEqual([])
  })
})

describe('create', () => {
  it('returns the new id on ok and throws a coded error on failure', async () => {
    const b = bench()
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('fresh') }))
    await expect(b.svc.create({ cwd: '/w' })).resolves.toBe('fresh')
    b.api.onCreate = () => Promise.resolve({
      rpcId: 'e' as never,
      result: { ok: false as const, error: { code: 'internal' as const, message: '爆了', details: {} } },
    } as never)
    await expect(b.svc.create()).rejects.toThrow(/internal: 爆了/)
  })
})

describe('createWorkspace', () => {
  it('joins host.describe cwd with the name and creates there', async () => {
    const b = bench()
    b.api.onDescribe = () => Promise.resolve(ok({ version: '0', cwd: '/host/root', attachedSessions: 0 }))
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('ws') }))
    await expect(b.svc.createWorkspace('My Proj')).resolves.toBe('ws')
    expect(b.api.callsOf('session.create')).toEqual([{ cwd: '/host/root/My Proj' }])
  })

  it('rejects empty names and path separators; surfaces describe failures', async () => {
    const b = bench()
    await expect(b.svc.createWorkspace('  ')).rejects.toThrow(/name is required/)
    await expect(b.svc.createWorkspace('a/b')).rejects.toThrow(/path separators/)
    b.api.onDescribe = () => Promise.resolve({
      rpcId: 'e' as never,
      result: { ok: false as const, error: { code: 'internal' as const, message: 'down', details: {} } },
    } as never)
    await expect(b.svc.createWorkspace('ok')).rejects.toThrow(/host.describe failed/)
  })
})

describe('coverage tails (branch duals)', () => {
  it('displayTitleOf falls back to the id for empty and separator-only cwd', async () => {
    const b = bench()
    await feedList(b, [{ id: 'no-base', cwd: '///' }, { id: 'empty-cwd', cwd: '' }])
    const { byId } = b.svc.list.getSnapshot()
    expect(byId[sid('no-base')]?.displayTitle).toBe('no-base')
    expect(byId[sid('empty-cwd')]?.displayTitle).toBe('empty-cwd')
    expect(byId[sid('no-base')]?.title).toBeUndefined()
  })

  it('binding for an unknown session returns undefined and leaves the staged scope intact', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    expect(b.svc.binding(sid('ghost'))).toBeUndefined()
    // Stage unchanged: removing s1 defers (still staged), proving the ghost lookup touched nothing.
    await feedList(b, [])
    expect(b.svc.scope(sid('s1'))).toBeDefined()
  })

  it('a masked current gap holds the stage (no teardown, no re-open) until the stage moves', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const historyCalls = () => b.api.calls.filter(c => c.method === 'session.history')
    expect(historyCalls()).toHaveLength(1)
    await feedList(b, []) // removed while staged: current masks to undefined, stage holds → deferred
    expect(b.svc.scope(sid('s1'))).toBeDefined()
    // Resurfacing re-projects current = s1: same stage occupant, no second pull.
    await feedList(b, [{ id: 's1' }])
    expect(historyCalls()).toHaveLength(1)
    expect(b.svc.list.getSnapshot().current).toBe('s1')
  })

  it('sweep hits both deferral edges: staged-id skip and an already-vacated scope record', async () => {
    const b = bench()
    await feedList(b, [{ id: 'a' }, { id: 'b' }])
    b.svc.scope(sid('a'))
    b.svc.open(sid('b')) // stage: b; both scoped
    await feedList(b, []) // a removed off stage → torn immediately; b removed staged → deferred
    // Move the stage to a THIRD id while b stays deferred: sweep walks a set
    // containing b (torn).
    await feedList(b, [{ id: 'c' }])
    b.svc.open(sid('c'))
    expect(b.svc.scope(sid('b'))).toBeUndefined()
    // Deferral for an id whose record was never minted: force the deferral
    // via removed list state — sweep must tolerate the missing record.
    await feedList(b, []) // c removed while staged → deferred (scope exists)
    await feedList(b, [{ id: 'd' }])
    b.svc.open(sid('d')) // sweep tears c
    expect(b.svc.scope(sid('c'))).toBeUndefined()
  })

})
