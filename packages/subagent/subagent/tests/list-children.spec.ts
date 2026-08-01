import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import SubagentService, {
  SUBAGENT_DESCRIPTOR_VERSION,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQueryService } from '../../../session-query/session-query/tests/test-service.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack plus a concrete session-query service. */
async function setup(script: Script, options: { sessionQuery?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-list-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  if (options.sessionQuery !== false) await ctx.plugin(TestSessionQueryService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

const testSignal = new AbortController().signal

/** Start one continuable child through the real service path and await Activation release. */
async function startChild(
  ctx: Context,
  parent: ReturnType<Context['agentLoop']['create']>,
  label: string,
): Promise<SessionId> {
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label,
    request: { prompt: [{ type: 'text', text: `task: ${label}` }], parent },
    signal: testSignal,
  })
  await vi.waitFor(() => {
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  }, { timeout: 5_000 })
  return started.childId
}

/** Author one persisted child session directly against the persistence backend. */
async function authorChild(
  ctx: Context,
  id: string,
  header: Partial<SessionHeader>,
  events: SessionEvent[],
): Promise<SessionId> {
  const sessionId = SessionId(id)
  await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    ...header,
  })
  await ctx.sessionPersistence.append(sessionId, events)
  return sessionId
}

/** Minimal complete-turn child log with one descriptor payload. */
function childEvents(descriptor: unknown): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    { type: 'subagent/descriptor', seq: 2, time: 3, data: descriptor },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

function descriptorPayload(label: string, version = SUBAGENT_DESCRIPTOR_VERSION) {
  return { version, mode: 'continuable' as const, provider: 'spawn', label }
}

