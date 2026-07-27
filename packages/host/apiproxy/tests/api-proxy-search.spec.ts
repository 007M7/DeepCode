/**
 * Host session.search projection: list-equivalent visibility, fixed message
 * filters and result bound, cancellation mapping, and unavailable/failure
 * behavior.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import {
  SessionQueryError,
  type SessionSearchHit,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (value: string): SessionId => value as SessionId
const defaults = { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' }

function request(query: string): RpcRequest<{ query: string }> {
  return { rpcId: RpcId(`search-${query}`), payload: { query } }
}

function header(id: string, cwd: string | null = '/project'): SessionHeader {
  return {
    version: 0,
    id: sid(id),
    createdAt: 100,
    ...(cwd === null ? {} : { cwd }),
  }
}

function hit(id: string, index = 0): SessionSearchHit {
  const session = header(id)
  return {
    header: session,
    live: true,
    persisted: false,
    bestMatch: {
      sessionId: session.id,
      seq: index,
      type: 'user/message',
      time: 200 + index,
      surface: 'current',
      snippet: `match ${index}`,
    },
  }
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  return ctx
}

describe('session.search', () => {
  it('searches only list-visible ids and current conversation-message events', async () => {
    const ctx = await baseContext()
    const live = ctx.sessions.create(sid('live'), { meta: header('live', '/live') })
    live.append('user/message', {
      content: [{ type: 'text', text: 'live text' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const cold = header('cold', '/cold')
    const legacy = header('legacy', null)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([cold, legacy]),
      locate: () => undefined,
    } as never)

    const searchSessions = vi.fn((
      _request: SessionSearchRequest,
      _exec?: { signal?: AbortSignal },
    ) => Promise.resolve({
      items: [
        {
          header: legacy,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: legacy.id,
            seq: 3,
            type: 'user/message' as const,
            time: 190,
            surface: 'current' as const,
            snippet: 'must remain hidden',
          },
        },
        {
          header: cold,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: cold.id,
            seq: 4,
            type: 'assistant/message' as const,
            time: 200,
            surface: 'current' as const,
            snippet: 'the matching answer',
          },
        },
      ],
    }))
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)
    const signal = new AbortController().signal

    const response = await api.sessions.search(request('matching answer'), signal)

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'cold', snippet: 'the matching answer' }],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    const [query, exec] = searchSessions.mock.calls[0] as unknown as [
      SessionSearchRequest,
      { signal: AbortSignal },
    ]
    expect(query).toEqual({
      query: 'matching answer',
      eventFilters: [
        {
          kind: 'type',
          values: ['user/message', 'assistant/message', 'steering/message'],
        },
        { kind: 'surface', values: ['current'] },
      ],
      limit: 20,
    })
    expect(exec.signal).toBe(signal)
  })

  it('returns an empty page without invoking the index when no session is visible', async () => {
    const ctx = await baseContext()
    const searchSessions = vi.fn()
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)

    const response = await api.sessions.search(
      request('anything'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('rejects snippets whose provider provenance violates the Host filters', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    const withBestMatch = (
      index: number,
      bestMatch: Partial<SessionSearchHit['bestMatch']>,
    ): SessionSearchHit => {
      const base = hit('visible', index)
      return { ...base, bestMatch: { ...base.bestMatch, ...bestMatch } }
    }
    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({
        items: [
          withBestMatch(0, { sessionId: sid('hidden') }),
          withBestMatch(1, { surface: 'shadowed' }),
          withBestMatch(2, { type: 'tool/result' }),
          withBestMatch(3, { type: 'steering/message', snippet: 'allowed snippet' }),
        ],
      }),
    } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('match'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'visible', snippet: 'allowed snippet' }],
        hasMore: false,
      },
    })
  })

  it('pages the globally ranked stream until the 20-item Host boundary is known', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({
        items: [hit('hidden-ranked-first'), ...items.slice(0, 19)],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: items.slice(19) })
    ctx.provide('sessionQuery', {
      searchSessions,
    } as never)
    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('match'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items).toHaveLength(20)
    expect(response.result.value.items.at(-1)?.sessionId).toBe('visible-19')
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page-2' })
  })

  it('fails closed after 100 provider pages with distinct continuation cursors', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    let pageNumber = 0
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      pageNumber++
      expect(providerRequest.limit).toBe(20)
      return Promise.resolve({
        items: [],
        nextCursor: `page-${pageNumber}`,
      })
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('endless-pages'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('100-page work budget')
    expect(searchSessions).toHaveBeenCalledTimes(100)
  })

  it('rejects an oversized provider page before iterating its items', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const oversized = new Array<SessionSearchHit>(21)
    const iterate = vi.fn(() => oversized.values())
    Object.defineProperty(oversized, Symbol.iterator, { value: iterate })
    const searchSessions = vi.fn(() => Promise.resolve({ items: oversized }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('oversized-page'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('returned 21 items; maximum is 20')
    expect(iterate).not.toHaveBeenCalled()
  })

  it('inspects only numerically stored items when a compliant page overrides iteration', async () => {
    const ctx = await baseContext()
    const visible = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of visible) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const stored = visible.slice(0, 1)
    const iterate = vi.fn(() => visible.values())
    Object.defineProperty(stored, Symbol.iterator, { value: iterate })
    const searchSessions = vi.fn(() => Promise.resolve({ items: stored }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('custom-iterator'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'visible-0', snippet: 'match 0' }],
        hasMore: false,
      },
    })
    expect(iterate).not.toHaveBeenCalled()
  })

  it('fails closed when the provider repeats a continuation cursor', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'repeated' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'repeated' })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('repeated-cursor'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('validates a repeated cursor before accepting the authorized lookahead', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'repeated' })
      .mockResolvedValueOnce({ items: items.slice(20), nextCursor: 'repeated' })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('repeated-lookahead-cursor'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    expect(response.result).not.toHaveProperty('value')
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not count duplicate session ids toward the result or lookahead boundary', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'page-3' })
      .mockResolvedValueOnce({ items: items.slice(20) })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('duplicate-pages'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId)).toEqual(
      items.slice(0, 20).map(item => item.header.id),
    )
    expect(searchSessions).toHaveBeenCalledTimes(3)
  })

  it('cancels on a continuation page and passes the carrier signal to both calls', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.resolve({ items: [] })
      })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('cancel-continuation'),
      controller.signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    for (const call of searchSessions.mock.calls) {
      expect(call[1]).toEqual({ signal: controller.signal })
    }
  })

  it('keeps visibility sets above SQLite variable limits out of provider bindings', async () => {
    const ctx = await baseContext()
    const cold = Array.from(
      { length: 32_751 },
      (_, index) => header(`cold-${index}`, `/cold-${index}`),
    )
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(cold),
      locate: () => undefined,
    } as never)
    const searchSessions = vi.fn((_request: SessionSearchRequest) => Promise.resolve({
      items: [hit('cold-32750')],
    }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('large corpus'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'cold-32750', snippet: 'match 0' }],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    expect(searchSessions.mock.calls[0]?.[0]).not.toHaveProperty('sessionFilters')
  })

  it('propagates cancellation through visible-session collection and stops cold-summary work', async () => {
    const ctx = await baseContext()
    const controller = new AbortController()
    const cold = Array.from({ length: 32 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const list = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return Promise.resolve(cold)
    })
    let locateCalls = 0
    ctx.provide('sessionPersistence', {
      list,
      locate: () => {
        locateCalls++
        controller.abort()
        return undefined
      },
    } as never)
    const searchSessions = vi.fn()
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('cancel-during-visibility'),
      controller.signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(list).toHaveBeenCalledOnce()
    expect(locateCalls).toBe(1)
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('maps missing composition, query cancellation, and provider failure', async () => {
    const missingCtx = await baseContext()
    missingCtx.sessions.create(sid('visible'), { meta: header('visible') })
    const missingApi = createApiProxy(missingCtx, defaults)
    const preAborted = new AbortController()
    preAborted.abort()
    const cancelledBeforeLookup = await missingApi.sessions.search(
      request('cancel-before-lookup'),
      preAborted.signal,
    )
    expect(cancelledBeforeLookup.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const missing = await missingApi.sessions.search(
      request('needle'),
      new AbortController().signal,
    )
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('unreachable')
    expect(missing.result.error.code).toBe('internal')
    expect(missing.result.error.message).toContain('does not mount')

    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const aborted = new SessionQueryError('provider stopped', 'SESSION_QUERY_ABORTED')
    const searchSessions = vi.fn()
      .mockRejectedValueOnce(aborted)
      .mockRejectedValueOnce(new Error('database unavailable'))
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)

    const cancelled = await api.sessions.search(
      request('first'),
      new AbortController().signal,
    )
    expect(cancelled.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const failed = await api.sessions.search(
      request('second'),
      new AbortController().signal,
    )
    expect(failed.result.ok).toBe(false)
    if (failed.result.ok) throw new Error('unreachable')
    expect(failed.result.error.code).toBe('internal')
    expect(failed.result.error.message).toContain('database unavailable')
  })
})
