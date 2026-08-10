/**
 * Background-task carrier paths of the host ApiProxy: the subscription
 * baseline is sent only for a session that has tasks, every registry change
 * pushes that owner's whole set, an unowned change fans out to every
 * subscribed session, the projection drops the three internal snapshot
 * fields, a composition without `ctx.tasks` emits nothing, and listing never
 * resumes a cold session.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import LocalTaskService from '@deepseek-ai/dsh-tasks-local'
import type { TaskOutcome } from '@deepseek-ai/dsh-tasks'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

type TaskFrame = Extract<MuxFrame, { type: 'session/tasks' }>

/**
 * A producer whose settlement the test drives. `cancel` deliberately does not
 * settle, so a kill is observable as the distinct `stopping` step before the
 * test supplies the terminal outcome and its detail.
 */
function producer(label = 'sleep 60') {
  let settle!: (outcome: TaskOutcome) => void
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: () => {},
      done: new Promise<TaskOutcome>((resolve) => { settle = resolve }),
    }),
  }
  return { spec, settle: (outcome: TaskOutcome) => { settle(outcome) } }
}

async function harness(withRegistry: boolean): Promise<{ ctx: Context; session: Session; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) {
    await ctx.plugin(LocalTaskService)
    ctx.tasks.attachSurface('api-proxy-test')
  }
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  return { ctx, session, agent }
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })

/** Drain the mux until `count` session/tasks frames arrived, then abort. */
async function collect(
  iterable: AsyncIterable<RpcRequest<MuxFrame>>,
  count: number,
  abort: AbortController,
): Promise<TaskFrame[]> {
  const frames: MuxFrame[] = []
  for await (const envelope of iterable) {
    frames.push(envelope.payload)
    if (frames.filter(frame => frame.type === 'session/tasks').length >= count) abort.abort()
  }
  return frames.filter((frame): frame is TaskFrame => frame.type === 'session/tasks')
}

describe('session/tasks subscription baseline', () => {
  it('is omitted for a session with no tasks — absence is the empty set', async () => {
    const { ctx, session } = await harness(true)
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-empty'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.some(frame => frame.type === 'session/subscribed')) abort.abort()
      }
    })()
    await drained
    expect(frames.some(frame => frame.type === 'session/tasks')).toBe(false)
    expect(frames.some(frame => frame.type === 'session/subscribed')).toBe(true)
    void session
  })

  it('carries the live set for a session that already has tasks when the stream opens', async () => {
    const { ctx, session, agent } = await harness(true)
    ctx.tasks.start({ ...producer('pnpm run build').spec, owner: agent })
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-baseline'), payload: {} }, abort.signal)
    const [baseline] = await collect(stream, 1, abort)
    expect(baseline?.sessionId).toBe(session.id)
    expect(baseline?.tasks).toHaveLength(1)
    const [task] = baseline?.tasks ?? []
    expect(task?.startedAt).toBeTypeOf('number')
    expect({ ...task, startedAt: 0 }).toEqual({
      id: 'bash-1',
      kind: 'bash',
      label: 'pnpm run build',
      status: 'running',
      startedAt: 0,
    })
  })
})

describe('session/tasks change pushes', () => {
  it('pushes the owner\'s whole set on registration, stopping, and settlement', async () => {
    const { ctx, session, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-changes'), payload: {} }, abort.signal)
    const collected = collect(stream, 3, abort)

    const p = producer()
    const id = ctx.tasks.start({ ...p.spec, owner: agent })
    ctx.tasks.kill(id, agent, 'test')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })

    const frames = await collected
    expect(frames.map(frame => frame.sessionId)).toEqual([session.id, session.id, session.id])
    expect(frames.map(frame => frame.tasks[0]?.status)).toEqual(['running', 'stopping', 'killed'])
    // Terminal detail rides the same whole-set push; no separate signal.
    expect(frames[2]?.tasks[0]?.detail).toBe('signal: SIGTERM')
    expect(frames[2]?.tasks[0]?.finishedAt).toBeTypeOf('number')
  })

  it('drops ownerSession, reported, and outputLimitBytes from the wire view', async () => {
    const { ctx, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-fields'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)
    ctx.tasks.start({ ...producer().spec, owner: agent, outputLimitBytes: 1_024 })

    const [frame] = await collected
    const fields: readonly string[] = Object.keys(frame?.tasks[0] ?? {})
    expect([...fields].sort()).toEqual(['id', 'kind', 'label', 'startedAt', 'status'])
  })

  it('fans an unowned change out to every subscribed session', async () => {
    const { ctx } = await harness(true)
    const second = ctx.sessions.create()
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-unowned'), payload: {} }, abort.signal)
    const collected = collect(stream, 2, abort)

    ctx.tasks.start(producer('open to every caller').spec)

    const frames = await collected
    expect(new Set(frames.map(frame => frame.sessionId)).size).toBe(2)
    expect(frames.some(frame => frame.sessionId === second.id)).toBe(true)
    for (const frame of frames) expect(frame.tasks[0]?.label).toBe('open to every caller')
  })

  it('serves a cold session the unowned set without resuming it', async () => {
    const { ctx } = await harness(true)
    const coldId = SessionId('session-cold-tasks')
    let loaded = false
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
      load: () => { loaded = true; throw new Error('task listing must not load a cold log') },
    } as never)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-cold'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)

    ctx.tasks.start(producer().spec)
    await collected
    expect(loaded).toBe(false)
    expect(ctx.agents.get(coldId)).toBeUndefined()
  })
})

describe('session/tasks without the registry', () => {
  it('emits no frames at all, so the client renders no entry point', async () => {
    const { ctx, session } = await harness(false)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-absent'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.filter(frame => frame.type === 'session/event').length >= 1) abort.abort()
      }
    })()
    session.append('turn/start', { turn: 1 })
    await drained
    expect(frames.some(frame => frame.type === 'session/tasks')).toBe(false)
  })
})
