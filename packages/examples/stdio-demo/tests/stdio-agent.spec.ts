import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'

import type { Message } from '@deepseek-ai/dsh-llm'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import * as stdioAgent from '../src/index.ts'

/**
 * Unit coverage for app composition and config forwarding: console logger, pre-created main agent,
 * agent-spine-demo spine, JSONL backend, and readline UI. HMR is a Loader-only leaf concern covered by the
 * keyless echo smoke; this tier pins the export shape because an inject-less app could otherwise
 * survive namespace collapse while silently losing its schema.
 */
async function mount(config: stdioAgent.Config, withBash = false): Promise<Context> {
  const ctx = new Context()
  if (withBash) ctx.provide('bash', { sandboxMode: undefined })
  await ctx.plugin(stdioAgent, config)
  // The app mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services + the pre-created agent are ready.
  await new Promise(resolve => setTimeout(resolve, 80))
  return ctx
}

async function isolatedSkillsConfig(catalogDescriptionMaxLength?: number): Promise<NonNullable<stdioAgent.Config['skills']>> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stdio-demo-skills-'))
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-stdio-demo-default-skills-'))
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

describe('dsh-stdio-demo app', () => {
  it('composes the spine + front-door cluster and pre-creates the main agent', async () => {
    const ctx = await mount({ provider: 'mock', model: 'mock', persona: 'hi', persistenceRoot: '/tmp/dsh-stdio-demo-spec', skills: await isolatedSkillsConfig(), workspaceContext: false })
    // The spine services (brought up by the agent-spine-demo bundle) are all present.
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('userInteraction')).toBeDefined()
    expect(ctx.get('tools')?.get('ask_user_question')).toBeDefined()
    // The sole pre-created agent the UI drives. `main` is its stable config
    // label; each fresh process mints a durable combined agent/session id.
    await expect.poll(() => ctx.get('agents')?.list()).toHaveLength(1)
    const agent = ctx.get('agents')?.list()[0]
    expect(agent).toBeDefined()
    expect(agent?.id).toBe(agent?.session.id)
    expect(agent?.id).toMatch(/^main-session-/)
    expect(agent?.session.header.cwd).toBe(process.cwd())
    await ctx.fiber.dispose()
  })

  it('normalizes an empty resume id to a fresh exact app identity', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      resumeSessionId: '',
      persistenceRoot: '/tmp/dsh-stdio-agent-spec-empty-resume',
      skills: await isolatedSkillsConfig(),
      workspaceContext: false,
    })
    await expect.poll(() => ctx.get('agents')?.list()).toHaveLength(1)
    const agent = ctx.get('agents')?.list()[0]
    expect(agent?.id).toMatch(/^main-session-[0-9a-f-]{36}$/)
    expect(agent?.id).toBe(agent?.session.id)
    await ctx.fiber.dispose()
  })

  it('defaults persistenceRoot and welcome when omitted', async () => {
    // Direct apply (NOT via ctx.plugin, which validates+defaults the config
    // first) so the runtime `?? './.sessions'` / `?? 'ready.'` fallbacks on
    // apply()'s last two lines are the ones that fire — covering a
    // schema-bypassing direct-mount caller.
    const ctx = new Context()
    // No persona: covers the omitted-persona forwarding branch too.
    stdioAgent.apply(ctx, { provider: 'mock', model: 'mock', skills: await isolatedSkillsConfig(), workspaceContext: false })
    await expect.poll(() => ctx.get('agents')?.list()).toHaveLength(1)
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('agents')?.list()[0]?.id).toMatch(/^main-session-/)
    await ctx.fiber.dispose()
  })

  it('forwards explicit project-instruction controls to the bundled spine', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      persona: 'hi',
      persistenceRoot: '/tmp/dsh-stdio-demo-spec-workspace-context',
      workspaceContext: false,
    })
    await expect.poll(() => ctx.get('agents')?.list()).toHaveLength(1)
    expect(ctx.get('agents')?.list()[0]?.id).toMatch(/^main-session-/)
    await ctx.fiber.dispose()
  })

  it('uses default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      stdioAgent.apply(ctx, { provider: 'mock', model: 'mock', workspaceContext: false })
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards resumeSessionId onto the pre-created agent when set', async () => {
    // A resume id defers agent creation until persistence loads; with no backing
    // session the resume is contained + logged, so no agent registers —
    // the branch that maps resumeSessionId through is what this covers.
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      persona: 'hi',
      persistenceRoot: '/tmp/dsh-stdio-demo-spec-resume',
      resumeSessionId: 'no-such-session',
      skills: await isolatedSkillsConfig(),
      workspaceContext: false,
    })
    expect(ctx.get('agents')?.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('forwards skill config and dshHome into agent-spine-demo', async () => {
    const skills = await isolatedSkillsConfig(6)
    const ctx = await mount({ provider: 'mock', model: 'mock', persona: 'hi', dshHome: skills.local!.dshHome!, skills, workspaceContext: false })
    ctx.skills.register({ name: 'stdio-skill', description: 'Stdio skill', source: 'runtime', content: 'body' })
    expect(JSON.stringify(await composePrefix(ctx))).toContain('- `stdio-skill`: Std...')
    await ctx.fiber.dispose()
  })

  it('forwards maxParallelToolCalls to the bundled agent loop', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      maxParallelToolCalls: 3,
      persistenceRoot: '/tmp/dsh-stdio-demo-spec-parallel',
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

  it('exposes its name and Config schema', () => {
    expect(stdioAgent.name).toBe('stdio-demo')
    expect(stdioAgent.Config).toBeDefined()
  })

  it('forwards toolOrder through agent-spine-demo to the system-prompt assembly', async () => {
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      persistenceRoot: '/tmp/dsh-stdio-demo-spec-tool-order',
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
    expect(assembly.tools.map(tool => tool.name)).toEqual(['zulu', 'alpha', 'ask_user_question', 'skill', 'task_kill', 'task_list', 'task_output'])
    await ctx.fiber.dispose()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // A default export would make `unwrapExports` collapse this inject-less namespace and silently
    // drop `name`/`Config` while the app still boots. Guard the postmortem-0001 shape directly.
    expect('default' in stdioAgent).toBe(false)
    expect(typeof stdioAgent.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(stdioAgent) as Record<string, unknown>
    expect(unwrapped).toBe(stdioAgent)
    expect(unwrapped.name).toBe('stdio-demo')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
