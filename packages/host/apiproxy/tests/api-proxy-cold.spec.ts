/**
 * Cold-session and degenerate-composition paths of the host ApiProxy:
 * sessions.list merging persisted-but-unattached summaries (mtime source,
 * createdAt fallbacks, lineage projection) and the resume error split when
 * the composition has no persistence gate and no agent factory.
 */

import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
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
    expect(a?.cwd).toBe('/proj')
    expect(a?.parentSessionId).toBeUndefined()
    expect(b?.updatedAt).toBe(2000)
    expect(b?.parentSessionId).toBe('session-parent')
    expect(c?.updatedAt).toBe(1500)
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
