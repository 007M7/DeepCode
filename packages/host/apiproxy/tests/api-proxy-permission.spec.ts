/**
 * Permission select over the proxy: permissions() projects the preset table
 * plus the derived current value (custom shown only when derived),
 * setPermission() validates against the table and anchors idle switches to
 * the next prompted turn (the ACP bridge's pendingSwitches pattern), and a
 * permission-less composition serves an empty select instead of an error.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionService from '@deepseek-ai/dsh-permission'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

async function harness(options: { permission?: boolean } = {}): Promise<{ ctx: Context; api: ApiProxy; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  if (options.permission !== false) {
    // The permission service requires a confining executor fact + approval.
    ctx.provide('bash', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission proxy tests do not execute bash') },
      run() { throw new Error('permission proxy tests do not execute bash') },
      start() { throw new Error('permission proxy tests do not execute bash') },
    })
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PermissionService, {})
  }
  const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
  // No agent-loop in this harness: register a bare live agent directly (the
  // proxy only reaches `.session`); api-proxy-view.spec.ts precedent.
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return { ctx, api, sessionId: session.id }
}

function expectOk<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

describe('session.permissions', () => {
  it('projects the preset table with the effective current value; custom is absent when a preset matches', async () => {
    const { api, sessionId } = await harness()
    const value = expectOk<{ options: { value: string }[]; currentValue: string }>(
      await api.sessions.permissions(request({ sessionId })))
    expect(value.currentValue).toBe('workspace-write')
    expect(value.options.map(o => o.value)).toEqual(['workspace-write', 'danger-full-access'])
  })

  it('serves an empty select (custom) on a permission-less composition', async () => {
    const { api, sessionId } = await harness({ permission: false })
    const value = expectOk<{ options: unknown[]; currentValue: string }>(
      await api.sessions.permissions(request({ sessionId })))
    expect(value).toEqual({ options: [], currentValue: 'custom' })
  })

  it('appends the derived custom option when the knobs match no preset', async () => {
    const { ctx, api, sessionId } = await harness()
    const agent = ctx.agents.get(sessionId)
    agent?.session.append('sandbox/mode', { mode: 'read-only' })
    const value = expectOk<{ options: { value: string }[]; currentValue: string }>(
      await api.sessions.permissions(request({ sessionId })))
    expect(value.currentValue).toBe('custom')
    expect(value.options.map(o => o.value)).toEqual(['workspace-write', 'danger-full-access', 'custom'])
  })

  it('propagates the agentFor error for a ghost session (persistence-less harness: internal)', async () => {
    // The not-found/internal split is agentFor's documented gate and already
    // covered by the history specs; here only the pass-through matters.
    const { api } = await harness()
    const response = await api.sessions.permissions(request({ sessionId: 'session-void' as SessionId }))
    expect(response.result.ok).toBe(false)
  })
})

describe('session.setPermission', () => {
  it('holds an idle switch pending (visible in permissions()) and flushes it into the next prompted turn', async () => {
    const { ctx, api, sessionId } = await harness()
    const agent = ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    const switched = expectOk<{ currentValue: string }>(
      await api.sessions.setPermission(request({ sessionId, value: 'danger-full-access' })))
    expect(switched.currentValue).toBe('danger-full-access')
    // No turn open: nothing appended yet; the pending value masks the fold.
    expect(agent?.session.events.some(e => e.type === 'permission/preset')).toBe(false)
    const echoed = expectOk<{ currentValue: string }>(
      await api.sessions.permissions(request({ sessionId })))
    expect(echoed.currentValue).toBe('danger-full-access')

    // The waterfall flush path: prompt-submit inside the new turn writes through.
    agent?.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await ctx.waterfall('agent/prompt-submit', agent as never, [], { kind: 'user' } as never, new AbortController().signal, () => Promise.resolve({ kind: 'allow' as const }))
    expect(agent?.session.events.map(e => e.type)).toContain('permission/preset')
    expect(agent?.session.events.map(e => e.type)).toContain('sandbox/mode')
    expect(agent?.session.events.map(e => e.type)).toContain('approval/policy')
  })

  it('writes through immediately inside an open turn', async () => {
    const { ctx, api, sessionId } = await harness()
    const agent = ctx.agents.get(sessionId)
    agent?.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expectOk(await api.sessions.setPermission(request({ sessionId, value: 'danger-full-access' })))
    expect(agent?.session.events.map(e => e.type)).toContain('permission/preset')
  })

  it('acknowledges a current-value echo without recording a switch', async () => {
    const { ctx, api, sessionId } = await harness()
    const agent = ctx.agents.get(sessionId)
    agent?.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const echoed = expectOk<{ currentValue: string }>(
      await api.sessions.setPermission(request({ sessionId, value: 'workspace-write' })))
    expect(echoed.currentValue).toBe('workspace-write')
    expect(agent?.session.events.some(e => e.type === 'permission/preset')).toBe(false)
  })

  it('propagates the agentFor error for a ghost session', async () => {
    const { api } = await harness()
    const response = await api.sessions.setPermission(request({ sessionId: 'session-void' as SessionId, value: 'workspace-write' }))
    expect(response.result.ok).toBe(false)
  })

  it('rejects unknown values (custom included) and a permission-less composition as bad-request', async () => {
    const { api, sessionId } = await harness()
    for (const value of ['custom', 'nope']) {
      const response = await api.sessions.setPermission(request({ sessionId, value }))
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
    }
    const bare = await harness({ permission: false })
    const response = await bare.api.sessions.setPermission(request({ sessionId: bare.sessionId, value: 'workspace-write' }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
  })
})
