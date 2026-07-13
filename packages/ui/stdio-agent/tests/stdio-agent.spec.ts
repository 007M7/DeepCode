import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import * as stdioAgent from '../src/index.ts'

/**
 * Unit coverage for the @deepseek-ai/dsh-stdio-agent app plugin: mounting it
 * composes the console logger, the agent-core spine (pre-creating the `main`
 * agent from the app config), the JSONL backend, and the readline UI in one
 * `ctx.plugin`. The forwarded `model` reaches the pre-created agent and
 * `persona` the system-prompt plugin; `persistenceRoot`/`welcome`/
 * `resumeSessionId` route to their backends.
 *
 * `hmr` is NOT part of this plugin (it is a leaf entry — a Loader-only dev
 * plugin the in-process tier cannot import); the keyless echo smoke in
 * `examples/echo-agent` proves the whole subprocess tree (incl. `hmr`) boots
 * through the real Loader, while the export SHAPE is pinned by this suite's
 * explicit `unwrapExports` assertion (an inject-less app would boot past a
 * stray default rather than crash). Here we assert the composition + config
 * forwarding the unit tier can reach.
 */
async function mount(config: stdioAgent.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(stdioAgent, config)
  // The app mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services + the pre-created agent are ready.
  await new Promise(resolve => setTimeout(resolve, 80))
  return ctx
}

async function isolatedSkillsConfig(catalogDescriptionMaxLength?: number): Promise<NonNullable<stdioAgent.Config['skills']>> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stdio-agent-skills-'))
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-stdio-agent-default-skills-'))
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

describe('dsh-stdio-agent app', () => {
  it('composes the spine + front-door cluster and pre-creates the main agent', async () => {
    const ctx = await mount({ model: 'mock', persona: 'hi', persistenceRoot: '/tmp/dsh-stdio-agent-spec', skills: await isolatedSkillsConfig() })
    // The spine services (brought up by the agent-core bundle) are all present.
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('userInteraction')).toBeDefined()
    expect(ctx.get('tools')?.get('ask_user_question')).toBeDefined()
    // The pre-created `main` agent the UI drives.
    const agent = ctx.get('agents')?.get(AgentId('main'))
    expect(agent).toBeDefined()
    expect(agent?.session.header.cwd).toBe(process.cwd())
    await ctx.fiber.dispose()
  })

  it('defaults persistenceRoot and welcome when omitted', async () => {
    // Direct apply (NOT via ctx.plugin, which validates+defaults the config
    // first) so the runtime `?? './.sessions'` / `?? 'ready.'` fallbacks on
    // apply()'s last two lines are the ones that fire — covering a
    // schema-bypassing direct-mount caller.
    const ctx = new Context()
    // No persona: covers the omitted-persona forwarding branch too.
    stdioAgent.apply(ctx, { model: 'mock', skills: await isolatedSkillsConfig() })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('uses default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      stdioAgent.apply(ctx, { model: 'mock' })
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards resumeSessionId onto the pre-created agent when set', async () => {
    // A resume id defers agent creation until persistence loads; with no backing
    // session the resume is contained + logged, so no `main` agent registers —
    // the branch that maps resumeSessionId through is what this covers.
    const ctx = await mount({
      model: 'mock',
      persona: 'hi',
      persistenceRoot: '/tmp/dsh-stdio-agent-spec-resume',
      resumeSessionId: 'no-such-session',
      skills: await isolatedSkillsConfig(),
    })
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forwards skill config into agent-core', async () => {
    const ctx = await mount({ model: 'mock', persona: 'hi', skills: await isolatedSkillsConfig(6) })
    ctx.skills.register({ name: 'stdio-skill', description: 'Stdio skill', source: 'runtime', content: 'body' })
    expect(JSON.stringify(await composePrefix(ctx))).toContain('- `stdio-skill`: Std...')
    await ctx.fiber.dispose()
  })

  it('exposes its name and Config schema', () => {
    expect(stdioAgent.name).toBe('stdio-agent')
    expect(stdioAgent.Config).toBeDefined()
  })

  it('forwards toolOrder through agent-core to the system-prompt assembly', async () => {
    const ctx = await mount({
      model: 'mock',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      persistenceRoot: '/tmp/dsh-stdio-agent-spec-tool-order',
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
    expect(assembly.tools.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'ask_user_question', 'skill'])
    await ctx.fiber.dispose()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // Postmortem 0001 guard: a stray `export default apply` makes the Loader's
    // `unwrapExports` (`exports.default ?? exports`) collapse the module to the
    // bare `apply` function, DROPPING the named `name`/`Config`. This package has
    // no `inject` export, so that collapse would NOT crash at load (the keyless
    // echo smoke would still boot the tree) — it would silently lose its config
    // schema. So guard the shape directly here: assert no `default` export, and
    // that the real `unwrapExports` leaves `name`/`Config`/`apply` intact. Adding
    // `export default` to src/index.ts fails this test.
    expect('default' in stdioAgent).toBe(false)
    expect(typeof stdioAgent.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(stdioAgent) as Record<string, unknown>
    expect(unwrapped).toBe(stdioAgent)
    expect(unwrapped.name).toBe('stdio-agent')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
