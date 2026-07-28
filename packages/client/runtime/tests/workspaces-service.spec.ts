import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-connection/client'
import { SessionsService } from '../src/client/sessions/service.ts'
import { WorkspaceManager } from '../src/client/workspaces/manager.ts'
import { WorkspaceCreateError, WorkspacesService } from '../src/client/workspaces/service.ts'
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

  it('replays removal over an in-flight baseline and ignores duplicate or late updates', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    api.onWorkspaceList = () => gate.promise
    const manager = new WorkspaceManager(api)
    const hydration = manager.refresh()
    manager.handleHostEnvelope({
      rpcId: 'removed' as never,
      payload: { type: 'host/workspace-removed', workspaceId: wid('gone') },
    })
    gate.resolve(ok({ items: [workspace('gone'), workspace('kept')] as never[] }))
    await hydration
    expect(manager.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept'])

    manager.handleHostEnvelope({
      rpcId: 'late-change' as never,
      payload: { type: 'host/workspace-changed', workspace: workspace('gone') },
    })
    manager.handleHostEnvelope({
      rpcId: 'duplicate-remove' as never,
      payload: { type: 'host/workspace-removed', workspaceId: wid('gone') },
    })
    expect(manager.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept'])
  })

  it('removes from the unary delete echo while a refresh is in flight', async () => {
    const api = new FakeApiClient()
    api.onWorkspaceList = () => Promise.resolve(ok({ items: [workspace('gone')] as never[] }))
    const manager = new WorkspaceManager(api)
    await manager.refresh()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    api.onWorkspaceList = () => gate.promise
    const refresh = manager.refresh()

    await expect(manager.delete(wid('gone'))).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('workspace.delete')).toEqual([{ workspaceId: 'gone' }])
    expect(manager.getSnapshot().items).toEqual([])
    gate.resolve(ok({ items: [workspace('gone')] as never[] }))
    await refresh
    expect(manager.getSnapshot().items).toEqual([])
  })
})

