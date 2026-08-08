/**
 * Schedule reminder views cross the Host only after persistence proves their
 * dispatch prefix. Live append sends raw events; session/flushed replays the
 * identical dispatch with a generic sidecar. History independently gates the
 * same projection on an identity-matching stored prefix.
 */

import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { ScheduleId } from '@deepseek-ai/dsh-tool-schedule'

interface FlushControl {
  handler: () => true | Promise<true>
}

function reminderCreateData(id: string, prompt: string) {
  return {
    version: 1 as const,
    operation: 'create' as const,
    schedule: {
      id: ScheduleId(id),
      kind: 'after' as const,
      prompt,
      afterSeconds: 1,
      scheduledAt: '2026-08-05T12:00:01.000Z',
    },
  }
}

async function harness(control?: FlushControl): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  if (control !== undefined) ctx.on('session/flush', () => control.handler())
  return ctx
}

function appendReminder(
  session: Session,
  id: string,
  prompt: string,
): { create: SessionEvent; dispatch: SessionEvent } {
  const scheduleId = ScheduleId(id)
  const create = session.append('schedule/change', reminderCreateData(id, prompt))
  const dispatch = session.append('schedule/change', {
    version: 1,
    operation: 'dispatch',
    id: scheduleId,
  })
  return { create, dispatch }
}

async function collectEvents(
  iterable: AsyncIterable<RpcRequest<MuxFrame>>,
  count: number,
  abort: AbortController,
): Promise<Extract<MuxFrame, { type: 'session/event' }>[]> {
  const events: Extract<MuxFrame, { type: 'session/event' }>[] = []
  for await (const envelope of iterable) {
    if (envelope.payload.type !== 'session/event') continue
    events.push(envelope.payload)
    if (events.length >= count) abort.abort()
  }
  return events
}

describe('commit-aware Schedule live views', () => {
  it('takes the max of reverse flush completion and replays each dispatch once', async () => {
    const first = Promise.withResolvers<true>()
    let calls = 0
    const ctx = await harness({
      handler: () => ++calls === 1 ? first.promise : true,
    })
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })
    const abort = new AbortController()
    const collected = collectEvents(
      api.events.mux({ rpcId: RpcId('schedule-live'), payload: {} }, abort.signal),
      6,
      abort,
    )
    const session = ctx.sessions.create(SessionId('schedule-live'))
    const firstPair = appendReminder(session, 'schedule-1', 'first')
    const slow = ctx.sessions.flush(session)
    const secondPair = appendReminder(session, 'schedule-2', 'second')
    await expect(ctx.sessions.flush(session)).resolves.toBe(true)
    first.resolve(true)
    await expect(slow).resolves.toBe(true)

    const frames = await collected
    const raw = frames.filter(frame => frame.view === undefined)
    const presented = frames.filter(frame => frame.view?.for === 'event')
    expect(raw.map(frame => frame.event.seq)).toEqual([0, 1, 2, 3])
    expect(presented.map(frame => frame.event.seq)).toEqual([1, 3])
    expect(presented[0]?.event).toBe(firstPair.dispatch)
    expect(presented[1]?.event).toBe(secondPair.dispatch)
    expect(presented.map(frame => frame.view)).toEqual([
      {
        for: 'event',
        view: {
          scheduleId: 'schedule-1', prompt: 'first',
          occurrenceAt: '2026-08-05T12:00:01.000Z',
        },
      },
      {
        for: 'event',
        view: {
          scheduleId: 'schedule-2', prompt: 'second',
          occurrenceAt: '2026-08-05T12:00:01.000Z',
        },
      },
    ])
    expect(firstPair.create.seq).toBe(0)
    await ctx.fiber.dispose()
  })

  it('withholds a view after rejection and publishes it on the next successful checkpoint', async () => {
    let calls = 0
    const ctx = await harness({
      handler: () => ++calls === 1 ? Promise.reject(new Error('disk unavailable')) : true,
    })
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })
    const abort = new AbortController()
    const collected = collectEvents(
      api.events.mux({ rpcId: RpcId('schedule-retry'), payload: {} }, abort.signal),
      3,
      abort,
    )
    const session = ctx.sessions.create(SessionId('schedule-retry'))
    appendReminder(session, 'schedule-1', 'retry me')
    await expect(ctx.sessions.flush(session)).rejects.toThrow('disk unavailable')
    await expect(ctx.sessions.flush(session)).resolves.toBe(true)

    const frames = await collected
    expect(frames.filter(frame => frame.view?.for === 'event')).toHaveLength(1)
    expect(frames.at(-1)?.view).toMatchObject({
      for: 'event',
    })
    await ctx.fiber.dispose()
  })
})