describe('SubagentService.listChildren', () => {
  it('lists through session query without the Activation continuation runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SubagentService)
    await ctx.plugin(TestSessionQueryService)
    expect(ctx.get('tasks')).toBeUndefined()
    expect(ctx.get('agents')).toBeUndefined()

    const parentId = SessionId('query-only-parent')
    ctx.sessions.create(parentId)
    const childId = SessionId('query-only-child')
    const child = ctx.sessions.create(childId, { meta: { parentSession: parentId } })
    child.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    child.append('subagent/descriptor', descriptorPayload('query-only child'))

    await expect(ctx.subagents.listChildren(parentId)).resolves.toEqual([
      {
        kind: 'child', id: childId, label: 'query-only child', mode: 'continuable',
        activity: 'running', hasChildren: false,
      },
    ])
  })

  it('fails loud before any work when session query is not loaded', async () => {
    const { ctx, parent } = await setup([], { sessionQuery: false })
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE' }) as Error,
    )
  })

  it('lists a persisted continuable child as inactive with its durable label', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'summarize the doc')
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'summarize the doc', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('lists one-shot and continuable children from the same trace', async () => {
    const { ctx, parent } = await setup([textResponse('once'), textResponse('again')])
    const oneShot = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'finish once' }],
      parent,
      signal: new AbortController().signal,
    })
    const oneShotId = oneShot.id
    await oneShot.result
    await oneShot.dispose()
    const continuableId = await startChild(ctx, parent, 'continuable child')

    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({
      kind: 'child',
      id: oneShotId,
      mode: 'one-shot',
      activity: 'inactive',
      hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child',
      id: continuableId,
      label: 'continuable child',
      mode: 'continuable',
      activity: 'inactive',
      hasChildren: false,
    })
  })

  it('accepts a persisted (non-live) parent target after restart', async () => {
    const { ctx } = await setup([])
    // A parent that exists only in persistence — the restart shape.
    const coldParent = SessionId('00000000-0000-4000-8000-00000000cccc')
    await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: coldParent,
      createdAt: 1,
    })
    await ctx.sessionPersistence.append(coldParent, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const childId = await authorChild(ctx, '00000000-0000-4000-8000-00000000cdcd', {
      parentSession: coldParent,
    }, childEvents(descriptorPayload('persisted parent case')))
    const entries = await ctx.subagents.listChildren(coldParent)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'persisted parent case', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('orders children by createdAt then id and omits ordinary forks without a diagnostic', async () => {
    const { ctx, parent } = await setup([])
    // Authored headers pin the ordering key deterministically: same createdAt
    // ties break on id, different createdAt orders ascending.
    const late = await authorChild(ctx, '00000000-0000-4000-8000-000000000003', {
      parentSession: parent.id,
      createdAt: 9,
    }, childEvents(descriptorPayload('late child')))
    const tieB = await authorChild(ctx, '00000000-0000-4000-8000-000000000002', {
      parentSession: parent.id,
      createdAt: 5,
    }, childEvents(descriptorPayload('tie b')))
    const tieA = await authorChild(ctx, '00000000-0000-4000-8000-000000000001', {
      parentSession: parent.id,
      createdAt: 5,
    }, childEvents(descriptorPayload('tie a')))
    // An ordinary session fork shares parentSession but has no descriptor.
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('plain-fork'))
    await ctx.sessions.flush(fork)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries.map(entry => entry.id)).toEqual([tieA, tieB, late])
    expect(entries.every(entry => entry.kind === 'child')).toBe(true)
  })

  it('reports a live child as running while keeping settled siblings complete', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const settled = await startChild(ctx, parent, 'settled child')
    // A live child session outside persistence: publish a live session with a
    // descriptor and the parent lineage, without starting an Activation.
    const liveId = SessionId('live-child')
    const live = ctx.sessions.create(liveId, { meta: { parentSession: parent.id } })
    live.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    live.append('subagent/descriptor', descriptorPayload('live child'))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({
      kind: 'child', id: settled, label: 'settled child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child', id: liveId, label: 'live child', mode: 'continuable',
      activity: 'running', hasChildren: false,
    })
  })

  it('diagnoses duplicate descriptors as corrupt without hiding healthy siblings', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const events = childEvents(descriptorPayload('twice'))
    events.splice(3, 0, {
      type: 'subagent/descriptor',
      seq: 3,
      time: 3,
      data: descriptorPayload('twice again'),
    } as SessionEvent)
    events[4] = { ...events[4]!, seq: 4 }
    const corrupt = await authorChild(ctx, '00000000-0000-4000-8000-00000000dupe', {
      parentSession: parent.id,
    }, events)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({ kind: 'diagnostic', id: corrupt, reason: 'corrupt' })
    expect(entries).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('diagnoses an invalid child event surface as corrupt', async () => {
    const { ctx, parent } = await setup([])
    // The surface-eligible user/message lacks its required surfaceOp, so the
    // per-child listEvents fold fails with SESSION_QUERY_INVALID_SURFACE.
    const invalid = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ee', {
      parentSession: parent.id,
    }, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
      },
      { type: 'subagent/descriptor', seq: 2, time: 3, data: descriptorPayload('broken surface') },
    ] as SessionEvent[])
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: invalid, reason: 'corrupt' }])
  })

  it('diagnoses a malformed descriptor payload as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const malformed = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ff', {
      parentSession: parent.id,
    }, childEvents({ version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 }))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: malformed, reason: 'corrupt' }])
  })

  it('diagnoses an unknown descriptor version as unsupported', async () => {
    const { ctx, parent } = await setup([])
    const future = await authorChild(ctx, '00000000-0000-4000-8000-0000000000aa', {
      parentSession: parent.id,
    }, childEvents(descriptorPayload('from the future', SUBAGENT_DESCRIPTOR_VERSION + 1)))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: future, reason: 'unsupported' }])
  })

  it('ignores an ancestor descriptor replayed inside a fork seed', async () => {
    const { ctx, parent } = await setup([])
    // A fork child whose seed replays a parent log containing a descriptor:
    // the seed's descriptor is the ANCESTOR's, not this child's.
    const seed = childEvents(descriptorPayload('ancestor label'))
    await authorChild(ctx, '00000000-0000-4000-8000-0000000000f0', {
      parentSession: parent.id,
      seedLength: seed.length,
    }, seed)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([])
  })

  it('does not filter by provider availability: children of unmounted providers stay listed', async () => {
    const { ctx, parent } = await setup([])
    const foreign = await authorChild(ctx, '00000000-0000-4000-8000-0000000000bb', {
      parentSession: parent.id,
    }, childEvents({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'not-mounted',
      label: 'orphan provider',
    }))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: foreign, label: 'orphan provider', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('maps a per-child read failure to one unavailable diagnostic after a successful trace', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'flaky storage')
    const query = ctx.get('sessionQuery')!
    const originalListEvents = query.listEvents.bind(query)
    query.listEvents = (sessionId) => {
      if (sessionId === childId) {
        return Promise.reject(new SessionQueryError('backend read failed', 'SESSION_QUERY_PERSISTENCE_FAILED'))
      }
      return originalListEvents(sessionId)
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: childId, reason: 'unavailable' }])
  })

  it('maps a mid-scan disappearance to unavailable', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'vanishing child')
    const query = ctx.get('sessionQuery')!
    query.listEvents = () =>
      Promise.reject(new SessionQueryError('gone', 'SESSION_QUERY_SESSION_NOT_FOUND'))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: childId, reason: 'unavailable' }])
  })

  it('diagnoses a read whose header no longer names this parent as corrupt', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'reparented child')
    const query = ctx.get('sessionQuery')!
    const originalReadEvent = query.readEvent.bind(query)
    query.readEvent = async (request) => {
      const window = await originalReadEvent(request)
      return {
        ...window,
        session: { ...window.session, parentSession: SessionId('someone-else') },
      }
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    // The exact read's conflicting immutable header is per-child corruption.
    expect(entries).toEqual([{ kind: 'diagnostic', id: childId, reason: 'corrupt' }])
  })

  it('diagnoses a read whose target is no longer the descriptor event as corrupt', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'shifted log')
    const query = ctx.get('sessionQuery')!
    const originalReadEvent = query.readEvent.bind(query)
    query.readEvent = async (request) => {
      const window = await originalReadEvent(request)
      return { ...window, target: { ...window.target, type: 'turn/start' } as typeof window.target }
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: childId, reason: 'corrupt' }])
  })

  it('fails the whole call when the initial trace fails', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'never listed')
    const query = ctx.get('sessionQuery')!
    query.traceSession = () =>
      Promise.reject(new SessionQueryError('listing failed', 'SESSION_QUERY_PERSISTENCE_FAILED'))
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' }) as Error,
    )
  })

  it('propagates an unrecognized per-child failure as an operation failure', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'strange failure')
    const query = ctx.get('sessionQuery')!
    query.listEvents = () => Promise.reject(new Error('not a query failure'))
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow('not a query failure')
  })

  it('propagates a configuration/window query failure instead of diagnosing the child', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'misconfigured query')
    const query = ctx.get('sessionQuery')!
    query.listEvents = () =>
      Promise.reject(new SessionQueryError('bad window', 'SESSION_QUERY_INVALID_WINDOW'))
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SESSION_QUERY_INVALID_WINDOW' }) as Error,
    )
  })

  it('lists compacted and uncompacted children identically', async () => {
    const { ctx, parent } = await setup([])
    const plain = await authorChild(ctx, '00000000-0000-4000-8000-00000000c0de', {
      parentSession: parent.id,
      createdAt: 1,
    }, childEvents(descriptorPayload('twin child')))
    // The compacted twin: a compaction checkpoint replaces the whole surface,
    // while the append-only log retains the model-hidden descriptor event.
    const compactedEvents = childEvents(descriptorPayload('twin child'))
    compactedEvents.push({
      type: 'user/message',
      seq: 4,
      time: 5,
      data: createUserMessage({
        content: [{ type: 'text', text: 'summary of everything' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }),
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    })
    const compacted = await authorChild(ctx, '00000000-0000-4000-8000-00000000c1de', {
      parentSession: parent.id,
      createdAt: 2,
    }, compactedEvents)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: plain, label: 'twin child', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
      {
        kind: 'child', id: compacted, label: 'twin child', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('reports an origin-classified grandchild without reading its events', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    const grandchildId = await authorChild(ctx, '00000000-0000-4000-8000-0000000000cc', {
      parentSession: childId,
      origin: 'subagent',
    }, childEvents(descriptorPayload('grandchild')))
    const query = ctx.get('sessionQuery')!
    const originalListEvents = query.listEvents.bind(query)
    const inspected: SessionId[] = []
    query.listEvents = (sessionId) => {
      inspected.push(sessionId)
      return originalListEvents(sessionId)
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
        activity: 'inactive', hasChildren: true,
      },
    ])
    expect(inspected).toContain(childId)
    expect(inspected).not.toContain(grandchildId)
  })

  it('does not count an ordinary grandchild without subagent origin', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    await authorChild(ctx, '00000000-0000-4000-8000-0000000000f1', {
      parentSession: childId,
    }, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])

    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
  })

  it('counts an origin-classified diagnostic grandchild', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    const diagnosticId = await authorChild(ctx, '00000000-0000-4000-8000-0000000000f2', {
      parentSession: childId,
      origin: 'subagent',
    }, childEvents({ version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 }))

    await expect(ctx.subagents.listChildren(childId)).resolves.toEqual([
      { kind: 'diagnostic', id: diagnosticId, reason: 'corrupt' },
    ])
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
      activity: 'inactive', hasChildren: true,
    }])
  })

  it('stops the scan at the between-candidates checkpoint when the signal aborts', async () => {
    const { ctx, parent } = await setup([textResponse('one'), textResponse('two')])
    await startChild(ctx, parent, 'first child')
    await startChild(ctx, parent, 'second child')
    const controller = new AbortController()
    const query = ctx.get('sessionQuery')!
    const originalListEvents = query.listEvents.bind(query)
    let inspected = 0
    query.listEvents = (sessionId) => {
      inspected += 1
      // Cancel while the first candidate's read is in flight: the loop's next
      // between-candidates checkpoint must stop before the second read.
      controller.abort()
      return originalListEvents(sessionId)
    }
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
    expect(inspected).toBe(1)
  })

  it('forwards cancellation to the initial trace and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const query = ctx.get('sessionQuery')!
    const entered = Promise.withResolvers<undefined>()
    query.traceSession = (_sessionId, signal) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('query trace aborted'))
        }, { once: true })
      })
    }
    const listing = ctx.subagents.listChildren(parent.id, controller.signal)
    await entered.promise
    controller.abort()
    await expect(listing).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('forwards cancellation to the exact descriptor read and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'cancelled exact read')
    const controller = new AbortController()
    const query = ctx.get('sessionQuery')!
    const entered = Promise.withResolvers<undefined>()
    query.readEvent = (_request, signal) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('query read aborted'))
        }, { once: true })
      })
    }
    const listing = ctx.subagents.listChildren(parent.id, controller.signal)
    await entered.promise
    controller.abort()
    await expect(listing).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('stops after a per-child read when the signal aborts mid-inspection', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'cancelled mid-read')
    const controller = new AbortController()
    const query = ctx.get('sessionQuery')!
    const originalReadEvent = query.readEvent.bind(query)
    let exactReads = 0
    query.readEvent = async (request) => {
      exactReads += 1
      const window = await originalReadEvent(request)
      controller.abort()
      return window
    }
    // The post-read checkpoint throws a subagent error, which is not a
    // session-query failure and therefore propagates instead of becoming a
    // per-child diagnostic.
    await expect(ctx.subagents.listChildren(parent.id, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'CANCELLED' }) as Error)
    expect(exactReads).toBe(1)
  })

  it('a mapped per-child failure during an abort cannot become a successful result', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'aborted behind a diagnostic')
    const controller = new AbortController()
    const query = ctx.get('sessionQuery')!
    query.listEvents = () => {
      // The read fails with a diagnostic-mapped code while the caller aborts:
      // cancellation normalization must fail the scan rather than return a
      // one-diagnostic success.
      controller.abort()
      return Promise.reject(new SessionQueryError('backend read failed', 'SESSION_QUERY_PERSISTENCE_FAILED'))
    }
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('a pre-aborted signal stops before any candidate read', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'never read')
    const controller = new AbortController()
    controller.abort()
    const query = ctx.get('sessionQuery')!
    query.listEvents = () => Promise.reject(new Error('must not be called'))
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('returns an empty array for a parent with no children', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([])
  })

  it('SubagentError from listChildren is typed with its stable code', async () => {
    const { ctx, parent } = await setup([], { sessionQuery: false })
    const caught: unknown = await ctx.subagents.listChildren(parent.id).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(SubagentError)
    expect((caught as SubagentError).code).toBe('SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE')
  })
})
