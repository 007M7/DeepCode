import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import * as agentCore from '../src/index.ts'
import { AgentId } from '@deepseek-ai/dsh-agent'

/**
 * Unit coverage for the @deepseek-ai/dsh-agent-core bundle: mounting it brings
 * up the whole providerless spine in one `ctx.plugin`, and the forwarded
 * `agents` config reaches the loop (default `[]`, or a pre-created agent).
 *
 * The bundle is exercised through `ctx.plugin(agentCore, …)` — the NAMESPACE
 * import, the same shape the Loader builds from `unwrapExports`. The real
 * Loader-path guard (export shape, `unwrapExports`) is the app packages' keyless
 * bin smokes; here we assert the composition + config forwarding.
 */
async function mount(config?: agentCore.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(agentCore, config)
  // The bundle mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services and any pre-created agent are ready.
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

describe('dsh-agent-core bundle', () => {
  it('brings up the full providerless spine', async () => {
    const ctx = await mount()
    // One service from each layer of the spine proves the children loaded.
    expect(ctx.get('timer')).toBeDefined()
    expect(ctx.get('llm')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(ctx.get('systemPrompt')).toBeDefined()
    expect(ctx.get('tools')).toBeDefined()
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('defaults the agents list to empty (no pre-created agents)', async () => {
    const ctx = await mount()
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forwards a pre-created agent to the loop', async () => {
    const ctx = await mount({
      agents: [{ id: AgentId('main'), model: 'mock', systemPrompt: 'hi' }],
    })
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('re-exports the loop config schema as its own', () => {
    expect(agentCore.Config).toBeDefined()
    expect(agentCore.name).toBe('agent-core')
  })
})
