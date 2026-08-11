/**
 * FeedbackController: the browser-local object layer over one Session's
 * message-feedback sidecar. These specs pin the per-item compare-and-set
 * contract — every mutation sends the version last observed, a conflict
 * reconciles from the authoritative item carried by the reply, mutations
 * serialize per Session, and a disposed controller stops publishing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  MessageFeedbackItem, MessageFeedbackVersion,
} from '@deepseek-ai/dsh-message-feedback/types'
import { FeedbackController, type MessageFeedbackRemote } from '../src/client/controller.ts'

const SESSION = 's-1' as SessionId
const MSG = 'm-1' as MessageId
const OTHER = 'm-2' as MessageId

const version = (v: string): MessageFeedbackVersion => v as MessageFeedbackVersion

function item(overrides: Partial<MessageFeedbackItem> = {}): MessageFeedbackItem {
  return {
    messageId: MSG,
    rating: 'positive',
    version: version('v1'),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** A recording fake Remote whose per-method answers are scripted per call. */
function fakeRemote(script: Partial<MessageFeedbackRemote> = {}) {
  const calls: { method: string; request: unknown }[] = []
  const record = <K extends keyof MessageFeedbackRemote>(
    method: K,
    real: MessageFeedbackRemote[K] | undefined,
    fallback: Awaited<ReturnType<MessageFeedbackRemote[K]>>,
  ): MessageFeedbackRemote[K] =>
    ((request: Parameters<MessageFeedbackRemote[K]>[0]) => {
      calls.push({ method, request })
      return real === undefined
        ? Promise.resolve(fallback)
        : (real as (input: typeof request) => ReturnType<MessageFeedbackRemote[K]>)(request)
    }) as MessageFeedbackRemote[K]
  const remote: MessageFeedbackRemote = {
    list: record('list', script.list, { ok: true, value: { items: [] } }),
    put: record('put', script.put, { ok: true, value: item() }),
    delete: record('delete', script.delete, { ok: true, value: { absent: true } }),
  }
  return { remote, calls }
}

