import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { depthOf, SubagentDepthError, startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Drives the shared in-process run driver DIRECTLY (no provider package), so the
 * driver's own contract — depth read/cap, the one-shot drive, the result read —
 * is covered independently of which backend (spawn/fork) calls it. The only
 * mocked boundary is the model; the real agent loop, SubagentService, and
 * dsh-invariants are mounted, so a malformed child session log fails the test.
 */
async function setup(script: Script) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
  return { ctx, parent }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('depthOf', () => {
  it('reads 0 for an agent with no subagentDepth, the set value otherwise', async () => {
    const { parent } = await setup([])
    expect(depthOf(parent)).toBe(0)
    const withDepth = { options: { subagentDepth: 3 } } as unknown as Agent
    expect(depthOf(withDepth)).toBe(3)
  })
})

describe('startInProcessRun', () => {
  it('drives a fresh child (no seed) to completion and returns its output', async () => {
    const { ctx, parent } = await setup([textResponse('driver child answer')])
    const run = startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'do X' }], parent }, { providerName: 'spawn' })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver child answer')
    expect(depthOf(ctx.agents.get(run.id)!)).toBe(1)
    await run.dispose()
  })

  it('throws SubagentDepthError when the child would exceed maxDepth', async () => {
    const { ctx, parent } = await setup([])
    expect(() => startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'p' }], parent, maxDepth: 0 }, { providerName: 'spawn' }))
      .toThrow(SubagentDepthError)
  })

  it('seeds the child session when a seed is supplied', async () => {
    // Drive the parent through one real turn, then seed the child with that
    // completed-turn prefix — the child must SEE the parent's history but its
    // result is scoped to its OWN events (not the seeded parent message).
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('seeded child reply')])
    parent.send([{ type: 'text', text: 'parent q' }])
    await parent.whenIdle()
    const seed = parent.session.events.slice()
    const run = startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'child q' }], parent }, { providerName: 'fork', seed })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('seeded child reply')
    const child = ctx.agents.get(run.id)!
    // The child inherited the parent's prefix.
    expect(child.session.events.slice(0, seed.length).some(e => e.type === 'user/message')).toBe(true)
    await run.dispose()
  })
})
