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
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionPersistenceJsonl, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root }
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('the session-persistence RFC: AgentLoop factory create/resume', () => {
  it('createAgent uses the caller-supplied sessionId (not ${id}-session)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('custom-session'), meta: { cwd: '/w' } })
    expect(agent.session.id).toBe('custom-session')
    expect(agent.session.header.cwd).toBe('/w')
    await ctx.fiber.dispose()
  })

  it('createAgent rejects a duplicate agent id BEFORE creating the session (no orphan)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    ctx.agents.create({ agentId: AgentId('dup'), sessionId: SessionId('sess-a') })
    // A second create with the SAME agent id but a fresh session id must reject
    // up front — and must NOT leave an orphaned 'sess-b' session behind.
    expect(() => ctx.agents.create({ agentId: AgentId('dup'), sessionId: SessionId('sess-b') })).toThrow(/already registered/)
    expect(ctx.sessions.get(SessionId('sess-b'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('createAgent works without meta (no cwd)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = ctx.agents.create({ agentId: AgentId('a-nometa'), sessionId: SessionId('nometa-session') })
    expect(agent.session.id).toBe('nometa-session')
    expect(agent.session.header.cwd).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume of a session with no cwd carries an undefined cwd header', async () => {
    // Lifecycle 1: create a no-cwd session and run a turn.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = ctx1.agents.create({ agentId: AgentId('m'), sessionId: SessionId('nocwd-sess') }).agent as ReactLoopAgent
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
    const a2 = (await ctx2.agents.resume({ agentId: AgentId('m'), resumeSessionId: SessionId('nocwd-sess') })).agent as ReactLoopAgent
    expect(a2.session.header.cwd).toBeUndefined()
    await ctx2.fiber.dispose()
  })

  it('agent/session-start fires "startup" for createAgent and "resume" for resume()', async () => {
    // Lifecycle 1: a fresh createAgent emits session-start with source 'startup'.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const sources1: string[] = []
    ctx1.on('agent/session-start', (_agent, source) => void sources1.push(source))
    const a1 = ctx1.agents.create({ agentId: AgentId('s'), sessionId: SessionId('start-sess') }).agent as ReactLoopAgent
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
    await ctx2.agents.resume({ agentId: AgentId('s'), resumeSessionId: SessionId('start-sess') })
    expect(sources2).toEqual(['resume'])
    await ctx2.fiber.dispose()
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
    const a2 = (await ctx2.agents.resume({ agentId: AgentId('m'), resumeSessionId: SessionId('forked-sess') })).agent as ReactLoopAgent
    expect(a2.session.header.parentSession).toBe('parent-sess')
    expect(a2.session.header.cwd).toBe('/w')
    expect(a2.session.header.seedLength).toBe(seed.length)
    await ctx2.fiber.dispose()
  })

  it('an idle inject() is flushed durably on its own (survives without explicit flush/dispose)', async () => {
    // Lifecycle 1: run a turn, then inject context while idle. The idle inject
    // wraps its context/message in a one-shot turn AND checkpoints it (the turn-enclosure RFC)
    // — without an explicit flush or clean dispose, the notice must still reach
    // disk, since a crash before the next turn would otherwise lose it.
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = ctx1.agents.create({ agentId: AgentId('m'), sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } }).agent as ReactLoopAgent
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
    // Lifecycle 1: run a turn, then inject context while idle. The idle inject
    // wraps its context/message in a one-shot turn so it is turn-enclosed —
    // otherwise scanLog would treat the trailing context as a crash tail and
    // drop it on reload (the bug this guards).
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = ctx1.agents.create({ agentId: AgentId('m'), sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } }).agent as ReactLoopAgent
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
    const a2 = (await ctx2.agents.resume({ agentId: AgentId('m'), resumeSessionId: SessionId('inject-sess') })).agent as ReactLoopAgent
    const flat = JSON.stringify(a2.session.deriveMessages())
    expect(flat).toContain('background task 42 finished')
    await ctx2.fiber.dispose()
  })

  it('resume reloads a persisted session: history + turn numbering continue, no duplicate seqs', async () => {
    // Lifecycle 1: run one full turn, persisting it.
    const adapter1 = new MockAdapter([textResponse('first answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = ctx1.agents.create({ agentId: AgentId('main'), sessionId: SessionId('sess-resume'), meta: { cwd: '/w' } }).agent as ReactLoopAgent
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

    const a2 = (await ctx2.agents.resume({ agentId: AgentId('main'), resumeSessionId: SessionId('sess-resume') })).agent as ReactLoopAgent
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
    await expect(ctx.agents.resume({ agentId: AgentId('m'), resumeSessionId: SessionId('nope') }))
      .rejects.toThrow(/session persistence is not configured/)
    await ctx.fiber.dispose()
  })
})