describe('FeedbackController', () => {
  it('seeds the view from one list read and keys items by message id', async () => {
    const seeded = item({ note: 'good' })
    const { remote, calls } = fakeRemote({
      list: () => Promise.resolve({ ok: true, value: { items: [seeded] } }),
    })
    const controller = new FeedbackController(remote, SESSION)

    expect(controller.getSnapshot().status).toBe('cold')
    expect(await controller.ensure()).toEqual({ ok: true })

    const view = controller.getSnapshot()
    expect(view.status).toBe('ready')
    expect(view.items.get(MSG)).toEqual(seeded)
    expect(calls).toEqual([{ method: 'list', request: { sessionId: SESSION } }])
  })

  it('collapses concurrent loads onto one in-flight read', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)

    await Promise.all([controller.ensure(), controller.ensure(), controller.refresh()])

    expect(calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('sends ifVersion null for a first rating and the observed version afterwards', async () => {
    const first = item({ version: version('v1') })
    const second = item({ version: version('v2'), rating: 'negative' })
    const { remote, calls } = fakeRemote({
      put: request => Promise.resolve({
        ok: true,
        value: (request as { rating: string }).rating === 'positive' ? first : second,
      }),
    })
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({ ok: true })
    expect(await controller.rate(MSG, 'negative')).toEqual({ ok: true })

    const puts = calls.filter(call => call.method === 'put').map(call => call.request)
    expect(puts[0]).toMatchObject({ messageId: MSG, rating: 'positive', ifVersion: null })
    expect(puts[1]).toMatchObject({ messageId: MSG, rating: 'negative', ifVersion: version('v1') })
    expect(controller.getSnapshot().items.get(MSG)).toEqual(second)
  })

  it('forwards an optional note and omits the field when absent', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)

    await controller.rate(MSG, 'positive', 'helpful')
    await controller.rate(OTHER, 'negative')

    const puts = calls.filter(call => call.method === 'put').map(call => call.request as Record<string, unknown>)
    expect(puts[0]?.note).toBe('helpful')
    expect(puts[1]).not.toHaveProperty('note')
  })

  it('reconciles a version conflict from the authoritative item without refetching', async () => {
    const authoritative = item({ version: version('v9'), rating: 'negative', note: 'changed elsewhere' })
    const { remote, calls } = fakeRemote({
      put: () => Promise.resolve({
        ok: false,
        error: { code: 'version-conflict', current: authoritative },
      }),
    })
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({
      ok: false,
      error: { code: 'version-conflict', message: 'feedback changed elsewhere' },
    })

    expect(controller.getSnapshot().items.get(MSG)).toEqual(authoritative)
    expect(calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('drops the local item when a conflict reports the feedback is gone', async () => {
    const { remote } = fakeRemote({
      list: () => Promise.resolve({ ok: true, value: { items: [item()] } }),
      delete: () => Promise.resolve({
        ok: false,
        error: { code: 'version-conflict', current: null },
      }),
    })
    const controller = new FeedbackController(remote, SESSION)
    await controller.ensure()

    expect(await controller.clear(MSG)).toMatchObject({ ok: false, error: { code: 'version-conflict' } })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('deletes with the observed version and removes the item on success', async () => {
    const { remote, calls } = fakeRemote({
      list: () => Promise.resolve({ ok: true, value: { items: [item({ version: version('v7') })] } }),
    })
    const controller = new FeedbackController(remote, SESSION)
    await controller.ensure()

    expect(await controller.clear(MSG)).toEqual({ ok: true })

    expect(calls.filter(call => call.method === 'delete')[0]?.request)
      .toEqual({ sessionId: SESSION, messageId: MSG, ifVersion: version('v7') })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('treats clearing an unrated message as already satisfied without a call', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.clear(MSG)).toEqual({ ok: true })
    expect(calls.filter(call => call.method === 'delete')).toHaveLength(0)
  })

  it('serializes mutations so each one compares against the committed version', async () => {
    let inFlight = 0
    let overlapped = false
    const versions = [version('v1'), version('v2')]
    let index = 0
    const { remote, calls } = fakeRemote({
      put: async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await Promise.resolve()
        inFlight -= 1
        const next = versions[index] ?? version('vN')
        index += 1
        return { ok: true, value: item({ version: next }) }
      },
    })
    const controller = new FeedbackController(remote, SESSION)

    await Promise.all([controller.rate(MSG, 'positive'), controller.rate(MSG, 'negative')])

    expect(overlapped).toBe(false)
    const puts = calls.filter(call => call.method === 'put').map(call => call.request as Record<string, unknown>)
    expect(puts[0]?.ifVersion).toBeNull()
    expect(puts[1]?.ifVersion).toBe(version('v1'))
  })

  it('publishes an error status when the list read is rejected by the Host', async () => {
    const { remote } = fakeRemote({
      list: () => Promise.resolve({ ok: false, error: { code: 'session-not-found', sessionId: SESSION } }),
    })
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.ensure()).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'this session is no longer persisted',
    })
  })

  it('settles a transport throw as a result instead of rejecting', async () => {
    const { remote } = fakeRemote({ list: () => Promise.reject(new Error('socket closed')) })
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.ensure()).toEqual({
      ok: false,
      error: { code: 'transport', message: 'socket closed' },
    })
    expect(controller.getSnapshot().status).toBe('error')
  })

  it('settles a mutation transport throw without corrupting the view', async () => {
    const { remote } = fakeRemote({ put: () => Promise.reject(new Error('socket closed')) })
    const controller = new FeedbackController(remote, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({
      ok: false,
      error: { code: 'transport', message: 'socket closed' },
    })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('notifies subscribers on publication and stops after unsubscribe', async () => {
    const { remote } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    await controller.ensure()
    const seen = listener.mock.calls.length
    expect(seen).toBeGreaterThan(0)

    unsubscribe()
    await controller.rate(MSG, 'positive')
    expect(listener).toHaveBeenCalledTimes(seen)
  })

  it('contains a throwing subscriber at the observable boundary', async () => {
    const { remote } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    controller.subscribe(() => { throw new Error('subscriber exploded') })
    const healthy = vi.fn()
    controller.subscribe(healthy)

    await controller.ensure()

    expect(healthy).toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('refuses mutations and stops publishing once disposed', async () => {
    const { remote, calls } = fakeRemote()
    const controller = new FeedbackController(remote, SESSION)
    await controller.ensure()
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.dispose()
    const before = calls.length

    expect(await controller.rate(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(calls).toHaveLength(before)
    expect(listener).not.toHaveBeenCalled()
  })
})
