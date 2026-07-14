import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('config-driven session id', () => {
  it('identity-nests the deferred resume fiber under its labeled owner effect', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, {
      agents: [{ id: AgentId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('deferred') }],
    })

    const resumeEffect = loopFiber.getEffects().find(effect => effect.label === 'agentLoop.resume(main)')
    expect(resumeEffect?.children.map(child => child.label)).toEqual(['ctx.plugin()'])
    expect(loopFiber.getEffects().filter(effect => effect.label === 'ctx.plugin()')).toEqual([])

    await loopFiber.dispose()
  })

  it('config-driven create uses a fresh ${id}-session-<uuid> per run (restart-safe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-session-'))
    dirs.push(root)
    const idPattern = /^cfg-session-[0-9a-f-]{36}$/
    // Run 1: a config agent persists a turn under a generated session id.
    const ctx1 = new Context()
    await ctx1.plugin(LlmService)
    await ctx1.plugin(SessionStore)
    await ctx1.plugin(SystemPrompt)
    await ctx1.plugin(ToolRegistry)
    await ctx1.plugin(AgentRegistry)
    await ctx1.plugin(AgentLoop, { agents: [{ id: AgentId('cfg'), provider: 'mock', model: 'mock' }] })
    await ctx1.plugin(SessionPersistenceJsonl, { root })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg')]))
    const a1 = ctx1.agents.get(AgentId('cfg')) as ReactLoopAgent
    expect(a1.session.id).toMatch(idPattern)
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Run 2 over the SAME root: a fresh id means no on-disk collision (a fixed
    // ${id}-session would crash here with "already has a persisted log").
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [{ id: AgentId('cfg'), provider: 'mock', model: 'mock' }] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg2')]))
    const a2 = ctx2.agents.get(AgentId('cfg')) as ReactLoopAgent
    expect(a2.session.id).toMatch(idPattern)
    expect(a2.session.id).not.toBe(a1.session.id)
    a2.send([{ type: 'text', text: 'q2' }], { source: { kind: 'user' } })
    await waitForIdle(ctx2, a2)
    await ctx2.fiber.dispose()
  })

  it('config-driven resumeSessionId continues a persisted session (env-var resume)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-resume-'))
    dirs.push(root)

    // Run 1: a programmatically-created agent on a KNOWN session id persists a
    // completed turn, so run 2 has a concrete id to resume.
    const ctx1 = new Context()
    await ctx1.plugin(LlmService)
    await ctx1.plugin(SessionStore)
    await ctx1.plugin(SystemPrompt)
    await ctx1.plugin(ToolRegistry)
    await ctx1.plugin(AgentRegistry)
    await ctx1.plugin(AgentLoop, { agents: [] })
    await ctx1.plugin(SessionPersistenceJsonl, { root })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first')]))
    const a1 = (await ctx1.agents.create({ agentId: AgentId('main'), sessionId: SessionId('sticky-1') })).agent as ReactLoopAgent
    a1.send([{ type: 'text', text: 'remember me' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Resume waits for the injected persistence service, so poll until the
    // config-created agent appears with its stored history.
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [{ id: AgentId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('sticky-1') }] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('second')]))

    // The deferred resume runs on a microtask after the backend is available.
    let resumed: ReactLoopAgent | undefined
    for (let i = 0; i < 50 && !resumed; i++) {
      await new Promise(r => setTimeout(r, 5))
      resumed = ctx2.agents.get(AgentId('main')) as ReactLoopAgent | undefined
    }
    expect(resumed).toBeDefined()
    // The live session id IS the resumed id (NOT a fresh ${id}-session-<uuid>),
    // and the prior turn's user message is in the derived history.
    expect(resumed!.session.id).toBe('sticky-1')
    const derived = resumed!.session.deriveMessages()
    expect(JSON.stringify(derived)).toContain('remember me')
    await ctx2.fiber.dispose()
  })

  it('config-driven resume of a missing session is contained: logs a warning, no agent, no crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-resume-miss-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [{ id: AgentId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('does-not-exist') }] })
    const warn = vi.spyOn((ctx.agentLoop as unknown as { ctx: { logger: { warn: (...a: unknown[]) => void } } }).ctx.logger, 'warn')
      .mockImplementation(() => undefined)
    await ctx.plugin(SessionPersistenceJsonl, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('x')]))

    // The deferred resume fails (no such session on disk). It must be contained:
    // a warning is logged, no 'main' agent is registered, and the app stays up.
    await new Promise(r => setTimeout(r, 200))
    expect(ctx.agents.get(AgentId('main'))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config-driven resume of "does-not-exist" failed'))
    warn.mockRestore()
    await ctx.fiber.dispose()
  })
})
