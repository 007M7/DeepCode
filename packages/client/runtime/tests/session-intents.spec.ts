import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-connection/client'
import { SessionsService } from '../src/client/sessions/service.ts'
import { WorkspacesService } from '../src/client/workspaces/service.ts'
import { FakeApiClient, deferred, err, ok } from './fake-api.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(id: string, sessionIds: SessionId[] = []): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function ready(
  api: FakeApiClient,
  workspaces: WorkspacesService,
  sessions: SessionsService,
  workspaceRows: WorkspaceView[],
  sessionRows: { sessionId: SessionId; updatedAt: number; running: boolean }[] = [],
): Promise<void> {
  api.onWorkspaceList = () => Promise.resolve(ok({ items: workspaceRows as never[] }))
  api.onList = () => Promise.resolve(ok({ items: sessionRows as never[] }))
  await Promise.all([workspaces.refresh(), sessions.refresh()])
  await Promise.resolve()
}

function services(api: FakeApiClient): { sessions: SessionsService; workspaces: WorkspacesService } {
  const ctx = new Context()
  const sessions = new SessionsService(ctx, api)
  const workspaces = new WorkspacesService(ctx, api, sessions)
  return { sessions, workspaces }
}

function pendingPrompt(sessions: SessionsService, sessionId: SessionId) {
  return sessions.binding(sessionId)?.session.getSnapshot().pendingPrompt
}

