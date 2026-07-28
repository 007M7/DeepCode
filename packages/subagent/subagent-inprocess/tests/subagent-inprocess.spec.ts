import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { maxTokensResponse, MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantService)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

async function setup(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function request(parent: Agent, signal = new AbortController().signal) {
  return { prompt: [{ type: 'text' as const, text: 'child task' }], parent, signal }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('startInProcessRun', () => {
  it('returns only after publication, drives a fresh child, and disposes it', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    const run = await startInProcessRun(request(parent), {})
    expect(ctx.agents.get(run.id)).toBeDefined()
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver answer')
    expect(ctx.agents.get(run.id)!.options.subagentDepth).toBe(1)
    await run.dispose()
    await run.dispose()
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('reports the message-turn outcome when a later non-message turn completes during flush', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('partial answer')])
    let injected = false
    ctx.on('session/flush', (session) => {
      if (injected || session.header.parentSession === undefined) return
      const lastEnd = session.events.findLast(event => event.type === 'turn/end')
      if (lastEnd?.type !== 'turn/end' || lastEnd.data.reason.kind !== 'max-tokens') return
      injected = true
      const turn = lastEnd.data.turn + 1
      session.append('turn/start', {
        turn,
        trigger: { kind: 'injection', source: { kind: 'plugin', plugin: 'late-metadata' } },
      })
      session.append('user/message', {
        content: [{ type: 'text', text: 'late metadata' }],
        source: { kind: 'plugin', plugin: 'late-metadata' },
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    })

    const run = await startInProcessRun(request(parent), {})
    const result = await run.result
    const child = ctx.agents.get(run.id)!

    expect(injected).toBe(true)
    expect(child.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('seeds a forked child but reads only the child-owned output', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } })
    await parent.whenIdle()
    const seed = parent.session.events.slice()
    const run = await startInProcessRun(request(parent), { seed })
    const result = await run.result
    expect(text(result.output)).toBe('child answer')
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.seedLength).toBe(seed.length)
    expect(child.session.events.slice(0, seed.length)).toEqual(seed)
    await run.dispose()
  })

  it('persists the child depth in its session header', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    const run = await startInProcessRun(request(parent), {})
    await run.result
    // The recursion budget is durable session data, not only runtime options —
    // a depth that lived only in AgentOptions would reset to 0 on resume.
    expect(ctx.agents.get(run.id)!.session.header.delegationDepth).toBe(1)
    await run.dispose()
  })

  it('counts a RESUMED child by its persisted header depth, not the absent runtime depth', async () => {
    // Resume rebuilds runtime options, so the durable header must keep this
    // depth-1 child from delegating as though it were top-level.
    const { ctx } = await setup([textResponse('unused')])
    const resumed = (await ctx.agents.create({
      sessionId: SessionId('resumed-child'),
      meta: { parentSession: SessionId('root'), delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    })).agent
    await expect(startInProcessRun({ ...request(resumed), maxDepth: 1 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 2, maxDepth: 1 })
  })

  it('lets runtime options deepen but never lower the persisted depth', async () => {
    const { ctx } = await setup([textResponse('unused')])
    const parent = (await ctx.agents.create({
      sessionId: SessionId('deep-parent'),
      meta: { delegationDepth: 2 },
      agentOptions: { provider: 'mock', model: 'mock', subagentDepth: 1 },
      signal: new AbortController().signal,
    })).agent
    // Persisted 2 vs runtime 1: the child is depth 3, so maxDepth 2 rejects.
    await expect(startInProcessRun({ ...request(parent), maxDepth: 2 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError', attemptedDepth: 3, maxDepth: 2 })
  })

  it('rejects invalid and exceeded depth before publication', async () => {
    const { parent } = await setup([])
    await expect(startInProcessRun({ ...request(parent), maxDepth: -1 }, {}))
      .rejects.toThrow('non-negative safe integer')
    await expect(startInProcessRun({ ...request(parent), maxDepth: 0 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError' })
    for (const value of [Number.NaN, 1.5, -1, -0, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = { options: { subagentDepth: value }, session: { header: {} } } as unknown as Agent
      await expect(startInProcessRun(request(malformed), {}))
        .rejects.toThrow('agent subagentDepth must be a non-negative safe integer')
    }
    const maxParent = { options: { subagentDepth: Number.MAX_SAFE_INTEGER }, session: { header: {} } } as unknown as Agent
    await expect(startInProcessRun(request(maxParent), {})).rejects.toBeInstanceOf(RangeError)
  })

  it('rejects an already-aborted request without publishing a child', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const controller = new AbortController()
    controller.abort('too late')
    await expect(startInProcessRun(request(parent, controller.signal), {}))
      .rejects.toThrow('aborted before child publication')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('uses the request signal after publication and dispose as cancellation paths', async () => {
    const { parent, adapter } = await setup(['hang', 'hang'])
    const controller = new AbortController()
    const signalled = await startInProcessRun(request(parent, controller.signal), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort('stop child')
    await expect(signalled.result).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(adapter.requests[0]?.signal?.reason).toEqual({ kind: 'parent' })
    const child = parent.ctx.agents.get(signalled.id)
    const turnEnd = child?.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted' })
    await signalled.dispose()

    const disposed = await startInProcessRun(request(parent), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    await disposed.dispose()
    await expect(disposed.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('cleans a failed unpublished setup before rejecting', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    await expect(startInProcessRun({
      ...request(parent),
      toolFilter: { deny: ['unknown-tool'] },
    }, {})).rejects.toThrow('unknown global tool')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('closes the abort handoff after the factory detaches its creation listener', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const parentWithAbortAtHandoff = {
      options: parent.options,
      session: parent.session,
      ctx: {
        agents: {
          create: async (options: Parameters<typeof ctx.agents.create>[0]) => {
            const handle = await ctx.agents.create(options)
            // `create()` has detached its creation-only listener, but the
            // provider continuation has not installed its live-run listener.
            controller.abort('handoff race')
            return handle
          },
        },
      },
    } as unknown as Agent
    await expect(startInProcessRun(request(parentWithAbortAtHandoff, controller.signal), {}))
      .rejects.toThrow('aborted before child publication')
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })
})
