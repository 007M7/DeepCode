/**
 * Projections block on the session.history tail page: a registered fake
 * provider's whole value rides the tail page with asOfSeq equal to the window
 * tail seq; loadOlder pages (beforeSeq present) never carry the block; a
 * composition without the registry serves histories without the block; a
 * disposed registration's key leaves subsequent responses; and a provider
 * value rejected by its own schema fails the handler loud.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionProvider } from '@deepseek-ai/dsh-session-projection'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    'test/echo-seq': { seenSeq: number }
  }
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`proj-${String(nextRpc++)}`), payload }
}

/** Provider whose value records the session seq it observed at get() time. */
const echoSeqProvider: ProjectionProvider<'test/echo-seq'> = {
  key: 'test/echo-seq',
  schema: z.object({ seenSeq: z.number().int().nonnegative() }),
  get: agent => ({ seenSeq: agent.session.seq }),
}

async function harness(withRegistry: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create()
  // history resolves the agent first; a live structural stub is enough (only
  // .session is read on this path).
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return { ctx, session }
}

/** Append `count` user messages so the log has paginable message boundaries. */
function seedMessages(session: Session, count: number): void {
  for (let i = 0; i < count; i++) {
    session.append('user/message', { content: [{ type: 'text', text: `m${i}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  }
}

describe('session.history projections block', () => {
  it('serves the registered value on the tail page with asOfSeq = window tail seq', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(echoSeqProvider)
    seedMessages(session, 3)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const response = await api.sessions.history(request({ sessionId: session.id }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    const { events, projections } = response.result.value
    expect(projections).toBeDefined()
    expect(projections?.asOfSeq).toBe(session.seq)
    // The cut is consistent: the value observed the same seq the block stamps.
    expect(projections?.values['test/echo-seq']).toEqual({ seenSeq: session.seq })
    // asOfSeq is the window tail: the last served event sits right below it.
    expect(events.at(-1)?.event.seq).toBe(session.seq - 1)
  })

  it('never carries the block on loadOlder pages (beforeSeq present)', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(echoSeqProvider)
    seedMessages(session, 5)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const older = await api.sessions.history(request({ sessionId: session.id, beforeSeq: 3, maxMessages: 2 }))
    expect(older.result.ok).toBe(true)
    if (!older.result.ok) throw new Error('unreachable')
    expect('projections' in older.result.value).toBe(false)
  })

  it('serves no block when the composition has no projection registry', async () => {
    const { ctx, session } = await harness(false)
    seedMessages(session, 2)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const response = await api.sessions.history(request({ sessionId: session.id }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect('projections' in response.result.value).toBe(false)
  })

  it('drops a disposed registration from subsequent tail pages (empty block, key absent)', async () => {
    const { ctx, session } = await harness(true)
    const dispose = ctx.sessionProjections.register(echoSeqProvider)
    seedMessages(session, 1)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const before = await api.sessions.history(request({ sessionId: session.id }))
    if (!before.result.ok) throw new Error('unreachable')
    expect(before.result.value.projections?.values['test/echo-seq']).toBeDefined()

    dispose()
    const after = await api.sessions.history(request({ sessionId: session.id }))
    if (!after.result.ok) throw new Error('unreachable')
    // The registry is still mounted, so the block itself stays (asOfSeq cut
    // with zero keys); the disposed key reads as capability absence.
    expect(after.result.value.projections?.asOfSeq).toBe(session.seq)
    expect(after.result.value.projections?.values).toEqual({})
  })

  it('fails loud when a provider value violates its own schema (async get is unrepresentable)', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register({
      key: 'test/echo-seq',
      schema: z.object({ seenSeq: z.number().int().nonnegative() }),
      // A Promise (what an accidentally-async get would return) is not the
      // declared shape: the boundary parse rejects it before it hits the wire.
      get: () => Promise.resolve({ seenSeq: 0 }) as never,
    })
    seedMessages(session, 1)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    await expect(api.sessions.history(request({ sessionId: session.id }))).rejects.toThrow()
  })
})
