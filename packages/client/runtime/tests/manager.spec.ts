/**
 * SessionManager orchestration: lazy resident instances, list lifecycle, host
 * frame routing, and the pending-frame buffer for uninstantiated sessions.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, deferred, err, ok } from './fake-api.ts'
import { entries, plainTurn } from './event-script.ts'

const S1 = 'fk-m1' as SessionId
const S2 = 'fk-m2' as SessionId

function summary(sessionId: SessionId, over: Partial<{ updatedAt: number; running: boolean; parentSessionId: SessionId }> = {}) {
  return { sessionId, updatedAt: 100, running: false, ...over }
}

describe('instances', () => {
  it('lazily builds one resident instance per id and syncs the running bit from the list', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1, { running: true })] as never[] }))
    const manager = new SessionManager(api)
    await manager.refreshList()
    const session = manager.get(S1)
    expect(manager.get(S1)).toBe(session) // resident: same instance forever
    expect(session.getSnapshot().running).toBe(true) // list preceded instantiation
  })

  it('replays buffered approval frames on instantiation and drops ordinary frames for uninstantiated sessions', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    // Uninstantiated: approval buffers, plain session/event drops.
    manager.handleMuxEnvelope({ rpcId: 'ra' as never, payload: { type: 'approval/requested', sessionId: S1, approvalId: 'ap1' as never, toolName: 'rm' } })
    manager.handleMuxEnvelope({ rpcId: 're' as never, payload: { type: 'session/event', sessionId: S1, event: plainTurn(0, 0, 'x', 'y')[0] as never } })
    const session = manager.get(S1)
    expect(session.getSnapshot().pending).toMatchObject([{ kind: 'approval', payload: { approvalId: 'ap1' } }])
    // Buffer cleared: a second instantiation of another id gets nothing.
    expect(manager.get(S2).getSnapshot().pending).toEqual([])
  })

  it('caps the pending buffer at 32 keeping the newest, and drops it on session-removed', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    // 40 distinct question frames for an uninstantiated session: only the newest 32 survive.
    for (let i = 0; i < 40; i++) {
      manager.handleMuxEnvelope({ rpcId: `q${i}` as never, payload: { type: 'question/requested', sessionId: S1, questions: [] } })
    }
    const pending = manager.get(S1).getSnapshot().pending
    expect(pending).toHaveLength(32)
    expect(pending.map(p => p.key)).toEqual(Array.from({ length: 32 }, (_, i) => `q:q${i + 8}`)) // oldest 8 dropped
    // Removed session: buffered frames must not replay on a future instantiation.
    manager.handleMuxEnvelope({ rpcId: 'qz' as never, payload: { type: 'question/requested', sessionId: S2, questions: [] } })
    manager.handleHostEnvelope({ rpcId: 'hz' as never, payload: { type: 'host/session-removed', sessionId: S2 } })
    expect(manager.get(S2).getSnapshot().pending).toEqual([])
  })
})

describe('list lifecycle', () => {
  it('single-flights refreshList and lands items sorted through lineage flattening', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => gate.promise
    const manager = new SessionManager(api)
    const first = manager.refreshList()
    const second = manager.refreshList()
    expect(manager.getListSnapshot().state).toBe('loading')
    gate.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    await Promise.all([first, second])
    expect(api.callsOf('session.list')).toHaveLength(1)
    const snapshot = manager.getListSnapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.items.map(i => i.sessionId)).toEqual([S2, S1]) // updatedAt desc
  })

  it('keeps the error in the list snapshot on failure', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(err({ code: 'internal', message: 'boom', details: {} }))
    const manager = new SessionManager(api)
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', error: { code: 'internal' } })
  })

  it('merges create into the list immediately without waiting for a refresh', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(ok({ sessionId: S2 }))
    const manager = new SessionManager(api)
    const result = await manager.create()
    expect(result).toMatchObject({ ok: true, value: { sessionId: S2 } })
    expect(manager.getListSnapshot().items.map(i => i.sessionId)).toEqual([S2])
  })

  it('retains monotonic title snapshots before list arrival, merges recency, and clears them on removal', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    manager.handleMuxEnvelope({
      rpcId: 'title-new' as never,
      payload: { type: 'session/title', sessionId: S1, title: 'Newest', eventSeq: 4, updatedAt: 300 },
    })
    manager.handleMuxEnvelope({
      rpcId: 'title-stale' as never,
      payload: { type: 'session/title', sessionId: S1, title: 'Stale', eventSeq: 3, updatedAt: 900 },
    })
    manager.handleMuxEnvelope({
      rpcId: 'title-equal' as never,
      payload: { type: 'session/title', sessionId: S1, title: 'Equal', eventSeq: 4, updatedAt: 901 },
    })
    api.onList = () => Promise.resolve(ok({
      items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[],
    }))
    await manager.refreshList()

    const titled = manager.getListSnapshot()
    expect(titled.items.map(item => item.sessionId)).toEqual([S1, S2])
    expect(titled.items[0]).toMatchObject({ title: 'Newest', updatedAt: 300 })
    expect(titled.items[1]?.title).toBeUndefined()

    manager.handleHostEnvelope({ rpcId: 'removed' as never, payload: { type: 'host/session-removed', sessionId: S1 } })
    manager.handleHostEnvelope({ rpcId: 'readded' as never, payload: { type: 'host/session-added', sessionId: S1 } })
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S1)?.title).toBeUndefined()
  })

  it('drops a retained title beyond the subscription baseline before accepting its durable replay', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1)] as never[] }))
    const manager = new SessionManager(api)
    await manager.refreshList()
    manager.handleMuxEnvelope({
      rpcId: 'title-unflushed' as never,
      payload: { type: 'session/title', sessionId: S1, title: 'Unflushed', eventSeq: 4, updatedAt: 400 },
    })

    manager.handleMuxEnvelope({
      rpcId: 'subscribed-recovered' as never,
      payload: { type: 'session/subscribed', sessionId: S1, lastSeq: 2 },
    })
    expect(manager.getListSnapshot().items[0]?.title).toBeUndefined()
    expect(manager.getListSnapshot().items[0]?.updatedAt).toBe(100)

    manager.handleMuxEnvelope({
      rpcId: 'title-durable' as never,
      payload: { type: 'session/title', sessionId: S1, title: 'Durable', eventSeq: 2, updatedAt: 200 },
    })
    expect(manager.getListSnapshot().items[0]).toMatchObject({ title: 'Durable', updatedAt: 200 })

    manager.handleMuxEnvelope({
      rpcId: 'subscribed-current' as never,
      payload: { type: 'session/subscribed', sessionId: S1, lastSeq: 2 },
    })
    expect(manager.getListSnapshot().items[0]).toMatchObject({ title: 'Durable', updatedAt: 200 })
  })
})

describe('host frame routing', () => {
  it('adds/removes/flips sessions from host frames and keeps removed instances resident', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    manager.handleHostEnvelope({ rpcId: 'h1' as never, payload: { type: 'host/session-added', sessionId: S1 } })
    manager.handleHostEnvelope({ rpcId: 'h2' as never, payload: { type: 'host/session-added', sessionId: S1 } }) // dup: ignored
    expect(manager.getListSnapshot().items).toHaveLength(1)

    const session = manager.get(S1)
    manager.handleHostEnvelope({ rpcId: 'h3' as never, payload: { type: 'host/session-status', sessionId: S1, running: true } })
    expect(session.getSnapshot().running).toBe(true)
    expect(manager.getListSnapshot().items[0]?.running).toBe(true)

    manager.handleHostEnvelope({ rpcId: 'h4' as never, payload: { type: 'host/agent-error', sessionId: S1, message: '炸了' } })
    expect(session.getSnapshot().lastAgentError).toBe('炸了')

    manager.handleHostEnvelope({ rpcId: 'h5' as never, payload: { type: 'host/session-removed', sessionId: S1 } })
    expect(manager.getListSnapshot().items).toHaveLength(0)
    expect(session.getSnapshot().removed).toBe(true)
    expect(manager.get(S1)).toBe(session) // resident-instance rule survives removal
  })
})

describe('remaining branches', () => {
  it('refreshList folds a transport throw into the error state', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.reject(new Error('list wire down'))
    const manager = new SessionManager(api)
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', error: { code: 'internal', message: 'list wire down' } })
  })

  it('refreshList pushes running bits down to already-instantiated sessions', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    const session = manager.get(S1)
    api.onList = () => Promise.resolve(ok({ items: [summary(S1, { running: true })] as never[] }))
    await manager.refreshList()
    expect(session.getSnapshot().running).toBe(true)
  })

  it('create passes cwd through, folds transport throws, and skips the merge when already listed', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(ok({ sessionId: S1 }))
    const manager = new SessionManager(api)
    await manager.create('/tmp/w')
    expect(api.callsOf('session.create')).toEqual([{ cwd: '/tmp/w' }])
    expect(manager.getListSnapshot().items[0]).toMatchObject({ sessionId: S1, cwd: '/tmp/w' })
    await manager.create('/tmp/w') // same id returned: no duplicate row
    expect(manager.getListSnapshot().items).toHaveLength(1)
    api.onCreate = () => Promise.reject(new Error('create wire down'))
    expect(await manager.create()).toMatchObject({ ok: false, error: { code: 'internal' } })
    // Business error passes through untouched.
    api.onCreate = () => Promise.resolve(err({ code: 'internal', message: 'no', details: {} }))
    expect(await manager.create()).toMatchObject({ ok: false })
  })

  it('subscribe notifies on list changes and stops after unsubscribe', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    let notified = 0
    const unsubscribe = manager.subscribe(() => { notified++ })
    await manager.refreshList()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBeGreaterThan(0)
    const seen = notified
    unsubscribe()
    manager.handleHostEnvelope({ rpcId: 'h' as never, payload: { type: 'host/session-added', sessionId: S1 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBe(seen)
  })

  it('routes stream/error and unknown frames to the documented drops, and dispatches to instantiated sessions', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    manager.handleMuxEnvelope({ rpcId: 'e' as never, payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } })
    manager.handleHostEnvelope({ rpcId: 'e2' as never, payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } })
    manager.handleHostEnvelope({ rpcId: 'e3' as never, payload: { type: 'future/host-frame' } as never })
    const session = manager.get(S1)
    manager.handleMuxEnvelope({ rpcId: 'q1' as never, payload: { type: 'question/requested', sessionId: S1, questions: [] } })
    expect(session.getSnapshot().pending).toMatchObject([{ kind: 'question' }])
    // status flip for an unknown session only touches summaries (no crash).
    manager.handleHostEnvelope({ rpcId: 'h9' as never, payload: { type: 'host/session-status', sessionId: S2, running: true } })
    manager.handleHostEnvelope({ rpcId: 'ha' as never, payload: { type: 'host/agent-error', sessionId: S2, message: '无实例' } })
  })

  it('keeps list-entry identity for unchanged rows across an unrelated list change', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    const manager = new SessionManager(api)
    await manager.refreshList()
    const before = manager.getListSnapshot()
    manager.handleHostEnvelope({ rpcId: 'h' as never, payload: { type: 'host/session-status', sessionId: S2, running: true } })
    const after = manager.getListSnapshot()
    expect(after.items).not.toBe(before.items)
    const beforeS1 = before.items.find(e => e.sessionId === S1)
    const afterS1 = after.items.find(e => e.sessionId === S1)
    expect(afterS1).toBe(beforeS1) // untouched entry keeps identity (entryCache)
    // Same-order same-entries snapshot reuses the items array.
    manager.handleHostEnvelope({ rpcId: 'h2' as never, payload: { type: 'host/agent-error', sessionId: S1, message: 'x' } })
    expect(manager.getListSnapshot().items).toBe(after.items)
  })

  it('carries parentSessionId from host/session-added into the lineage row', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    manager.handleHostEnvelope({ rpcId: 'h1' as never, payload: { type: 'host/session-added', sessionId: S1 } })
    manager.handleHostEnvelope({ rpcId: 'h2' as never, payload: { type: 'host/session-added', sessionId: S2, parentSessionId: S1 } })
    const items = manager.getListSnapshot().items
    expect(items.find(e => e.sessionId === S2)).toMatchObject({ parentSessionId: S1, depth: 1 })
  })
})

describe('connected generation', () => {
  it('refreshes the list and resyncs only opened instances', async () => {
    const api = new FakeApiClient()
    api.onHistory = () => Promise.resolve(ok({ events: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false }))
    const manager = new SessionManager(api)
    const openedSession = manager.get(S1)
    await openedSession.open()
    manager.get(S2) // instantiated but never opened
    const historyCallsBefore = api.callsOf('session.history').length
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(api.callsOf('session.list').length).toBe(1)
      // Only the opened instance repulls history; the cold one stays silent.
      expect(api.callsOf('session.history').length).toBe(historyCallsBefore + 1)
    })
  })
})
