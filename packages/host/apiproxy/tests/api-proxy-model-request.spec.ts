import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

async function nextFrame<K extends MuxFrame['type']>(
  iterator: AsyncIterator<RpcRequest<MuxFrame>>,
  type: K,
): Promise<Extract<MuxFrame, { type: K }>> {
  for (;;) {
    const next = await iterator.next()
    if (next.done) throw new Error(`mux ended before ${type}`)
    if (next.value.payload.type === type) {
      return next.value.payload as Extract<MuxFrame, { type: K }>
    }
  }
}

describe('ApiProxy model-request telemetry', () => {
  it('atomically measures the observed request, forwards only live, and degrades per field', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserInteractionService)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId('model-request-telemetry'))
    const agent = {
      id: session.id,
      session,
      status: 'running',
      ctx,
    } as Agent
    ctx.agents.register(agent)
    const measure = vi.fn(() => ({ totalTokens: 321 }))
    const removeTokenMeter = ctx.provide('tokenMeter' as never, { measure } as never)
    const api = createApiProxy(ctx, {
      provider: 'test',
      model: 'alpha',
      cwd: '/tmp',
      workspaceRoot: '/tmp',
    })

    const primaryAbort = new AbortController()
    const primary = api.events.mux(
      { rpcId: RpcId('primary'), payload: {} },
      primaryAbort.signal,
    )[Symbol.asyncIterator]()
    expect((await nextFrame(primary, 'session/subscribed')).sessionId).toBe(session.id)

    agentEvents(ctx, agent).emit('agent/model-request', 1, 2, {
      provider: 'test',
      model: 'alpha',
      contextWindow: 128_000,
    })
    expect(measure).toHaveBeenCalledWith(session)
    expect(await nextFrame(primary, 'session/model-request')).toEqual({
      type: 'session/model-request',
      sessionId: session.id,
      turn: 1,
      step: 2,
      provider: 'test',
      model: 'alpha',
      contextTokens: 321,
      contextWindow: 128_000,
    })

    const history = await api.sessions.history({
      rpcId: RpcId('history'),
      payload: { sessionId: session.id },
    })
    if (!history.result.ok) throw new Error('history failed')
    expect(history.result.value).not.toHaveProperty('metrics')
    expect(history.result.value).not.toHaveProperty('modelRequest')

    const reconnectAbort = new AbortController()
    const reconnect = api.events.mux(
      { rpcId: RpcId('reconnect'), payload: {} },
      reconnectAbort.signal,
    )[Symbol.asyncIterator]()
    expect((await nextFrame(reconnect, 'session/subscribed')).sessionId).toBe(session.id)

    measure.mockImplementation(() => { throw new Error('unmeasurable replay') })
    agentEvents(ctx, agent).emit('agent/model-request', 2, 1, {
      provider: 'test',
      model: 'without-capacity',
    })
    for (const iterator of [primary, reconnect]) {
      expect(await nextFrame(iterator, 'session/model-request')).toEqual({
        type: 'session/model-request',
        sessionId: session.id,
        turn: 2,
        step: 1,
        provider: 'test',
        model: 'without-capacity',
      })
    }

    removeTokenMeter()
    agentEvents(ctx, agent).emit('agent/model-request', 3, 1, {
      provider: 'test',
      model: 'without-meter',
      contextWindow: 64_000,
    })
    expect(await nextFrame(primary, 'session/model-request')).toEqual({
      type: 'session/model-request',
      sessionId: session.id,
      turn: 3,
      step: 1,
      provider: 'test',
      model: 'without-meter',
      contextWindow: 64_000,
    })

    primaryAbort.abort()
    reconnectAbort.abort()
    await primary.return?.()
    await reconnect.return?.()
    await ctx.fiber.dispose()
  })
})