describe('frontend Session and Workspace intents', () => {
  it('resolves the initial intent into the most recently active Workspace', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    const old = workspace('old', [sid('s-old')])
    const recent = workspace('recent', [sid('s-recent')])
    await ready(api, workspaces, sessions, [old, recent], [
      { sessionId: sid('s-old'), updatedAt: 1, running: false },
      { sessionId: sid('s-recent'), updatedAt: 2, running: false },
    ])
    expect(sessions.list.getSnapshot().intent).toMatchObject({
      target: { kind: 'workspace', workspaceId: 'recent' },
      phase: 'ready',
    })
    expect(workspaces.list.getSnapshot().intent).toBeUndefined()
  })

  it('echoes updateIntent into the list snapshot in the same tick (controlled-input contract)', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    await ready(api, workspaces, sessions, [workspace('target')])
    let notified = 0
    sessions.list.subscribe(() => { notified += 1 })
    // IME composition drives change events that a controlled textarea must see
    // reflected before the handler returns; a microtask-deferred echo makes
    // React roll the DOM back and the composition commits partial keystrokes.
    sessions.updateIntent('你')
    expect(sessions.list.getSnapshot().intent?.prompt).toBe('你')
    expect(notified).toBeGreaterThan(0)
  })

  it('ignores updateIntent with no active Intent', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    await ready(api, workspaces, sessions, [workspace('only', [sid('s-real')])], [
      { sessionId: sid('s-real'), updatedAt: 1, running: false },
    ])
    sessions.open(sid('s-real'))
    expect(sessions.list.getSnapshot().intent).toBeUndefined()
    let notified = 0
    sessions.list.subscribe(() => { notified += 1 })
    sessions.updateIntent('dropped')
    expect(notified).toBe(0)
  })

  it('materializes zero-state Workspace and Session intents and retains a rejected first prompt', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    await ready(api, workspaces, sessions, [])
    expect(workspaces.list.getSnapshot().intent).toMatchObject({ name: 'workspace', phase: 'ready' })
    sessions.updateIntent('first prompt')
    api.onWorkspaceCreate = () => Promise.resolve(ok({ workspace: workspace('created'), created: true }))
    api.onCreate = payload => Promise.resolve(ok({
      sessionId: (payload as { sessionId: SessionId }).sessionId,
    }))
    api.onPrompt = () => Promise.resolve(err({ code: 'internal', message: 'prompt offline', details: {} }))
    workspaces.sendSession()
    await vi.waitFor(() => {
      const sessionId = sessions.list.getSnapshot().current as SessionId
      expect(pendingPrompt(sessions, sessionId)).toMatchObject({
        text: 'first prompt', phase: 'failed', retry: 'send',
      })
    })
    expect(api.callsOf('workspace.create')).toEqual([{ name: 'workspace' }])
    const create = api.callsOf('session.create')[0] as { workspaceId: WorkspaceId; sessionId: SessionId }
    expect(create.workspaceId).toBe('created')
    expect(api.callsOf('session.prompt')).toEqual([{
      sessionId: create.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'first prompt' }],
    }])
    expect(workspaces.list.getSnapshot().intent).toBeUndefined()
  })

  it('turns Workspace attachment failure into a focused real Session and retries its prompt', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    const target = workspace('target')
    await ready(api, workspaces, sessions, [target])
    sessions.updateIntent('keep this')
    api.onCreate = (payload) => {
      const sessionId = (payload as { sessionId: SessionId }).sessionId
      return Promise.resolve(err({
        code: 'workspace-attach-failed',
        message: 'attach rejected',
        details: { sessionId, workspaceId: target.workspaceId },
      }))
    }
    workspaces.sendSession()
    await vi.waitFor(() => {
      const snapshot = sessions.list.getSnapshot()
      expect(snapshot.intent).toBeUndefined()
      expect(pendingPrompt(sessions, snapshot.current as SessionId)).toMatchObject({
        text: 'keep this', phase: 'failed', retry: 'connect',
      })
    })
    const published = sessions.list.getSnapshot().current as SessionId
    const session = sessions.binding(published)!.session
    session.updatePendingPrompt('retry this')
    api.onCreate = () => Promise.resolve(ok({ sessionId: published }))
    session.retryPendingPrompt()
    await vi.waitFor(() => {
      expect(pendingPrompt(sessions, published)).toBeNull()
    })
    expect(api.callsOf('session.prompt').at(-1)).toMatchObject({
      sessionId: published,
      content: [{ type: 'text', text: 'retry this' }],
    })
  })

  it('does not send after navigation while Session creation is in flight', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    const target = workspace('target')
    await ready(api, workspaces, sessions, [target])
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onCreate']>>>()
    api.onCreate = () => gate.promise
    sessions.updateIntent('do not send yet')
    workspaces.sendSession()
    await vi.waitFor(() => { expect(api.callsOf('session.create')).toHaveLength(1) })
    const requested = (api.callsOf('session.create')[0] as { sessionId: SessionId }).sessionId
    workspaces.startSession(target.workspaceId)
    const replacement = sessions.list.getSnapshot().intent!
    gate.resolve(ok({ sessionId: requested }))
    await vi.waitFor(() => {
      expect(pendingPrompt(sessions, requested)).toMatchObject({
        text: 'do not send yet', phase: 'failed', retry: 'send',
      })
    })
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(sessions.list.getSnapshot()).toMatchObject({
      current: replacement.sessionId,
      intent: { sessionId: replacement.sessionId },
    })
  })

  it('keeps a lost-response Intent and retries creation with its preallocated id', async () => {
    const api = new FakeApiClient()
    const { sessions, workspaces } = services(api)
    const target = workspace('target')
    await ready(api, workspaces, sessions, [target])
    sessions.updateIntent('preserve me')
    api.onCreate = () => Promise.reject(new Error('response lost'))
    workspaces.sendSession()
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().intent?.error).toMatchObject({ step: 'session' })
    })
    const requested = sessions.list.getSnapshot().intent?.sessionId as SessionId
    sessions.handleHostEnvelope({
      rpcId: 'published-later' as never,
      payload: { type: 'host/session-added', sessionId: requested, cwd: target.path },
    })
    expect(sessions.list.getSnapshot()).toMatchObject({
      current: requested,
      intent: { sessionId: requested, error: { step: 'session' } },
    })
    expect(sessions.intent()?.getSnapshot().pendingPrompt).toMatchObject({
      text: 'preserve me', phase: 'editing',
    })

    api.onCreate = payload => Promise.resolve(ok({
      sessionId: (payload as { sessionId: SessionId }).sessionId,
    }))
    workspaces.sendSession()
    await vi.waitFor(() => {
      expect(api.callsOf('session.create')).toHaveLength(2)
      expect(api.callsOf('session.prompt')).toHaveLength(1)
      expect(sessions.list.getSnapshot()).toMatchObject({ current: requested, intent: undefined })
      expect(pendingPrompt(sessions, requested)).toBeNull()
    })
    expect(api.callsOf('session.create').map(call => (call as { sessionId: SessionId }).sessionId))
      .toEqual([requested, requested])
  })
})
