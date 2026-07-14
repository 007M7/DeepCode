import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function makeCoreContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('config-driven session id', () => {
  it('accepts one exact fresh id and rejects it alongside a resume id', async () => {
    const exact = await makeCoreContext()
    await exact.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('stdio-exact'), model: 'mock' }],
    })
    expect(exact.agents.get(SessionId('stdio-exact'))?.session.id).toBe('stdio-exact')
    await exact.fiber.dispose()

    const conflicting = await makeCoreContext()
    await expect(conflicting.plugin(AgentLoop, {
      agents: [{
        id: 'main',
        sessionId: SessionId('fresh'),
        resumeSessionId: SessionId('persisted'),
        model: 'mock',
      }],
    })).rejects.toThrow('sessionId and resumeSessionId are mutually exclusive')
    await conflicting.fiber.dispose()
  })

  it('restores a materialized exact id across an AgentLoop-only reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-reload-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(SessionPersistenceJsonl, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))
    const config = { agents: [{ id: 'main', sessionId: SessionId('stdio-exact-reload'), model: 'mock' }] }

    const firstLoop = await ctx.plugin(AgentLoop, config)
    let first: Agent | undefined
    for (let i = 0; i < 50 && first === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      first = ctx.agents.get(SessionId('stdio-exact-reload'))
    }
    expect(first).toBeDefined()
    first!.send([{ type: 'text', text: 'remember me' }], { source: { kind: 'user' } })
    await waitForIdle(ctx, first!)
    await firstLoop.dispose()

    const secondLoop = await ctx.plugin(AgentLoop, config)
    let second: Agent | undefined
    for (let i = 0; i < 50 && second === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      second = ctx.agents.get(SessionId('stdio-exact-reload'))
    }
    expect(second).toBeDefined()
    expect(JSON.stringify(second!.session.deriveMessages())).toContain('remember me')
    second!.send([{ type: 'text', text: 'continue' }], { source: { kind: 'user' } })
    await waitForIdle(ctx, second!)
    await ctx.sessions.flush(second!.session)
    const loaded = await ctx.sessionPersistence.load(SessionId('stdio-exact-reload'))
    expect(loaded.events.filter(event => event.type === 'turn/start')).toHaveLength(2)

    await secondLoop.dispose()
    await ctx.fiber.dispose()
  })

  it('contains an exact-id persistence lookup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-failure-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const failure = new Error('persistence index failed')
    const listenerFailure = new Error('failure observer failed')
    const asyncListenerFailure = new Error('async failure observer failed')
    const failures: { sessionId: SessionId; error: unknown }[] = []
    ctx.on('agent-loop/config-start-failed', () => { throw listenerFailure })
    ctx.on('agent-loop/config-start-failed', () => Promise.reject(asyncListenerFailure) as never)
    ctx.on('agent-loop/config-start-failed', (sessionId, error) => {
      failures.push({ sessionId, error })
    })
    vi.spyOn(ctx.sessionPersistence, 'list').mockRejectedValue(failure)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('stdio-exact-failure'), model: 'mock' }],
    })

    await expect.poll(() => warn).toHaveBeenCalledWith(expect.stringContaining(
      'config-driven restore of "stdio-exact-failure" failed: Error: persistence index failed',
    ))
    expect(failures).toEqual([{ sessionId: SessionId('stdio-exact-failure'), error: failure }])
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener threw: Error: failure observer failed',
    )
    await expect.poll(() => warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener rejected: Error: async failure observer failed',
    )
    expect(ctx.agents.get(SessionId('stdio-exact-failure'))).toBeUndefined()
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

  it('contains startup and observer failures whose string coercion throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-unrenderable-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const unrenderable = {
      [Symbol.toPrimitive](): never {
        throw new Error('coercion escaped')
      },
    }
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', () => { throw unrenderable })
    // Deliberately violate the normal Error-only rejection rule to exercise the unknown boundary.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    ctx.on('agent-loop/config-start-failed', () => Promise.reject(unrenderable) as never)
    ctx.on('agent-loop/config-start-failed', (_sessionId, error) => { failures.push(error) })
    vi.spyOn(ctx.sessionPersistence, 'list').mockRejectedValue(unrenderable)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('stdio-exact-unrenderable'), model: 'mock' }],
    })

    await expect.poll(() => failures).toEqual([unrenderable])
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-driven restore of "stdio-exact-unrenderable" failed: <unrenderable thrown value>',
    )
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener threw: <unrenderable thrown value>',
    )
    await expect.poll(() => warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener rejected: <unrenderable thrown value>',
    )
    await ctx.fiber.dispose()
  })

  it('joins an exact-id persistence lookup before AgentLoop disposal completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-dispose-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const listing = Promise.withResolvers<Awaited<ReturnType<typeof ctx.sessionPersistence.list>>>()
    vi.spyOn(ctx.sessionPersistence, 'list').mockReturnValue(listing.promise)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const loop = await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('stdio-exact-dispose'), model: 'mock' }],
    })
    let disposed = false
    const disposal = loop.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    listing.resolve([])
    await disposal
    expect(ctx.agents.get(SessionId('stdio-exact-dispose'))).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

  it('identity-nests the deferred resume fiber under its labeled owner effect', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', model: 'mock', resumeSessionId: SessionId('deferred') }],
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
    await ctx1.plugin(AgentLoop, { agents: [{ id: 'cfg', model: 'mock' }] })
    await ctx1.plugin(SessionPersistenceJsonl, { root })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg')]))
    const a1 = ctx1.agents.list()[0] as Agent
    expect(a1.id).toBe(a1.session.id)
    expect(a1.session.id).toMatch(idPattern)
    expect(ctx1.agents.get(SessionId('cfg'))).toBeUndefined()
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
    await ctx2.plugin(AgentLoop, { agents: [{ id: 'cfg', model: 'mock' }] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg2')]))
    const a2 = ctx2.agents.list()[0] as Agent
    expect(a2.id).toBe(a2.session.id)
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
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('sticky-1') })).agent
    a1.send([{ type: 'text', text: 'remember me' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Run 2: a CONFIG agent with resumeSessionId continues that session. The
    // resume is deferred until sessionPersistence loads (ctx.inject), so wait
    // for the agent to appear, then assert it is on the resumed id with history.
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [{ id: 'main', model: 'mock', resumeSessionId: SessionId('sticky-1') }] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('second')]))

    // The deferred resume runs on a microtask after the backend is available.
    let resumed: Agent | undefined
    for (let i = 0; i < 50 && !resumed; i++) {
      await new Promise(r => setTimeout(r, 5))
      resumed = ctx2.agents.get(SessionId('sticky-1'))
    }
    expect(resumed).toBeDefined()
    // The live session id IS the resumed id (NOT a fresh ${id}-session-<uuid>),
    // and the prior turn's user message is in the derived history.
    expect(resumed!.id).toBe(SessionId('sticky-1'))
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
    await ctx.plugin(AgentLoop, { agents: [{ id: 'main', model: 'mock', resumeSessionId: SessionId('does-not-exist') }] })
    const warn = vi.spyOn((ctx.agentLoop as unknown as { ctx: { logger: { warn: (...a: unknown[]) => void } } }).ctx.logger, 'warn')
      .mockImplementation(() => undefined)
    await ctx.plugin(SessionPersistenceJsonl, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('x')]))

    // The deferred resume fails (no such session on disk). It must be contained:
    // a warning is logged, no agent is registered, and the app stays up.
    await new Promise(r => setTimeout(r, 200))
    expect(ctx.agents.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config-driven resume of "does-not-exist" failed'))
    warn.mockRestore()
    await ctx.fiber.dispose()
  })
})
