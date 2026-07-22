import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  installAgentLlmTarget,
  type Agent,
  type AgentLlmTargetRef,
} from '../src/index.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installAgentLlmTarget()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const target: AgentLlmTargetRef = { current: undefined, assembled: undefined }
    const dispose = installAgentLlmTarget(ctx, target)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 1, 0, seed, signal, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    target.current = { provider: 'alpha', model: 'a1' }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    target.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 1, 0, seed, signal, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'alpha', model: 'a1', temperature: 0.2 })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 1, 1, seed, signal, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 2, 0, seed, signal, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})
