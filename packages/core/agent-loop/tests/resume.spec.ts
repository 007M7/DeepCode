import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-'))
  dirs.push(root)
  return { ctx: await mountPersistentHarness(root, adapter), root }
}

async function mountPersistentHarness(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionPersistenceJsonl, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function persistSession(sessionId: SessionId): Promise<string> {
  const { ctx, root } = await persistentHarness(new MockAdapter([textResponse('seed')]))
  // Persistence deliberately has no artifact for a truly empty session. A
  // balanced completed turn is the smallest resumable log and avoids running
  // the model merely to construct this lifecycle fixture.
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = ctx.sessions.create(sessionId, { seed })
  await ctx.sessions.flush(session)
  await ctx.fiber.dispose()
  return root
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Fail a lifecycle regression promptly instead of waiting for Vitest's suite timeout. */
async function promptly<T>(task: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => { timeout.reject(new Error('lifecycle task did not settle promptly')) }, 1000)
  try {
    return await Promise.race([task, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Throw an arbitrary callback value to exercise the public unknown-error boundary. */
function throwUnknown(value: unknown): never {
  throw value
}

describe('the session-persistence RFC: AgentLoop factory create/resume', () => {
  it('normalizes a non-Error resume publication failure for rollback and rethrows it', async () => {
    const sessionId = SessionId('unknown-resume-failure-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const failure = { source: 'resume' }
    ctx.on('session/created', () => throwUnknown(failure))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
    })).rejects.toBe(failure)

    expect(ctx.agents.get(SessionId('unknown-resume-failure'))).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('createAgent uses the caller-supplied sessionId (not ${id}-session)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('custom-session'), meta: { cwd: '/w' } })
    expect(agent.session.id).toBe('custom-session')
    expect(agent.session.header.cwd).toBe('/w')
    await ctx.fiber.dispose()
  })

  it('createAgent rejects a duplicate identity without orphaning a session', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('sess-a')
    await ctx.agents.create({ sessionId })
    await expect(ctx.agents.create({ sessionId })).rejects.toThrow(/already exists/)
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('createAgent works without meta (no cwd)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('nometa-session') })
    expect(agent.session.id).toBe('nometa-session')
    expect(agent.session.header.cwd).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume of a session with no cwd carries an undefined cwd header', async () => {
    // Lifecycle 1: create a no-cwd session and run a turn.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('nocwd-sess') })).agent
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the header cwd stays undefined (no-cwd branch).
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('nocwd-sess') })).agent
    expect(a2.session.header.cwd).toBeUndefined()
    await ctx2.fiber.dispose()
  })

  it('agent/session-start fires "startup" for createAgent and "resume" for resume()', async () => {
    // Lifecycle 1: a fresh createAgent emits session-start with source 'startup'.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const sources1: string[] = []
    ctx1.on('agent/session-start', (_agent, source) => void sources1.push(source))
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('start-sess') })).agent
    expect(sources1).toEqual(['startup'])
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resuming the persisted session emits session-start 'resume'.
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const sources2: string[] = []
    ctx2.on('agent/session-start', (_agent, source) => void sources2.push(source))
    await ctx2.agents.resume({ resumeSessionId: SessionId('start-sess') })
    expect(sources2).toEqual(['resume'])
    await ctx2.fiber.dispose()
  })

  it('resume awaits setup while unpublished, then publishes a fully composed world in order', async () => {
    const sessionId = SessionId('resume-setup-success')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const order: string[] = []

    ctx.on('session/created', (session) => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(sessionId)?.session).toBe(session)
      order.push('session/created')
    })
    ctx.on('agent/created', (agent) => {
      expect(agent.status).toBe('idle')
      order.push('agent/created')
    })
    ctx.on('agent/session-start', (agent) => {
      expect(() => { agent.cancel('now live') }).not.toThrow()
      order.push('agent/session-start')
    })

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => {
        expect(agentCtx.agent?.id).toBe(sessionId)
        expect(agentCtx.agent?.session.events).toHaveLength(2)
        agentCtx.on('session/created', () => void order.push('setup-listener:session/created'))
        agentCtx.on('agent/created', () => void order.push('setup-listener:agent/created'))
        order.push('setup:start')
        setupStarted.resolve(undefined)
        await gate.promise
        order.push('setup:end')
      },
    })

    await setupStarted.promise
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(order).toEqual(['setup:start'])

    gate.resolve(undefined)
    const handle = await resuming
    expect(order).toEqual([
      'setup:start',
      'setup:end',
      'session/created',
      'setup-listener:session/created',
      'agent/created',
      'setup-listener:agent/created',
      'agent/session-start',
    ])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('successful resume disposal retires its caller-owned transaction effects', async () => {
    const sessionId = SessionId('resume-retired-effects-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const transactionLabels = [
      `agentLoop.owner(${sessionId})`,
      `agentLoop.lifecycle(${sessionId})`,
    ]

    expect(ctx.fiber.getEffects().map(effect => effect.label)).toEqual(expect.arrayContaining(transactionLabels))
    await handle.dispose()
    expect(ctx.fiber.getEffects().filter(effect => transactionLabels.includes(effect.label))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resume setup rejection publishes nothing, unwinds, and releases the identity', async () => {
    const sessionId = SessionId('resume-setup-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {
        await Promise.resolve()
        throw new Error('resume setup failed')
      },
    })).rejects.toThrow('resume setup failed')

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('owner unload aborts resume setup and cannot publish after the callback settles', async () => {
    const sessionId = SessionId('resume-setup-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async () => {
          setupStarted.resolve(undefined)
          await gate.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted.promise

    await owner.dispose()
    await expect(resuming).rejects.toThrow(/owner disposed during setup/)
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    gate.resolve(undefined)
    await Promise.resolve()
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('owner unload aborts a never-settling persistence load, releases the identity, and blocks late publication', async () => {
    const sessionId = SessionId('resume-load-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const snapshot = await ctx.sessionPersistence.load(sessionId)
    const lateLoad = Promise.withResolvers<typeof snapshot>()
    const loadStarted = Promise.withResolvers<undefined>()
    let loads = 0
    ctx.sessionPersistence.load = (id) => {
      expect(id).toBe(sessionId)
      loads += 1
      if (loads === 1) {
        loadStarted.resolve(undefined)
        return lateLoad.promise
      }
      return Promise.resolve(structuredClone(snapshot))
    }

    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    }, { inject: ['agents'] }))
    await loadStarted.promise

    const rejection = expect(promptly(resuming)).rejects.toThrow(/owner disposed during setup/)
    await promptly(owner.dispose())
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    // owner.dispose() awaited transaction settlement, so the same identities
    // can be reused before awaiting the public rejection.
    const retry = await promptly(ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
    await rejection
    expect(loads).toBe(2)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    // Settlement of the abandoned backend promise cannot resume the old
    // transaction or emit a second publication after the retry owns the ids.
    lateLoad.resolve(structuredClone(snapshot))
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.agents.get(sessionId)).toBe(retry.agent)
    expect(ctx.sessions.get(sessionId)).toBe(retry.agent.session)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('AgentLoop unload aborts persistence load and awaits wrapper settlement', async () => {
    const sessionId = SessionId('resume-load-factory-unload')
    const root = await persistSession(sessionId)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionPersistenceJsonl, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('next')]))

    const snapshot = await ctx.sessionPersistence.load(sessionId)
    const lateLoad = Promise.withResolvers<typeof snapshot>()
    const loadStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.load = (id) => {
      expect(id).toBe(sessionId)
      loadStarted.resolve(undefined)
      return lateLoad.promise
    }
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const resuming = ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    await loadStarted.promise
    const rejection = expect(promptly(resuming)).rejects.toThrow(/agent loop is not active/)
    await promptly(loopFiber.dispose())
    await rejection

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    lateLoad.resolve(structuredClone(snapshot))
    await Promise.resolve()
    await Promise.resolve()
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resume of a forked session preserves the parentSession lineage and seed boundary in the header', async () => {
    // Lifecycle 1: persist a FORKED session (carries parentSession + seedLength
    // in its header) by creating it with a complete-turn seed — the write path
    // materializes the fork (header + seed) on disk.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const forked = ctx1.sessions.create(SessionId('forked-sess'), {
      seed,
      meta: { cwd: '/w', parentSession: SessionId('parent-sess'), seedLength: seed.length },
    })
    await ctx1.parallel('session/flush', forked)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the parentSession + seedLength header survives the
    // round-trip (exercises resume's parentSession- and seedLength-present
    // branches). seedLength must come from the PERSISTED header, not from the
    // resume seed length (which is the whole stored log, not the original
    // boundary).
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('forked-sess') })).agent
    expect(a2.session.header.parentSession).toBe('parent-sess')
    expect(a2.session.header.cwd).toBe('/w')
    expect(a2.session.header.seedLength).toBe(seed.length)
    await ctx2.fiber.dispose()
  })

  it('an idle inject() is flushed durably on its own (survives without explicit flush/dispose)', async () => {
    // Idle injection creates and flushes a one-shot turn. No explicit flush or
    // clean disposal follows, so disk presence proves its own checkpoint ran.
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } })).agent
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    a1.inject([{ type: 'text', text: 'background task 42 finished' }], { source: { kind: 'plugin', plugin: 'tool-bash' } })
    // Let inject()'s fire-and-forget flush settle (NO explicit flush/dispose).
    await new Promise(r => setTimeout(r, 30))

    // A SEPARATE backend reads the on-disk log — proving the inject persisted
    // itself, not a later dispose drain.
    const probe = new Context()
    await probe.plugin(SessionStore)
    await probe.plugin(SessionPersistenceJsonl, { root })
    const loaded = await probe.sessionPersistence.load(SessionId('inject-sess'))
    expect(JSON.stringify(loaded.events)).toContain('background task 42 finished')
    await probe.fiber.dispose()
    await ctx1.fiber.dispose()
  })

  it('an idle inject() survives persist + resume (turn-enclosed, not dropped as crash tail)', async () => {
    // Turn enclosure keeps idle context out of crash-tail repair, so it must
    // survive persistence and resume.
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } })).agent
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    a1.inject([{ type: 'text', text: 'background task 42 finished' }], { source: { kind: 'plugin', plugin: 'tool-bash' } })
    await ctx1.parallel('session/flush', a1.session)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume; the injected context is still in the derived history.
    const adapter2 = new MockAdapter([textResponse('next')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('inject-sess') })).agent
    const flat = JSON.stringify(a2.session.deriveMessages())
    expect(flat).toContain('background task 42 finished')
    await ctx2.fiber.dispose()
  })

  it('resume reloads a persisted session: history + turn numbering continue, no duplicate seqs', async () => {
    // Lifecycle 1: run one full turn, persisting it.
    const adapter1 = new MockAdapter([textResponse('first answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('sess-resume'), meta: { cwd: '/w' } })).agent
    a1.send([{ type: 'text', text: 'first question' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    const events1 = [...a1.session.events]
    const seqs1 = events1.map(e => e.seq)
    expect(seqs1).toEqual([...seqs1].sort((x, y) => x - y)) // contiguous
    await ctx1.fiber.dispose()

    // Lifecycle 2: a brand-new context over the SAME root; resume the session.
    const adapter2 = new MockAdapter([textResponse('second answer')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)

    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('sess-resume') })).agent
    // The resumed session carries the prior history…
    expect(a2.session.id).toBe('sess-resume')
    expect(a2.session.events.length).toBe(events1.length)
    const replay = new Session(SessionId('replay'), events1)
    expect(a2.session.deriveMessages()).toEqual(replay.deriveMessages())

    // …and a new turn continues numbering (turn 2) with contiguous seqs.
    a2.send([{ type: 'text', text: 'second question' }], { source: { kind: 'user' } })
    await waitForIdle(ctx2, a2)
    const allSeqs = a2.session.events.map(e => e.seq)
    expect(allSeqs).toEqual(allSeqs.map((_, i) => i)) // 0..N contiguous, no duplicates
    const turnStarts = a2.session.events.filter(e => e.type === 'turn/start')
    expect(turnStarts.map(e => e.type === 'turn/start' && e.data.turn)).toEqual([1, 2])
    await ctx2.fiber.dispose()
  })

  it('resume rejects when session persistence is not configured', async () => {
    // A harness WITHOUT the persistence plugin.
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('nope') }))
      .rejects.toThrow(/session persistence is not configured/)
    await ctx.fiber.dispose()
  })
})
