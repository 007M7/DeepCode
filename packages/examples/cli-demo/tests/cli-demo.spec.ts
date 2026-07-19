import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as cliDemo from '../src/index.ts'

const contexts: Context[] = []

async function skillConfig(catalogDescriptionMaxLength?: number): Promise<NonNullable<cliDemo.Config['skills']>> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cli-demo-skills-'))
  return {
    local: { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') },
    ...catalogDescriptionMaxLength === undefined ? {} : { tool: { catalogDescriptionMaxLength } },
  }
}

async function mount(config: cliDemo.Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(cliDemo, config)
  await new Promise(resolve => setTimeout(resolve, 80))
  return ctx
}

async function composePrefix(ctx: Context): Promise<Message[]> {
  const agent = { session: { header: { cwd: '/tmp' } } } as unknown as Agent
  const empty: Message[] = []
  return await agentEvents(ctx, agent).waterfall(
    'agent/session-prefix', empty, new AbortController().signal,
    () => Promise.resolve(empty),
  )
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('dsh-cli-demo app composition', () => {
  it('composes the UI-less spine, JSONL persistence, and a main agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cli-demo-compose-'))
    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      persona: 'Headless.',
      tools: { mode: 'native' },
      persistenceRoot: root,
      skills: await skillConfig(),
      workspaceContext: false,
    })
    const [agent] = ctx.get('agents')?.roots() ?? []
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(agent?.session.header.cwd).toBe(process.cwd())
    expect(ctx.get('userInteraction')).toBeUndefined()
    expect(ctx.get('tools')?.get('ask_user_question')).toBeUndefined()
  })

  it('covers direct-apply defaults and forwards skill and tool-order config', async () => {
    const oldDshHome = process.env.DSH_HOME
    const oldAgentsHome = process.env.DSH_AGENTS_HOME
    const home = await mkdtemp(join(tmpdir(), 'dsh-cli-demo-defaults-'))
    process.env.DSH_HOME = join(home, '.dsh')
    process.env.DSH_AGENTS_HOME = join(home, '.agents')
    try {
      const ctx = new Context()
      contexts.push(ctx)
      cliDemo.apply(ctx, { provider: 'mock', model: 'mock', workspaceContext: false })
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(ctx.get('sessionPersistence')).toBeDefined()
      const [agent] = ctx.get('agents')?.roots() ?? []
      expect(agent?.session.id).toMatch(/^main-session-/)
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      if (oldDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldDshHome
      if (oldAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = oldAgentsHome
    }

    const ctx = await mount({
      provider: 'mock',
      model: 'mock',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      skills: await skillConfig(6),
      workspaceContext: false,
    })
    ctx.skills.register({ name: 'cli-skill', description: 'CLI skill', source: 'runtime', content: 'body' })
    for (const name of ['alpha', 'zulu']) {
      ctx.tools.register({ name, description: name, parameters: {}, execute: async () => [] })
    }
    expect(JSON.stringify(await composePrefix(ctx))).toContain('- `cli-skill`: CLI...')
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual([
      'zulu',
      'alpha',
      'skill',
      'task_kill',
      'task_list',
      'task_output',
    ])
  })

  it('exposes the Loader-safe namespace plugin shape and schema', () => {
    expect(cliDemo.name).toBe('cli-demo')
    expect(cliDemo.Config).toBeDefined()
    expect('default' in cliDemo).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(cliDemo) as Record<string, unknown>
    expect(unwrapped).toBe(cliDemo)
    expect(unwrapped.name).toBe('cli-demo')
    expect(typeof unwrapped.apply).toBe('function')
  })
})
