import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-connection/client'
import { SessionsService } from '../src/client/sessions/service.ts'
import { WorkspaceManager } from '../src/client/workspaces/manager.ts'
import { WorkspacesService } from '../src/client/workspaces/service.ts'
import { FakeApiClient, deferred, err, ok } from './fake-api.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(id: string, sessionIds: SessionId[] = [], createdAt = '2026-01-01T00:00:00.000Z'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/w/${id}`, title: id, sessionIds,
    createdAt, updatedAt: createdAt,
  }
}

describe('WorkspaceManager', () => {
  it('owns, materializes, retries, supersedes, and discards Workspace objects with local intents', async () => {
    const api = new FakeApiClient()
    const manager = new WorkspaceManager(api)
    manager.startIntent('first')
    expect(manager.getSnapshot().intent).toEqual({ name: 'first', phase: 'ready' })

    api.onWorkspaceCreate = () => Promise.resolve(err({
      code: 'workspace-name-conflict', message: 'taken', details: { name: 'first' },
    } as never))
    await expect(manager.materializeIntent()).resolves.toMatchObject({ ok: false })
    expect(manager.getSnapshot().intent).toMatchObject({ name: 'first', phase: 'ready' })
    expect(typeof manager.getSnapshot().intent?.error).toBe('string')

    const gate = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceCreate']>>>()
    api.onWorkspaceCreate = () => gate.promise
    const stale = manager.materializeIntent()
    expect(manager.getSnapshot().intent?.phase).toBe('creating')
    manager.startIntent('replacement')
    gate.resolve(ok({ workspace: workspace('first'), created: true }))
    await stale
    expect(manager.getSnapshot().intent).toEqual({ name: 'replacement', phase: 'ready' })

    api.onWorkspaceCreate = () => Promise.resolve(ok({ workspace: workspace('replacement'), created: true }))
    await expect(manager.materializeIntent()).resolves.toMatchObject({ ok: true })
    expect(manager.getSnapshot().intent).toBeUndefined()
    await expect(manager.materializeIntent()).resolves.toBeUndefined()
    manager.discardIntent()
    manager.startIntent('discarded')
    manager.discardIntent()
    expect(manager.getSnapshot().intent).toBeUndefined()
  })

  it('replays changed frames over hydration and keeps established order on refresh', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    api.onWorkspaceList = () => gate.promise
    const manager = new WorkspaceManager(api)
    const hydration = manager.refresh()
    manager.handleHostEnvelope({
      rpcId: 'changed' as never,
      payload: { type: 'host/workspace-changed', workspace: workspace('new') },
    })
    gate.resolve(ok({ items: [workspace('old')] as never[] }))
    await hydration
    expect(manager.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle' })
    expect(manager.getSnapshot().items.map(item => item.workspaceId)).toEqual(['new', 'old'])

    api.onWorkspaceList = () => Promise.resolve(ok({
      items: [workspace('old'), workspace('new')] as never[],
    }))
    await manager.refresh()
    expect(manager.getSnapshot().items.map(item => item.workspaceId)).toEqual(['new', 'old'])
  })

  it('single-flights refreshes and exposes result and transport failures independently of readiness', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    api.onWorkspaceList = () => gate.promise
    const manager = new WorkspaceManager(api)
    const first = manager.refresh()
    const second = manager.refresh()
    expect(manager.getSnapshot().state).toBe('loading')
    gate.resolve(ok({ items: [] }))
    await Promise.all([first, second])
    expect(api.callsOf('workspace.list')).toHaveLength(1)

    api.onWorkspaceList = () => Promise.resolve(err({ code: 'internal', message: 'down', details: {} }))
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ phase: 'ready', state: 'error', error: { message: 'down' } })
    api.onWorkspaceList = () => Promise.reject(new Error('wire down'))
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ phase: 'ready', state: 'error', error: { message: 'wire down' } })
  })

  it('creates by name/path, prepends a new row, and folds failures', async () => {
    const api = new FakeApiClient()
    const manager = new WorkspaceManager(api)
    api.onWorkspaceCreate = payload => Promise.resolve(ok({
      workspace: workspace('created', [], '2026-02-01T00:00:00.000Z'),
      created: true,
      payload,
    } as never))
    await expect(manager.create({ name: 'created' })).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('workspace.create')).toEqual([{ name: 'created' }])
    expect(manager.getSnapshot().items[0]?.workspaceId).toBe('created')

    api.onWorkspaceCreate = () => Promise.reject(new Error('create transport'))
    await expect(manager.create({ path: '/w/existing' })).resolves.toMatchObject({
      ok: false, error: { code: 'internal', message: 'create transport' },
    })
  })
})

describe('WorkspacesService', () => {
  it('feeds SessionManager readiness and recent-Workspace targeting without changing Host order', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onWorkspaceList = () => Promise.resolve(ok({
      items: [
        workspace('stable-first', [], '2026-01-03T00:00:00.000Z'),
        workspace('active', [sid('s-active')], '2026-01-01T00:00:00.000Z'),
      ] as never[],
    }))
    await workspaces.refresh()
    await Promise.resolve()
    expect(workspaces.list.getSnapshot()).toMatchObject({ baselinesReady: false, recentWorkspaceId: undefined })

    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s-active'), updatedAt: Date.parse('2026-02-01'), running: false }] as never[],
    }))
    await sessions.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(workspaces.list.getSnapshot()).toMatchObject({
      baselinesReady: true,
      recentWorkspaceId: 'active',
    })
    expect(sessions.list.getSnapshot().intent).toMatchObject({
      target: { kind: 'workspace', workspaceId: 'active' },
    })
    expect(workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual(['stable-first', 'active'])
  })

  it('returns created Workspaces and preserves Host business errors', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    await expect(workspaces.create({ path: '/w/existing' })).resolves.toMatchObject({ workspaceId: 'fk-ws' })
    expect(api.callsOf('workspace.create')).toEqual([{ path: '/w/existing' }])
    api.onWorkspaceCreate = () => Promise.resolve(err({
      code: 'workspace-invalid-path', message: 'missing', details: { path: '/missing' },
    }))
    await expect(workspaces.create({ path: '/missing' })).rejects.toThrow(/workspace-invalid-path: missing/)
  })
})
