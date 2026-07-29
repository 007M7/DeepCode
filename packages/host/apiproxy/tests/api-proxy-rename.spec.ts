/**
 * sessions.rename delegation through the composed SessionTitleService. The
 * agent factory is a structural stub whose createAgent forwards seed/meta into
 * the real SessionStore, and whose resume never runs (every source here is
 * already attached).
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`fr-${String(nextRpc++)}`), payload }
}

async function composed(withTitles = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  if (withTitles) {
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 })
  }
  // Store-backed structural factory: create builds the session with the
  // forwarded seed/meta (the store validates the balanced prefix) and
  // registers an idle agent stub over it.
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** Register one live agent whose log holds `turns` completed turns. */
function liveAgent(ctx: Context, id: string, turns: number): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const api = (ctx: Context) => createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

describe('sessions.rename', () => {
  it('accepts through the composed title service: normalized user-source event, echoed seq', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rename', 1)

    const renamed = await api(ctx).sessions.rename(request({ sessionId: source.id, title: '  new   name  ' }))
    expect(renamed.result.ok).toBe(true)
    if (!renamed.result.ok) return
    expect(renamed.result.value.title).toBe('new name')
    const event = source.events.findLast(item => item.type === 'session/title')
    expect(event?.seq).toBe(renamed.result.value.seq)
    expect(event?.data).toMatchObject({ title: 'new name', source: { kind: 'user' } })
  })

  it('maps an empty-normalizing title to title-invalid', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-rename-bad', 1)

    const response = await api(ctx).sessions.rename(request({ sessionId: source.id, title: '   ' }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error).toMatchObject({
        code: 'title-invalid',
        details: { sessionId: source.id },
      })
    }
  })

  it('answers internal when the composition mounts no session-title service', async () => {
    const ctx = await composed(false)
    const source = liveAgent(ctx, 'session-no-titles', 1)

    const response = await api(ctx).sessions.rename(request({ sessionId: source.id, title: 'name' }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('internal')
      expect(response.result.error.message).toMatch(/session-title service is absent/)
    }
  })
})
