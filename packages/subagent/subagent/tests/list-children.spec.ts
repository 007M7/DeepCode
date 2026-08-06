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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService, {
  SUBAGENT_DESCRIPTOR_VERSION,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack with real JSONL session persistence. */
async function setup(script: Script, options: { sessionProjections?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-list-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.sessionProjections !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
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
  it('lists live children without persistence, query services, or the continuation runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentService)
    expect(ctx.get('tasks')).toBeUndefined()
    expect(ctx.get('agents')).toBeUndefined()
    expect(ctx.get('sessionPersistence')).toBeUndefined()

    const parentId = SessionId('live-only-parent')
    ctx.sessions.create(parentId)
    const childId = SessionId('live-only-child')
    const child = ctx.sessions.create(childId, {
      meta: { parentSession: parentId, origin: 'subagent' },
    })
    child.append('turn/start', {
      turn: 1,
    })
    child.append('subagent/descriptor', descriptorPayload('live-only child'))

    await expect(ctx.subagents.listChildren(parentId)).resolves.toEqual([
      {
        kind: 'child', id: childId, label: 'live-only child', mode: 'continuable',
        activity: 'running', hasChildren: false,
      },
    ])
  })

  it('fails loud when the projection registry is not mounted, even with no children', async () => {
    const { ctx, parent } = await setup([], { sessionProjections: false })
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE' }) as Error,
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

  it('lists one-shot and continuable children under the same parent', async () => {
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
      origin: 'subagent',
    }, childEvents(descriptorPayload('persisted parent case')))
    const entries = await ctx.subagents.listChildren(coldParent)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'persisted parent case', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('orders children by createdAt then id without listing ordinary forks', async () => {
    const { ctx, parent } = await setup([])
    // Authored headers pin the ordering key deterministically: same createdAt
    // ties break on id, different createdAt orders ascending.
    const late = await authorChild(ctx, '00000000-0000-4000-8000-000000000003', {
      parentSession: parent.id,
      createdAt: 9,
      origin: 'subagent',
    }, childEvents(descriptorPayload('late child')))
    const tieB = await authorChild(ctx, '00000000-0000-4000-8000-000000000002', {
      parentSession: parent.id,
      createdAt: 5,
      origin: 'subagent',
    }, childEvents(descriptorPayload('tie b')))
    const tieA = await authorChild(ctx, '00000000-0000-4000-8000-000000000001', {
      parentSession: parent.id,
      createdAt: 5,
      origin: 'subagent',
    }, childEvents(descriptorPayload('tie a')))
    // An ordinary session fork shares parentSession but has no subagent origin.
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('plain-fork'))
    await ctx.sessions.flush(fork)
    const inspect = vi.spyOn(ctx.sessionPersistence, 'inspect')
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries.map(entry => entry.id)).toEqual([tieA, tieB, late])
    expect(entries.every(entry => entry.kind === 'child')).toBe(true)
    expect(inspect).not.toHaveBeenCalledWith(fork.id, expect.anything())
  })

  it('reports a live child as running while keeping settled siblings complete', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const settled = await startChild(ctx, parent, 'settled child')
    // A live child session outside persistence: publish a live session with a
    // descriptor and the parent lineage, without starting an Activation.
    const liveId = SessionId('live-child')
    const live = ctx.sessions.create(liveId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    live.append('turn/start', { turn: 1 })
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

  it('lists the last descriptor when a log carries more than one', async () => {
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
    const doubled = await authorChild(ctx, '00000000-0000-4000-8000-00000000dupe', {
      parentSession: parent.id,
      origin: 'subagent',
    }, events)
    // The last-wins projection fold serves the final descriptor's identity; a
    // repeated descriptor is not a per-child corruption diagnostic.
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({
      kind: 'child', id: doubled, label: 'twice again', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('maps a child rejected by persistence inspection to unavailable', async () => {
    const { ctx, parent } = await setup([])
    // The surface-eligible user/message lacks its required surfaceOp, so the
    // first-party inspection rejects before any projection fold can run.
    const invalid = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ee', {
      parentSession: parent.id,
      origin: 'subagent',
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
    expect(entries).toEqual([{ kind: 'diagnostic', id: invalid, reason: 'unavailable' }])
  })

  it('diagnoses a malformed descriptor payload as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const malformed = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ff', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents({ version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 }))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: malformed, reason: 'corrupt' }])
  })

  it('diagnoses an unknown descriptor version as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const future = await authorChild(ctx, '00000000-0000-4000-8000-0000000000aa', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('from the future', SUBAGENT_DESCRIPTOR_VERSION + 1)))
    // The projection fold does not distinguish an unrecognized version from
    // other invalid descriptors: both serve no identity, and a settled
    // no-value candidate is corrupt.
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: future, reason: 'corrupt' }])
  })

  it('lists a fork whose seed replays an ancestor descriptor under that identity', async () => {
    const { ctx, parent } = await setup([])
    // The last-wins fold serves a seed-replayed ancestor descriptor until the
    // child's own descriptor overrides it (known deviation #1 in the design).
    const seed = childEvents(descriptorPayload('ancestor label'))
    const forkChild = await authorChild(ctx, '00000000-0000-4000-8000-0000000000f0', {
      parentSession: parent.id,
      seedLength: seed.length,
      origin: 'subagent',
    }, seed)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: forkChild, label: 'ancestor label', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('does not filter by provider availability: children of unmounted providers stay listed', async () => {
    const { ctx, parent } = await setup([])
    const foreign = await authorChild(ctx, '00000000-0000-4000-8000-0000000000bb', {
      parentSession: parent.id,
      origin: 'subagent',
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

  it('maps a failed cold inspection to one unavailable diagnostic and retries it next listing', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const flaky = await authorChild(ctx, '00000000-0000-4000-8000-00000000f1a7', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('flaky storage')))
    const original = ctx.sessionPersistence.inspect.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.inspect = (sessionId, signal) => {
      if (sessionId === flaky) {
        return Promise.reject(new Error('backend read failed'))
      }
      return original(sessionId, signal)
    }
    // Per-child isolation: the failed child degrades to one diagnostic while
    // the healthy sibling stays complete.
    const degraded = await ctx.subagents.listChildren(parent.id)
    expect(degraded).toContainEqual({ kind: 'diagnostic', id: flaky, reason: 'unavailable' })
    expect(degraded).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    // Nothing is memoized: with the backend healthy again, the next listing
    // folds the same child to its identity.
    ctx.sessionPersistence.inspect = original
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toContainEqual({
      kind: 'child', id: flaky, label: 'flaky storage', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('lists compacted and uncompacted children identically', async () => {
    const { ctx, parent } = await setup([])
    const plain = await authorChild(ctx, '00000000-0000-4000-8000-00000000c0de', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
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
      origin: 'subagent',
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

  it('reports an origin-classified grandchild without inspecting it', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    const grandchildId = await authorChild(ctx, '00000000-0000-4000-8000-0000000000cc', {
      parentSession: childId,
      origin: 'subagent',
    }, childEvents(descriptorPayload('grandchild')))
    const inspected: SessionId[] = []
    const original = ctx.sessionPersistence.inspect.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.inspect = (sessionId, signal) => {
      inspected.push(sessionId)
      return original(sessionId, signal)
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
        activity: 'inactive', hasChildren: true,
      },
    ])
    // The grandchild contributes only its header to the hasChildren hint.
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

  it('a pre-aborted signal stops before any persistence read', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    controller.abort()
    ctx.sessionPersistence.list = () => Promise.reject(new Error('must not be called'))
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('forwards cancellation to the persisted listing and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.list = (signal) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('backend listing aborted'))
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

  it('forwards cancellation to a cold inspection and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce11', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cancelled cold read')))
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.inspect = (_sessionId, signal) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('backend read aborted'))
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

  it('an abort observed after a cold inspection resolves cannot become a successful result', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce12', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cancelled mid-listing')))
    const controller = new AbortController()
    const original = ctx.sessionPersistence.inspect.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.inspect = async (sessionId, signal) => {
      const result = await original(sessionId, signal)
      controller.abort()
      return result
    }
    // The post-read checkpoint throws the stable subagent error instead of
    // interpreting the fully-read log as a successful listing.
    await expect(ctx.subagents.listChildren(parent.id, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'CANCELLED' }) as Error)
  })

  it('a cold inspection failure during an abort cannot become an unavailable diagnostic', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce13', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('aborted behind a failure')))
    const controller = new AbortController()
    ctx.sessionPersistence.inspect = () => {
      // The read fails while the caller aborts: cancellation normalization
      // must fail the listing rather than return a one-diagnostic success.
      controller.abort()
      return Promise.reject(new Error('backend read failed'))
    }
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
    const { ctx, parent } = await setup([], { sessionProjections: false })
    const caught: unknown = await ctx.subagents.listChildren(parent.id).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(SubagentError)
    expect((caught as SubagentError).code).toBe('SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')
  })
})