describe('Schedule history views', () => {
  it('presents a resumed ancestor dispatch copied into a fork seed', async () => {
    const ctx = await harness()
    const scheduleId = ScheduleId('resumed-reminder')
    const resumed = ctx.sessions.create(SessionId('schedule-resumed'), {
      seed: [{
        type: 'schedule/change',
        seq: 0,
        time: 1,
        data: reminderCreateData('resumed-reminder', 'after restart'),
      }],
      meta: { cwd: '/tmp' },
    })
    const dispatch = resumed.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: scheduleId,
    })
    const child = ctx.sessions.fork(resumed, undefined, SessionId('schedule-fork'))
    ctx.provide('sessionPersistence', {
      readFrom: () => Promise.resolve({ meta: child.header, events: [...child.events] }),
    } as never)
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })

    const response = await api.sessions.history({
      rpcId: RpcId('schedule-resumed-fork'), payload: { sessionId: child.id },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    expect(response.result.value.events.find(entry => entry.event.seq === dispatch.seq)?.view).toEqual({
      for: 'event',
      view: {
        scheduleId,
        prompt: 'after restart',
        occurrenceAt: '2026-08-05T12:00:01.000Z',
      },
    })
    await ctx.fiber.dispose()
  })

  it('uses only the attached identity-matching stored prefix and fails soft to raw history', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('schedule-parent'), { meta: { cwd: '/tmp' } })
    appendReminder(parent, 'parent-reminder', 'from parent')
    const session = ctx.sessions.create(SessionId('schedule-attached'), {
      seed: [...parent.events],
      meta: { cwd: '/tmp', parentSession: parent.id, seedLength: 2 },
    })
    let readFrom = (): Promise<{ meta: SessionHeader; events: SessionEvent[] }> => Promise.resolve({
      meta: session.header,
      events: [...session.events.slice(0, 1)],
    })
    ctx.provide('sessionPersistence', {
      readFrom: () => readFrom(),
    } as never)
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })
    const history = async () => {
      const response = await api.sessions.history({
        rpcId: RpcId('schedule-history'), payload: { sessionId: session.id },
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.events
    }

    expect((await history()).find(entry => entry.event.seq === 1)?.view).toBeUndefined()
    readFrom = () => Promise.resolve({
      meta: { ...session.header, delegationDepth: 0 },
      events: [...session.events.slice(0, 2)],
    })
    expect((await history()).find(entry => entry.event.seq === 1)?.view).toMatchObject({
      for: 'event',
    })
    readFrom = () => Promise.resolve({
      meta: { ...session.header, cwd: '/different', delegationDepth: 0 },
      events: [...session.events.slice(0, 2)],
    })
    expect((await history()).find(entry => entry.event.seq === 1)?.view).toBeUndefined()
    readFrom = () => Promise.reject(new Error('physical read unavailable'))
    expect((await history()).find(entry => entry.event.seq === 1)?.view).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('presents every dispatch in detached persisted history', async () => {
    const ctx = await harness()
    let source: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      source = inner.sessions.create(SessionId('schedule-source'), { meta: { cwd: '/tmp' } })
    }, { inject: ['sessions'] }))
    if (source === undefined) throw new Error('session owner did not publish its session')
    appendReminder(source, 'schedule-1', 'cold reminder')
    const meta = source.header
    const events = [...source.events]
    await owner.dispose()
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
      readFrom: () => Promise.resolve({ meta, events }),
    } as never)
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })
    const response = await api.sessions.history({
      rpcId: RpcId('schedule-cold'), payload: { sessionId: meta.id },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    expect(response.result.value.events.find(entry => entry.event.seq === 1)?.view).toMatchObject({
      for: 'event',
    })
    await ctx.fiber.dispose()
  })

  it('withholds a detached view that exists only in a logical inspection', async () => {
    const ctx = await harness()
    let source: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      source = inner.sessions.create(SessionId('schedule-logical-only'), { meta: { cwd: '/tmp' } })
    }, { inject: ['sessions'] }))
    if (source === undefined) throw new Error('session owner did not publish its session')
    appendReminder(source, 'schedule-logical', 'not physically committed')
    const meta = source.header
    const events = [...source.events]
    await owner.dispose()
    let physicalEvents = events.slice(0, 1)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
      readFrom: () => Promise.resolve({ meta, events: physicalEvents }),
    } as never)
    const api = createApiProxy(ctx, { defaultTarget: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp', workspaceRoot: '/tmp' })
    const history = async () => {
      const response = await api.sessions.history({
        rpcId: RpcId('schedule-logical-only-history'), payload: { sessionId: meta.id },
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return response.result.value.events
    }

    expect((await history()).find(entry => entry.event.seq === 1)?.view).toBeUndefined()
    physicalEvents = events
    expect((await history()).find(entry => entry.event.seq === 1)?.view).toMatchObject({ for: 'event' })
    await ctx.fiber.dispose()
  })
})
