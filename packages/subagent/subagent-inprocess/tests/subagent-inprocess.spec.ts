import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function setup(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
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

  it('seeds a forked child but reads only the child-owned output', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.send([{ type: 'text', text: 'parent question' }])
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

  it('rejects invalid and exceeded depth before publication', async () => {
    const { parent } = await setup([])
    await expect(startInProcessRun({ ...request(parent), maxDepth: -1 }, {}))
      .rejects.toThrow('non-negative safe integer')
    await expect(startInProcessRun({ ...request(parent), maxDepth: 0 }, {}))
      .rejects.toMatchObject({ name: 'SubagentDepthError' })
    for (const value of [Number.NaN, 1.5, -1, -0, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = { options: { subagentDepth: value } } as unknown as Agent
      await expect(startInProcessRun(request(malformed), {}))
        .rejects.toThrow('agent subagentDepth must be a non-negative safe integer')
    }
    const maxParent = { options: { subagentDepth: Number.MAX_SAFE_INTEGER } } as unknown as Agent
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
    const { parent } = await setup(['hang', 'hang'])
    const controller = new AbortController()
    const signalled = await startInProcessRun(request(parent, controller.signal), {})
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort('stop child')
    await expect(signalled.result).resolves.toMatchObject({ stopReason: 'aborted' })
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
