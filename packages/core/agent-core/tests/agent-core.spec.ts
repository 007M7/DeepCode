import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
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

  it('forwards a pre-created agent to the loop and the persona to system-prompt', async () => {
    const ctx = await mount({
      agents: [{ id: AgentId('main'), model: 'mock' }],
      persona: 'You are main.',
    })
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeDefined()
    const assembly = await ctx.get('systemPrompt')!.assemble()
    expect(assembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are main.')
    await ctx.fiber.dispose()
  })

  it('tolerates a schema-bypassing direct apply (the ?? fallbacks fire)', async () => {
    // ctx.plugin validates + defaults the bundle config first; a direct apply
    // skips the schema, so the forwarding `?? []` / `?? ''` are what fire.
    const ctx = new Context()
    agentCore.apply(ctx, {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('agents')?.list()).toHaveLength(0)
    const assembly = await ctx.get('systemPrompt')!.assemble()
    expect(assembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('')
    await ctx.fiber.dispose()
  })

  it('re-exports the loop config schema as its own', () => {
    expect(agentCore.Config).toBeDefined()
    expect(agentCore.name).toBe('agent-core')
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // Postmortem 0001 guard: a stray `export default apply` makes the Loader's
    // `unwrapExports` (`exports.default ?? exports`) collapse the module to the
    // bare `apply` function, DROPPING the named `name`/`Config`. This package has
    // no `inject` export (it mounts children that carry their own), so that
    // collapse would NOT crash at load — the plugin would boot but silently lose
    // its config schema. This bundle is also never Loader-unwrapped by any smoke
    // (the apps import it directly; the mount test namespace-mounts it), so this
    // is its ONLY export-shape guard. Assert directly AND through the real
    // `unwrapExports` so adding `export default` to src/index.ts fails here.
    expect('default' in agentCore).toBe(false)
    expect(typeof agentCore.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(agentCore) as Record<string, unknown>
    expect(unwrapped).toBe(agentCore)
    expect(unwrapped.name).toBe('agent-core')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
