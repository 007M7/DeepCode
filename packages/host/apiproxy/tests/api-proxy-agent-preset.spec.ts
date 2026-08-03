/**
 * A session's agent preset is fixed at creation. The gateway records the
 * resolved id on the header and refuses to adopt the identity under a different
 * one, because the session's history was produced under that preset's tools:
 * rebuilding it differently would replay tool calls the new agent cannot make.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import { UnknownPresetError } from '@deepseek-ai/dsh-agent-presets'
import { createApiProxy } from '../src/api-proxy.ts'
import { describe, expect, it } from 'vitest'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`preset-${String(nextRpc++)}`), payload }
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/**
 * A roster whose `mount` is a no-op: this spec is about the gateway's identity
 * rules, and the composition itself is covered by the real-composition test in
 * `apps/cli`.
 */
function roster(ids: readonly string[]): unknown {
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(id => ({ id, trust: 'system', path: `/presets/${id}.yml` }))),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      return Promise.resolve({ id: wanted, trust: 'system', path: `/presets/${wanted}.yml` })
    },
    mount: (_ctx: Context, id?: string) =>
      Promise.resolve({ id: id ?? ids[0], trust: 'system', path: '/presets/x.yml' }),
  }
}

async function harness(presets?: readonly string[]) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-preset-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  if (presets !== undefined) ctx.provide('agentPresets', roster(presets) as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      // Setup runs before publication against a context that carries the
      // agent, and the agent reaches back through `agent.ctx` — the pair the
      // gateway's own `installTarget` relies on.
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, { provider: 'test', model: 'test-model', cwd, workspaceRoot: cwd })
  return { api, ctx, cwd }
}

describe('session.create with an agent preset', () => {
  it('records the resolved preset on the session header', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])

    const created = await api.sessions.create(request({ sessionId: SessionId('s1'), agentPreset: 'core-web' }))

    expect(created.result.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('core-web')
  })

  it('records the default when the caller names none', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])

    await api.sessions.create(request({ sessionId: SessionId('s2') }))

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset and names the ones that exist', async () => {
    const { api } = await harness(['standard'])

    const response = await api.sessions.create(request({ sessionId: SessionId('s3'), agentPreset: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('refuses to adopt a live session under a different preset', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'core-web' }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.details).toEqual({
      sessionId: 's4',
      requestedPreset: 'standard',
      existingPreset: 'core-web',
    })
  })

  it('adopts a live session unchanged when the caller names no preset', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('s5'), agentPreset: 'core-web' }))

    // Reconnecting and retrying a create must stay ordinary operations.
    const response = await api.sessions.create(request({ sessionId: SessionId('s5') }))

    expect(response.result.ok).toBe(true)
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { api, ctx } = await harness()

    await api.sessions.create(request({ sessionId: SessionId('s6') }))

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })
})
