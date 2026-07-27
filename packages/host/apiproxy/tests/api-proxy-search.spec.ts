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
      nextCursor: 'more' as never,
    }))
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)
    const signal = new AbortController().signal

    const response = await api.sessions.search(request('matching answer'), signal)

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'cold', snippet: 'the matching answer' }],
        hasMore: true,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    const [query, exec] = searchSessions.mock.calls[0] as unknown as [
      SessionSearchRequest,
      { signal: AbortSignal },
    ]
    expect(query).toEqual({
      query: 'matching answer',
      sessionFilters: [{ kind: 'id', values: ['live', 'cold'] }],
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
        nextCursor: 'more',
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
        hasMore: true,
      },
    })
  })

  it('enforces the 20-item Host boundary even if a provider overproduces', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({ items }),
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
