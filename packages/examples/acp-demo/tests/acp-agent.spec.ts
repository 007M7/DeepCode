import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as acpAgent from '../src/index.ts'

/**
 * In-process unit coverage for the @deepseek-ai/dsh-acp-demo composition:
 * mounting it brings up the agent-spine-demo spine + JSONL persistence + the ACP
 * bridge in one `ctx.plugin`. Unlike the stdio app, this one loads NO
 * Loader-only plugin (no hmr), so it mounts in a plain Context.
 *
 * The REAL Loader-path guard (export shape via `unwrapExports`, the headline
 * ACP operations end-to-end) is the keyless bin smoke in `load-path.e2e.ts`;
 * this spec asserts the composition and the persistenceRoot default branch.
 */
async function mount(config: acpAgent.Config, withBash = false): Promise<Context> {
  const ctx = new Context()
  if (withBash) ctx.provide('bash', { sandboxMode: undefined })
  await ctx.plugin(acpAgent, config)
  // The bundle mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services are ready.
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

async function isolatedSkillsConfig(catalogDescriptionMaxLength?: number): Promise<NonNullable<acpAgent.Config['skills']>> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-demo-skills-'))
  return {
    local: { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') },
    ...catalogDescriptionMaxLength !== undefined ? { tool: { catalogDescriptionMaxLength } } : {},
  }
}

async function composePrefix(ctx: Context): Promise<Message[]> {
  const agent = { session: { header: { cwd: '/tmp' } } } as unknown as Agent
  const empty: Message[] = []
  return await agentEvents(ctx, agent).waterfall(
    'agent/session-prefix', empty, new AbortController().signal,
    () => Promise.resolve(empty),
  )
}

async function withIsolatedSkillHomes<T>(run: () => Promise<T>): Promise<T> {
  const oldDshHome = process.env.DSH_HOME
  const oldAgentsHome = process.env.DSH_AGENTS_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-demo-default-skills-'))
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

describe('dsh-acp-demo composition', () => {
  it('brings up the spine + persistence + the ACP bridge', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      persona: 'hi',
      persistenceRoot: '/tmp/dsh-acp-demo-test',
      persistenceCompression: 'none',
      skills: await isolatedSkillsConfig(),
      workspaceContext: false,
    })
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect((ctx.get('sessionPersistence') as unknown as { config: { compression?: string } }).config.compression).toBe('none')
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('userInteraction')).toBeDefined()
    expect(ctx.get('tools')?.get('ask_user_question')).toBeUndefined()
    // No pre-created agents — ACP session/new creates them on demand.
    expect(ctx.get('agents')!.list()).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('defaults the persistence root when omitted', async () => {
    // Exercises the `DEFAULT_PERSISTENCE_ROOT` fallback for a direct-apply caller that
    // bypasses the schema's `.default(...)`: call `apply` directly (not via
    // `ctx.plugin`, which validates+defaults the config first) with no
    // persistenceRoot, so the runtime fallback is the one that fires.
    const ctx = new Context()
    // No persona: covers the omitted-persona forwarding branch too.
    acpAgent.apply(ctx, { provider: 'mock', model: 'mock', skills: await isolatedSkillsConfig(), workspaceContext: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.get('sessionPersistence')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('forwards explicit project-instruction controls to the bundled spine', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      persona: 'hi',
      persistenceRoot: '/tmp/dsh-acp-demo-workspace-context',
      workspaceContext: false,
    })
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('uses default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      acpAgent.apply(ctx, { provider: 'mock', model: 'mock', workspaceContext: false })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards skill config and dshHome into agent-spine-demo', async () => {
    const skills = await isolatedSkillsConfig(6)
    const ctx = await mount({ provider: 'mock', model: 'mock', persona: 'hi', dshHome: skills.local!.dshHome!, skills, workspaceContext: false })
    ctx.skills.register({ name: 'acp-skill', description: 'ACP skill', source: 'runtime', content: 'body' })
    expect(JSON.stringify(await composePrefix(ctx))).toContain('- `acp-skill`: ACP...')
    await ctx.fiber.dispose()
  })

  it('forwards maxParallelToolCalls to the bundled agent loop', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      maxParallelToolCalls: 3,
      persistenceRoot: '/tmp/dsh-acp-demo-test-parallel',
      skills: await isolatedSkillsConfig(),
      workspaceContext: false,
    })
    expect(ctx.get('agentLoop')?.config.maxParallelToolCalls).toBe(3)
    await ctx.fiber.dispose()
  })

  it('forwards bundled tool config into agent-core', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      workspaceContext: false,
      toolBash: { enableRunInBackground: false },
      toolTasks: { waitTimeoutMs: 7, maxWaitTimeoutMs: 11 },
      skills: await isolatedSkillsConfig(),
    }, true)
    const bash = ctx.tools.schemas().find(tool => tool.name === 'bash')
    expect(Object.keys((bash!.parameters as { properties: Record<string, unknown> }).properties))
      .not.toContain('run_in_background')
    await ctx.fiber.dispose()
  })

  it('exposes its plugin shape', () => {
    expect(acpAgent.name).toBe('acp-demo')
    expect(acpAgent.Config).toBeDefined()
  })

  it('forwards toolOrder through agent-spine-demo to the system-prompt assembly', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      persistenceRoot: '/tmp/dsh-acp-demo-test-tool-order',
      workspaceContext: false,
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
    expect(assembly.tools.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'skill', 'task_kill', 'task_list', 'task_output'])
    await ctx.fiber.dispose()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // A default export would make `unwrapExports` collapse this inject-less namespace and silently
    // drop `name`/`Config` while the app still boots. Guard the postmortem-0001 shape directly.
    expect('default' in acpAgent).toBe(false)
    expect(typeof acpAgent.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(acpAgent) as Record<string, unknown>
    expect(unwrapped).toBe(acpAgent)
    expect(unwrapped.name).toBe('acp-demo')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
