import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import * as agentCore from '../src/index.ts'
import { AgentId, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type Message } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-tasks' {
  interface TaskKindMap {
    probe: 'probe'
  }
}

async function composePrefix(ctx: Context, cwd: string): Promise<Message[]> {
  const agent = { session: { header: { cwd } } } as unknown as Agent
  const empty: Message[] = []
  return await agentEvents(ctx, agent).waterfall(
    'agent/session-prefix', empty, new AbortController().signal,
    () => Promise.resolve(empty),
  )
}

/**
 * Unit coverage for the @deepseek-ai/dsh-agent-spine-demo bundle: mounting it brings
 * up the whole default spine in one `ctx.plugin`, and the forwarded
 * `agents` config reaches the loop (default `[]`, or a pre-created agent).
 *
 * The bundle is exercised through `ctx.plugin(agentCore, …)` — the NAMESPACE
 * import, the same shape the Loader builds from `unwrapExports`. The real
 * Loader-path guard (export shape, `unwrapExports`) is the app packages' keyless
 * bin smokes; here we assert the composition + config forwarding.
 */
async function mount(config?: agentCore.Config, withBash = false): Promise<Context> {
  const oldDshHome = process.env.DSH_HOME
  const oldAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-home-'))
  process.env.DSH_AGENTS_HOME = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-agents-'))
  const ctx = new Context()
  if (withBash) ctx.provide('bash', { sandboxMode: undefined })
  try {
    await ctx.plugin(agentCore, config)
    // The bundle mounts its children inside apply() (not awaited there); let their
    // fibers settle so the spine services and any pre-created agent are ready.
    await new Promise(resolve => setTimeout(resolve, 50))
    return ctx
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

async function withIsolatedSkillHomes<T>(run: () => Promise<T>): Promise<T> {
  const oldDshHome = process.env.DSH_HOME
  const oldAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-home-'))
  process.env.DSH_AGENTS_HOME = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-agents-'))
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

describe('dsh-agent-spine-demo bundle', () => {
  it('brings up the full default spine', async () => {
    const ctx = await mount()
    // One service from each layer of the spine proves the children loaded.
    expect(ctx.get('timer')).toBeDefined()
    expect(ctx.get('llm')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(ctx.get('systemPrompt')).toBeDefined()
    expect(ctx.get('tools')).toBeDefined()
    expect(ctx.get('skills')).toBeDefined()
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('tasks')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('includes the skill registry, local provider, and skill tool without builtin skills', async () => {
    const ctx = await mount()

    expect(ctx.skills).toBeDefined()
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('skill')
    expect(await ctx.skills.list()).toEqual([])

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

  it('forwards skill config to the registry, local provider, and model-facing consumer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-home-'))
    const agentsHome = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-agents-'))
    const custom = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-custom-'))
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'custom-skill.md'), '---\nname: custom-skill\ndescription: Custom skill\n---\n\nCustom body.\n')
    const ctx = await mount({
      agents: [],
      skills: {
        registry: { collectCacheMaxEntries: 4 },
        local: {
          dshHome: join(home, '.dsh'),
          agentsHome: join(agentsHome, '.agents'),
          customSkillDirs: [custom],
        },
        tool: { catalogDescriptionMaxLength: 6 },
      },
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['custom-skill'])
    expect(JSON.stringify(await composePrefix(ctx, '/tmp'))).toContain('- `custom-skill`: Cus...')
    await ctx.fiber.dispose()
  })

  it('forwards its bundled tool configs to tool-bash and tool-tasks', async () => {
    const ctx = await mount({
      toolBash: { enableRunInBackground: false },
      toolTasks: { waitTimeoutMs: 7, maxWaitTimeoutMs: 11 },
    }, true)

    const bash = ctx.tools.schemas().find(tool => tool.name === 'bash')
    expect(bash).toBeDefined()
    expect(Object.keys((bash!.parameters as { properties: Record<string, unknown> }).properties))
      .not.toContain('run_in_background')

    const id = ctx.tasks.start({
      kind: 'probe',
      label: 'config forwarding probe',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })
    const wait = vi.spyOn(ctx.tasks, 'wait')
    await ctx.tools.execute({
      callId: CallId('task-config-forwarding'),
      name: 'task_output',
      arguments: { task_id: id, wait: true },
    })
    expect(wait).toHaveBeenCalledWith(id, 7, undefined, undefined)

    await ctx.fiber.dispose()
  })

  it('uses the default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      agentCore.apply(ctx, { agents: [] })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards toolOrder to the system-prompt assembly', async () => {
    const ctx = await mount({ toolOrder: ['zulu', TOOL_ORDER_REST] })
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

  it('re-exports the loop config schema as its own', () => {
    expect(agentCore.Config).toBeDefined()
    expect(agentCore.name).toBe('agent-spine-demo')
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    // A default export would make `unwrapExports` collapse this inject-less namespace and silently
    // drop `name`/`Config`. Apps import the bundle directly, so this is its Loader-shape guard.
    expect('default' in agentCore).toBe(false)
    expect(typeof agentCore.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(agentCore) as Record<string, unknown>
    expect(unwrapped).toBe(agentCore)
    expect(unwrapped.name).toBe('agent-spine-demo')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
