import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId
const PARENT = sid('parent')
const CHILD = sid('child')

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('subagent-rpc'), payload }
}

function bench(options: {
  parentLive?: boolean
  entries?: object[]
  followupError?: Error
  listError?: Error
  readError?: Error
  historyParent?: SessionId
} = {}) {
  const parent = { id: PARENT }
  const getAgent = vi.fn((id: SessionId) =>
    options.parentLive !== false && id === PARENT ? parent : undefined)
  const listChildren = vi.fn(() => options.listError === undefined
    ? Promise.resolve(options.entries ?? [
      { kind: 'child', id: CHILD, mode: 'continuable', label: 'worker', activity: 'inactive' },
    ])
    : Promise.reject(options.listError))
  const followup = vi.fn((
    _parent: unknown,
    _childId: SessionId,
    _content: unknown,
    _delivery: { source: { kind: string; rpcId: RpcId }; signal: AbortSignal },
  ) => options.followupError === undefined
    ? Promise.resolve('message-1')
    : Promise.reject(options.followupError))
  const readSession = vi.fn(() => options.readError === undefined
    ? Promise.resolve({
      session: {
        version: 0, id: CHILD, createdAt: 1, parentSession: options.historyParent ?? PARENT,
      } satisfies SessionHeader,
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } } },
      ] as unknown as SessionEvent[],
    })
    : Promise.reject(options.readError))
  const ctx = new Context()
  ctx.provide('agents', { get: getAgent })
  ctx.provide('subagents', { listChildren, followup })
  ctx.provide('sessionQuery', { readSession })
  ctx.provide('userInteraction', { registerProvider: () => () => {} })
  const api = createApiProxy(ctx, {
    provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp',
  })
  return { api, getAgent, listChildren, readSession, followup, parent }
}

describe('subagent gateway', () => {
  it('lists the complete catalog and reports exact live-parent availability', async () => {
    const { api, listChildren } = bench({ parentLive: false, entries: [
      { kind: 'child', id: CHILD, mode: 'continuable', label: 'worker', activity: 'inactive' },
      { kind: 'child', id: sid('one-shot'), mode: 'one-shot', activity: 'inactive' },
      { kind: 'diagnostic', id: sid('bad'), reason: 'corrupt' },
    ] })
    const response = await api.subagents.list(request({ parentSessionId: PARENT }))
    expect(response.rpcId).toBe('subagent-rpc')
    expect(response.result).toMatchObject({
      ok: true,
      value: { parentAvailable: false, entries: [{ kind: 'child' }, { kind: 'diagnostic' }] },
    })
    expect(listChildren).toHaveBeenCalledWith(PARENT, undefined)
  })

  it('reads a healthy direct child without looking up or activating any Agent', async () => {
    const { api, getAgent, readSession } = bench()
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, maxMessages: 10,
    }))
    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: false, events: [{ event: { type: 'user/message', seq: 0 } }] },
    })
    expect(readSession).toHaveBeenCalledWith(CHILD)
    expect(getAgent).not.toHaveBeenCalled()
  })

  it('rejects a diagnostic address before reading history', async () => {
    const { api, readSession } = bench({ entries: [
      { kind: 'diagnostic', id: CHILD, reason: 'unsupported' },
    ] })
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD,
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-catalog-diagnostic',
        details: { parentSessionId: PARENT, childSessionId: CHILD, reason: 'unsupported' },
      },
    })
    expect(readSession).not.toHaveBeenCalled()
  })

  it('routes human content through the exact live parent with rpc attribution', async () => {
    const { api, parent, followup } = bench()
    const content = [{ type: 'text' as const, text: '继续' }]
    const response = await api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, content,
    }))
    expect(response.result).toMatchObject({
      ok: true, value: { messageId: 'message-1' },
    })
    expect(followup).toHaveBeenCalledTimes(1)
    const [actualParent, actualChild, actualContent, delivery] = followup.mock.calls[0]!
    expect([actualParent, actualChild, actualContent]).toEqual([parent, CHILD, content])
    expect(delivery.source).toEqual({ kind: 'user', rpcId: RpcId('subagent-rpc') })
    expect(delivery.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails before delivery when the parent is absent and maps continuation failures', async () => {
    const absent = bench({ parentLive: false })
    expect((await absent.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, content: [],
    }))).result).toMatchObject({ ok: false, error: { code: 'subagent-parent-unavailable' } })
    expect(absent.listChildren).not.toHaveBeenCalled()

    const failed = bench({ followupError: new SubagentError('not delivered', 'DRAINING') })
    expect((await failed.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, content: [],
    }))).result).toMatchObject({ ok: false, error: { code: 'subagent-not-delivered' } })
  })

  it('maps history disappearance and hides unexpected backend details', async () => {
    const disappeared = bench({
      readError: new SessionQueryError('secret path', 'SESSION_QUERY_SESSION_NOT_FOUND'),
    })
    expect((await disappeared.api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD,
    }))).result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-not-found',
        message: 'subagent disappeared during history read',
        details: { parentSessionId: PARENT, childSessionId: CHILD },
      },
    })

    const catalog = bench({ listError: new Error('secret descriptor') })
    expect((await catalog.api.subagents.list(request({
      parentSessionId: PARENT,
    }))).result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'subagent catalog read failed' },
    })

    const prompt = bench({ followupError: new Error('secret provider') })
    expect((await prompt.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, content: [],
    }))).result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'subagent prompt failed' },
    })
  })
})
