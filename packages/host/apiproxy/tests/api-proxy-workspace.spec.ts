import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { AgentMessageId } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { HostFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    ctx: new Context(),
    followup: () => AgentMessageId('stub'),
    queue: () => AgentMessageId('stub'),
    steer: () => AgentMessageId('stub'),
    inject: () => AgentMessageId('stub'),
    send: () => AgentMessageId('stub'),
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-'))),
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    provider: 'test',
    model: 'test-model',
    cwd: workspaceRoot,
    workspaceRoot,
  })
  return { api, ctx, storageDomain, workspaceRoot }
}

describe('workspace.create', () => {
  it('serializes concurrent names and rejects the duplicate', async () => {
    const { api, workspaceRoot } = await harness()
    const responses = await Promise.all([
      api.workspace.create(request({ name: 'alpha' })),
      api.workspace.create(request({ name: 'alpha' })),
    ])
    const created = responses.find(response => response.result.ok)
    const duplicate = responses.find(response => !response.result.ok)

    expect(created).toBeDefined()
    expect(expectOk(created!)).toMatchObject({
      created: true,
      workspace: { path: join(workspaceRoot, 'alpha'), title: 'alpha' },
    })
    expect(duplicate?.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-name-conflict', details: { name: 'alpha' } },
    })
    expect(existsSync(join(workspaceRoot, 'alpha'))).toBe(true)
  })

  it('adopts only existing directories and rejects unsafe names', async () => {
    const { api, workspaceRoot } = await harness()
    const existing = join(workspaceRoot, 'existing')
    mkdirSync(existing)
    const first = expectOk(await api.workspace.create(request({ path: existing })))
    const repeated = expectOk(await api.workspace.create(request({ path: existing })))
    expect(first).toMatchObject({ created: true, workspace: { path: existing, title: 'existing' } })
    expect(repeated).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })

    const missing = join(workspaceRoot, 'missing')
    const missingResult = await api.workspace.create(request({ path: missing }))
    expect(missingResult.result).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })
    expect(existsSync(missing)).toBe(false)

    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      const invalid = await api.workspace.create(request({ name }))
      expect(invalid.result).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })
    }
  })
})

describe('session creation and Workspace membership', () => {
  it('attaches a preallocated idempotent session while cwd-only sessions stay ungrouped', async () => {
    const { api, ctx } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ name: 'project' }))).workspace
    const sessionId = SessionId('session-workspace-preallocated')

    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(ctx.agents.list().filter(agent => agent.id === sessionId)).toHaveLength(1)

    const ungrouped = SessionId('session-cwd-only')
    expectOk(await api.sessions.create(request({ cwd: workspace.path, sessionId: ungrouped })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(ungrouped)

    const conflict = await api.sessions.create(request({ cwd: join(workspace.path, 'other'), sessionId }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { sessionId, existingCwd: workspace.path } },
    })
    const missing = await api.sessions.create(request({
      workspaceId: 'missing-workspace' as WorkspaceId,
      sessionId: SessionId('session-missing-workspace'),
    }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })

  it('retains a published session when attachment fails and repairs it on retry', async () => {
    const { api, ctx } = await harness()
    const created = expectOk(await api.workspace.create(request({ name: 'project' }))).workspace
    const workspace = ctx.workspace.list()[0]
    if (workspace === undefined) throw new Error('workspace missing from registry')
    vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('simulated write failure'))
    const sessionId = SessionId('session-attach-retry')

    const failed = await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId }))
    expect(failed.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed', details: { sessionId, workspaceId: created.workspaceId } },
    })
    expect(ctx.agents.get(sessionId)).toBeDefined()

    expectOk(await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
  })
})

describe('Host Workspace increments', () => {
  it('streams committed Workspace and Session increments after empty baselines', async () => {
    const { api } = await harness()
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const workspaceIncrement = nextHostFrame(stream)
    const workspace = expectOk(await api.workspace.create(request({ name: 'project' }))).workspace
    expect(await workspaceIncrement).toMatchObject({
      payload: { type: 'host/workspace-changed', workspace: { workspaceId: workspace.workspaceId } },
    })

    const sessionId = SessionId('session-streamed-workspace')
    const pending = nextHostFrame(stream)
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    const increments: HostFrame[] = []
    increments.push((await pending).payload)
    while (increments.length < 2) {
      const next = await stream.next()
      if (next.done === true) throw new Error('Host stream ended before both increments')
      increments.push(next.value.payload)
    }
    expect(increments.find(increment => increment.type === 'host/session-added')).toMatchObject({
      // A just-created session has no events: the frame constantly carries blank:true.
      type: 'host/session-added', sessionId, blank: true, cwd: workspace.path,
    })
    const workspaceChanged = increments.find(
      (increment): increment is Extract<HostFrame, { type: 'host/workspace-changed' }> =>
        increment.type === 'host/workspace-changed',
    )
    expect(workspaceChanged?.workspace.sessionIds).toEqual([sessionId])
    abort.abort()
  })

  it('does not publish a Workspace whose registry-order commit fails', async () => {
    const { api, storageDomain } = await harness()
    const domain = storageDomain.get('workspace')
    if (domain === undefined) throw new Error('workspace domain is not open')
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('simulated registry order failure'))
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()

    const failed = await api.workspace.create(request({ name: 'ghost' }))
    expect(failed.result.ok).toBe(false)
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })
})