describe('WorkspacesService', () => {
  it('feeds readiness and recent-Workspace targeting without changing Host order', async () => {
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
      items: [{ sessionId: sid('s-active'), updatedAt: Date.parse('2026-02-01'), running: false, blank: false }] as never[],
    }))
    await sessions.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(workspaces.list.getSnapshot()).toMatchObject({
      baselinesReady: true,
      recentWorkspaceId: 'active',
    })
    expect(workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual(['stable-first', 'active'])
  })

  it('connectWorkspace reuses the workspace-matched blank session and creates otherwise', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onWorkspaceList = () => Promise.resolve(ok({
      items: [workspace('alpha'), workspace('beta')] as never[],
    }))
    api.onList = () => Promise.resolve(ok({
      items: [
        // Blank session already parked in alpha (cwd == workspace path canon).
        { sessionId: sid('s-blank'), updatedAt: 2, running: false, blank: true, cwd: '/w/alpha' },
        // Non-blank sibling in beta must never be reused.
        { sessionId: sid('s-active'), updatedAt: 3, running: false, blank: false, cwd: '/w/beta' },
      ] as never[],
    }))
    await Promise.all([workspaces.refresh(), sessions.refresh()])
    await Promise.resolve()

    // Hit: same workspace → the parked blank session comes back, no create RPC.
    await expect(workspaces.connectWorkspace(wid('alpha'))).resolves.toBe('s-blank')
    expect(api.callsOf('session.create')).toEqual([])
    // Resolution guarantee: the id is binding-resolvable synchronously.
    expect(sessions.binding(sid('s-blank'))).toBeDefined()

    // Miss: beta has only a non-blank session → host create with workspaceId.
    api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-fresh') }))
    await expect(workspaces.connectWorkspace(wid('beta'))).resolves.toBe('s-fresh')
    expect(api.callsOf('session.create')).toEqual([{ workspaceId: 'beta' }])
    // Same guarantee on the create arm (draft hand-off writes the machine pre-open).
    expect(sessions.binding(sid('s-fresh'))).toBeDefined()

    // Unknown workspace fails loud instead of silently creating in nowhere.
    await expect(workspaces.connectWorkspace(wid('ghost'))).rejects.toThrow(/unknown workspace ghost/)
  })

  it('a rejected first prompt keeps the blank session eligible for connectWorkspace reuse', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onWorkspaceList = () => Promise.resolve(ok({ items: [workspace('alpha')] as never[] }))
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s-blank'), updatedAt: 2, running: false, blank: true, cwd: '/w/alpha' }] as never[],
    }))
    await Promise.all([workspaces.refresh(), sessions.refresh()])
    await Promise.resolve()
    const session = sessions.binding(sid('s-blank'))!.session
    api.onPrompt = () => Promise.resolve(err({ code: 'internal', message: 'agent busy', details: {} }) as never)
    await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    await Promise.resolve()
    // Failure leaves blank intact, so the same session is still the reuse hit.
    await expect(workspaces.connectWorkspace(wid('alpha'))).resolves.toBe('s-blank')
    expect(api.callsOf('session.create')).toEqual([])
  })

  it('returns created Workspaces and preserves Host business errors', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onWorkspaceCreate = () => Promise.resolve(ok({
      workspace: { ...workspace('picked'), path: '/w/alpha', title: 'alpha' }, created: true,
    }))
    await expect(workspaces.create({ path: '/w/alpha' })).resolves.toMatchObject({ workspaceId: 'picked' })
    expect(workspaces.list.getSnapshot().items[0]).toMatchObject({ path: '/w/alpha', title: 'alpha' })
    expect(api.callsOf('workspace.create')).toEqual([{ path: '/w/alpha' }])
    api.onWorkspaceCreate = () => Promise.resolve(err({
      code: 'workspace-invalid-path', message: 'missing', details: { path: '/missing' },
    }))
    const rejected = workspaces.create({ path: '/missing' })
    await expect(rejected).rejects.toThrow(/workspace-invalid-path: missing/)
    await expect(rejected).rejects.toBeInstanceOf(WorkspaceCreateError)
  })

  it('passes native directory selection and cancellation through without local state', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onPickDirectory = () => Promise.resolve(ok({ path: '/w/alpha' }))
    await expect(workspaces.pickDirectory()).resolves.toBe('/w/alpha')
    api.onPickDirectory = () => Promise.resolve(ok({ path: null }))
    await expect(workspaces.pickDirectory()).resolves.toBeNull()
    expect(api.callsOf('host.pickDirectory')).toEqual([{}, {}])
  })

  it('opens a filesystem path through the host without local state', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    await expect(workspaces.openPath('/w/alpha/a.ts')).resolves.toBeUndefined()
    expect(api.callsOf('host.openPath')).toEqual([{ path: '/w/alpha/a.ts' }])
    api.onOpenPath = () => Promise.resolve(err({ code: 'internal', message: 'boom', details: {} }))
    await expect(workspaces.openPath('/missing')).rejects.toThrow(/path open failed/)
  })

  it('deletes a Workspace or preserves it when the Host rejects deletion', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionsService(ctx, api)
    const workspaces = new WorkspacesService(ctx, api, sessions)
    api.onWorkspaceList = () => Promise.resolve(ok({ items: [workspace('alpha')] as never[] }))
    await workspaces.refresh()
    await expect(workspaces.delete(wid('alpha'))).resolves.toBeUndefined()
    expect(workspaces.list.getSnapshot().items).toEqual([])

    api.onWorkspaceDelete = () => Promise.resolve(err({
      code: 'workspace-not-found', message: 'gone', details: { workspaceId: 'ghost' },
    }))
    await expect(workspaces.delete(wid('ghost'))).rejects.toThrow(/workspace-not-found: gone/)
  })
})
