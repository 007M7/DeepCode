import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import * as acpAgent from '../src/index.ts'

/**
 * In-process unit coverage for the @deepseek-ai/dsh-acp-agent composition:
 * mounting it brings up the agent-core spine + JSONL persistence + the ACP
 * bridge in one `ctx.plugin`. Unlike the stdio app, this one loads NO
 * Loader-only plugin (no hmr), so it mounts in a plain Context.
 *
 * The REAL Loader-path guard (export shape via `unwrapExports`, the headline
 * ACP operations end-to-end) is the keyless bin smoke in `load-path.e2e.ts`;
 * this spec asserts the composition and the persistenceRoot default branch.
 */
async function mount(config: acpAgent.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(acpAgent, config)
  // The bundle mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services are ready.
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

describe('dsh-acp-agent composition', () => {
  it('brings up the spine + persistence + the ACP bridge', async () => {
    const ctx = await mount({ model: 'mock', systemPrompt: 'hi', persistenceRoot: '/tmp/dsh-acp-agent-test' })
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    // No pre-created agents — ACP session/new creates them on demand.
    expect(ctx.get('agents')!.list()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('defaults the persistence root when omitted', async () => {
    // Exercises the `?? './.sessions'` fallback for a direct-apply caller that
    // bypasses the schema's `.default(...)`: call `apply` directly (not via
    // `ctx.plugin`, which validates+defaults the config first) with no
    // persistenceRoot, so the runtime fallback is the one that fires.
    const ctx = new Context()
    acpAgent.apply(ctx, { model: 'mock', systemPrompt: 'hi' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.get('sessionPersistence')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('exposes its plugin shape', () => {
    expect(acpAgent.name).toBe('acp-agent')
    expect(acpAgent.Config).toBeDefined()
  })
})
