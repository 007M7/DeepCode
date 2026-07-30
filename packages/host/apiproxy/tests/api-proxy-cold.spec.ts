/**
 * Cold-session and degenerate-composition paths of the host ApiProxy:
 * sessions.list merging persisted-but-unattached summaries (mtime source,
 * createdAt fallbacks, lineage projection), the resume error split when
 * the composition has no persistence gate and no agent factory, and the
 * agent-busy mapping of a synchronous prompt rejection.
 */

import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`cold-${String(nextRpc++)}`), payload }
}

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: sid(id), createdAt, cwd: '/proj', ...extra }
}

describe('sessions.list cold merge', () => {
  it('summarizes unattached sessions: log mtime, locate-less and vanished-log createdAt fallbacks, lineage', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserInteractionService)
    const root = mkdtempSync(join(tmpdir(), 'dsh-cold-'))
    const logPath = join(root, 'a.log')
    writeFileSync(logPath, 'log-bytes')
    utimesSync(logPath, 5000, 5000) // mtime 5_000_000 ms — newer than every createdAt below
    const metas = [
      header('session-a', 1000),
      header('session-b', 2000, { parentSession: sid('session-parent') }),
      header('session-c', 1500),
    ]
    // Structural fake of the persistence face list() consumes: list + locate.
    // locate: a real per-session file (mtime wins), a backend without one
    // (SQLite shape → createdAt), and a path whose file vanished (stat ENOENT
    // → createdAt).
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(metas),
      locate: (meta: SessionHeader) => {
        if (meta.id === sid('session-a')) return { kind: 'jsonl', path: logPath }
        if (meta.id === sid('session-c')) return { kind: 'jsonl', path: join(root, 'vanished.log') }
        return undefined
      },
    })
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const response = await api.sessions.list(request({}))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    const items = response.result.value.items
    expect(items.map(item => item.sessionId)).toEqual(['session-a', 'session-b', 'session-c'])
    const [a, b, c] = items
    expect(a?.updatedAt).toBeCloseTo(5_000_000, -3)
    expect(a?.running).toBe(false)
    // Cold summaries are never blank: lazy persistence keeps never-appended
    // sessions out of list(), so a listed session necessarily has events.
    expect(items.every(item => !item.blank)).toBe(true)
    expect(a?.cwd).toBe('/proj')
    expect(a?.parentSessionId).toBeUndefined()
    expect(b?.updatedAt).toBe(2000)
    expect(b?.parentSessionId).toBe('session-parent')
    expect(c?.updatedAt).toBe(1500)
  })
})

describe('attached updatedAt excludes end-seed', () => {
  it('reports the last real work, not the pickup, so a resumed-untouched session does not float', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserInteractionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    // Old work, resumed just now: the log tail would report the pickup.
    const worked = 1_000_000
    const resumed = ctx.sessions.create(sid('resumed-untouched'), {
      seed: [
        { type: 'turn/start', seq: 0, time: worked, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
        { type: 'turn/end', seq: 1, time: worked, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      meta: { cwd: '/proj', createdAt: 500 },
    })
    ctx.agents.register({ id: resumed.id, session: resumed, status: 'idle', ctx } as Agent)
    const boundary = resumed.events.at(-1)
    expect(boundary?.type).toBe('session/end-seed')
    expect(boundary?.time).toBeGreaterThan(worked)

    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('list failed')
    const summary = listed.result.value.items.find(item => item.sessionId === 'resumed-untouched')
    expect(summary?.updatedAt).toBe(worked)

    // Real work appended after end-seed does move it.
    resumed.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    const after = await api.sessions.list(request({}))
    if (!after.result.ok) throw new Error('list failed')
    const moved = after.result.value.items.find(item => item.sessionId === 'resumed-untouched')
    expect(moved?.updatedAt).toBeGreaterThan(worked)
  })
})

describe('degenerate composition (no persistence, no factory)', () => {
  it('list skips the cold merge and resume maps a non-not-found failure to internal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    const listed = await api.sessions.list(request({}))
    expect(listed.result.ok).toBe(true)
    if (listed.result.ok) expect(listed.result.value.items).toEqual([])

    // No persistence → the servable gate passes silently; the factory-less
    // registry then rejects resume, which is NOT a SessionNotFound.
    const response = await api.sessions.history(request({ sessionId: sid('session-ghost') }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('internal')
      expect(response.result.error.message).toMatch(/resume failed for session "session-ghost"/)
    }
  })
})

describe('sessions.prompt synchronous rejection', () => {
  it('maps a synchronous send throw (disposed/invalid input) to agent-busy with the reason attached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    const session = ctx.sessions.create(sid('session-throwing'))
    // A live structural stub whose delivery verbs throw synchronously, the
    // shape a disposed loop presents at this seam.
    ctx.agents.register({
      id: session.id,
      session,
      status: 'idle',
      ctx,
      followup: () => { throw new Error('agent "session-throwing" lifecycle disposed') },
      steer: () => { throw new Error('agent "session-throwing" lifecycle disposed') },
    } as unknown as Agent)
    const api = createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' })

    for (const mode of ['queue', 'steer'] as const) {
      const response = await api.sessions.prompt(request({
        sessionId: session.id, mode, content: [{ type: 'text' as const, text: 'x' }],
      }))
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) {
        expect(response.result.error.code).toBe('agent-busy')
        expect(response.result.error.message).toBe('prompt rejected')
        expect(response.result.error.details).toEqual({
          reason: 'Error: agent "session-throwing" lifecycle disposed',
        })
      }
    }
  })
})
