import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import type { Message } from '@deepseek-ai/dsh-llm'
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

async function isolatedSkillsConfig(catalogDescriptionMaxLength?: number): Promise<NonNullable<acpAgent.Config['skills']>> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-agent-skills-'))
  return {
    local: { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') },
    ...catalogDescriptionMaxLength !== undefined ? { tool: { catalogDescriptionMaxLength } } : {},
  }
}

async function composePrefix(ctx: Context): Promise<Message[]> {
  const empty: Message[] = []
  return await ctx.waterfall(
    'agent/session-prefix', { session: { header: { cwd: '/tmp' } } } as never,
    empty, new AbortController().signal, () => Promise.resolve(empty),
  )
}

async function withIsolatedSkillHomes<T>(run: () => Promise<T>): Promise<T> {
  const oldDshHome = process.env.DSH_HOME
  const oldAgentsHome = process.env.DSH_AGENTS_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-agent-default-skills-'))
  process.env.DSH_HOME = join(home, '.dsh')
  process.env.DSH_AGENTS_HOME = join(home, '.agents')
  try {
    return await run()
  } finally {
    if (oldDshHome === undefined) {
      delete process.env.DSH_HOME
    } else {
      process.env.DSH_HOME = oldDshHome
    }
    if (oldAgentsHome === undefined) {
      delete process.env.DSH_AGENTS_HOME
    } else {
      process.env.DSH_AGENTS_HOME = oldAgentsHome
    }
  }
}

describe('dsh-acp-agent composition', () => {
  it('brings up the spine + persistence + the ACP bridge', async () => {
    const ctx = await mount({ model: 'mock', persona: 'hi', persistenceRoot: '/tmp/dsh-acp-agent-test', skills: await isolatedSkillsConfig() })
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('userInteraction')).toBeDefined()
    expect(ctx.get('tools')?.get('ask_user_question')).toBeUndefined()
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
    // No persona: covers the omitted-persona forwarding branch too.
    acpAgent.apply(ctx, { model: 'mock', skills: await isolatedSkillsConfig() })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.get('sessionPersistence')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('uses default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      acpAgent.apply(ctx, { model: 'mock' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards skill config into agent-core', async () => {
    const ctx = await mount({ model: 'mock', persona: 'hi', skills: await isolatedSkillsConfig(6) })
    ctx.skills.register({ name: 'acp-skill', description: 'ACP skill', source: 'runtime', content: 'body' })
    expect(JSON.stringify(await composePrefix(ctx))).toContain('- `acp-skill`: ACP...')
    await ctx.fiber.dispose()
  })

  it('exposes its plugin shape', () => {
    expect(acpAgent.name).toBe('acp-agent')
    expect(acpAgent.Config).toBeDefined()
  })

  it('forwards toolOrder through agent-core to the system-prompt assembly', async () => {
    const ctx = await mount({
      model: 'mock',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      persistenceRoot: '/tmp/dsh-acp-agent-test-tool-order',
    })
    // The bundle's own bash tools pend on the absent `ctx.bash` executor in
    // this providerless mount, so register two plain tools to order.
    for (const name of ['alpha', 'zulu']) {
      ctx.get('tools')!.register({
        name,
        description: name,
        parameters: {},
        execute: async () => [],
      })
    }
    const assembly = await ctx.get('systemPrompt')!.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'skill'])
    await ctx.fiber.dispose()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // Postmortem 0001 guard: a stray `export default apply` makes the Loader's
    // `unwrapExports` (`exports.default ?? exports`) collapse the module to the
    // bare `apply` function, DROPPING the named `name`/`Config`. This package has
    // no `inject` export, so that collapse would NOT crash at load (the keyless
    // bin smoke would still answer `initialize`) — it would silently lose its
    // config schema. So guard the shape directly here: assert no `default`
    // export, and that the real `unwrapExports` leaves `name`/`Config`/`apply`
    // intact. Adding `export default` to src/index.ts fails this test.
    expect('default' in acpAgent).toBe(false)
    expect(typeof acpAgent.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(acpAgent) as Record<string, unknown>
    expect(unwrapped).toBe(acpAgent)
    expect(unwrapped.name).toBe('acp-agent')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
