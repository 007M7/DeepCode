import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionHistorySource } from '../src/client/session-history/source.ts'
import { FakeApiClient, deferred, err, ok } from './fake-api.ts'
import { entries, ev, plainTurn } from './event-script.ts'

const SID = 'history-s1' as SessionId

function histResponse(events: SessionEvent[], hasMore = false) {
  return Promise.resolve(ok({ events: entries(events) as never[], hasMore }))
}

describe('SessionHistorySource', () => {
  it('loads every older page without changing a Chat session', async () => {
    const pages = [
      plainTurn(0, 0, '最早问', '最早答'),
      plainTurn(6, 1, '中间问', '中间答'),
      plainTurn(12, 2, '最新问', '最新答'),
    ]
    const api = new FakeApiClient()
    api.onHistory = (payload) => {
      if (payload.beforeSeq === undefined) return histResponse(pages[2]!, true)
      if (payload.beforeSeq === 12) return histResponse(pages[1]!, true)
      return histResponse(pages[0]!, false)
    }
    const source = new SessionHistorySource(SID, api)

    await source.loadAll()

    expect(api.callsOf('session.history')).toHaveLength(3)
    expect(source.getSnapshot().hasMore).toBe(false)
    expect(source.getSnapshot().inspection.eventNodes.map(node => node.seq))
      .toEqual([1, 3, 7, 9, 13, 15])
  })

  it('pins a lazy inspection to the entries in its source snapshot', async () => {
    const api = new FakeApiClient()
    api.onHistory = () => histResponse(plainTurn(0, 0, '问', '答'))
    const source = new SessionHistorySource(SID, api)
    await source.loadAll()
    const before = source.getSnapshot()

    source.handleMuxFrame({
      type: 'session/event',
      sessionId: SID,
      event: ev.user(6, 'later'),
    })

    expect(before.inspection.eventNodes.map(node => node.seq)).toEqual([1, 3])
    expect(source.getSnapshot().inspection.eventNodes.map(node => node.seq))
      .toEqual([1, 3, 6])
  })

  it('stops loading when an older page fails to advance', async () => {
    const api = new FakeApiClient()
    api.onHistory = payload => payload.beforeSeq === undefined
      ? histResponse(plainTurn(6, 1, '新问', '新答'), true)
      : Promise.resolve(err({
        code: 'internal',
        message: 'page unavailable',
        details: {},
      }))
    const source = new SessionHistorySource(SID, api)

    await source.loadAll()

    expect(api.callsOf('session.history')).toHaveLength(2)
    expect(source.getSnapshot().hasMore).toBe(true)
  })

  it('observes consumer cancellation between older pages', async () => {
    const middle = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    const olderStarted = deferred<undefined>()
    const api = new FakeApiClient()
    api.onHistory = (payload) => {
      if (payload.beforeSeq === undefined) {
        return histResponse(plainTurn(12, 2, '最新问', '最新答'), true)
      }
      olderStarted.resolve(undefined)
      return middle.promise
    }
    const source = new SessionHistorySource(SID, api)
    const controller = new AbortController()
    const complete = source.loadAll(controller.signal)
    await olderStarted.promise
    controller.abort()
    middle.resolve(ok({
      events: entries(plainTurn(6, 1, '中间问', '中间答')) as never[],
      hasMore: true,
    }))

    await complete

    expect(api.callsOf('session.history')).toHaveLength(2)
    expect(source.getSnapshot().hasMore).toBe(true)
  })
})
