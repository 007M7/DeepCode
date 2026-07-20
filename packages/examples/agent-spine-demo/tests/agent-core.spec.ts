import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import * as agentCore from '../src/index.ts'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CallId, LlmAdapter, LlmError, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

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
async function mount(config: agentCore.Config, withBash = false): Promise<Context> {
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

function waitForIdle(ctx: Context, target: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (agent, status) => {
      if (agent === target && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function messageText(message: Message | undefined): string {
  return message?.content.map(block => block.type === 'text' ? block.text : '').join('\n') ?? ''
}

class TransientOnceAdapter extends LlmAdapter {
  requests = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests === 1) throw new LlmError('temporary outage', 'SERVER')
    yield* textResponse('recovered by bundled policy')
  }
}

describe('dsh-agent-spine-demo bundle', () => {
  it('brings up the full default spine', async () => {
    const ctx = await mount({ workspaceContext: false })
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
    expect(ctx.get('goals')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('opts into the configured persisted-goal domain, tools, and same-session driver', async () => {
    const ctx = await mount({
      workspaceContext: false,
      agents: [{ id: SessionId('configured-goal'), provider: 'mock', model: 'mock' }],
      goals: {
        domain: { defaultMaxGoalRounds: 17 },
        tool: { blockedAfterConsecutiveRounds: 5 },
      },
    })
    const agent = ctx.agents.list()[0]
    if (agent === undefined) throw new Error('configured goal test has no live agent')
    expect(ctx.goals.create(agent, { objective: 'configured' })).toMatchObject({
      objective: 'configured', maxGoalRounds: 17,
    })
    expect(['create_goal', 'get_goal', 'update_goal'].map(name => ctx.tools.get(name)?.name))
      .toEqual(['create_goal', 'get_goal', 'update_goal'])
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:goal')?.text)
      .toContain('at least 5 consecutive goal rounds')
    await ctx.fiber.dispose()
  })

  it('accepts an explicit false goal composition without mounting it', async () => {
    const ctx = await mount({ workspaceContext: false, goals: false })
    expect(ctx.get('goals')).toBeUndefined()
    expect(ctx.tools.get('get_goal')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('loads and configures bounded request recovery for every bundled front door', async () => {
    const adapter = new TransientOnceAdapter()
    const ctx = await mount({
      workspaceContext: false,
      llmRetry: {
        maxTransientRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
      },
    })
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('bundled-retry-session'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    handle.agent.send([{ type: 'text', text: 'recover' }])
    await waitForIdle(ctx, handle.agent)

    expect(adapter.requests).toBe(2)
    const retryEvents = handle.agent.session.events.filter(event => event.type === 'llm/retry')
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]?.data.retry).toBe(1)
    expect(retryEvents[0]?.data.maxRetries).toBe(1)
    expect(messageText(handle.agent.session.deriveMessages().at(-1))).toBe('recovered by bundled policy')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('includes the skill registry, local provider, and skill tool without builtin skills', async () => {
    const ctx = await mount({ workspaceContext: false })

    expect(ctx.skills).toBeDefined()
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('skill')
    expect(await ctx.skills.list()).toEqual([])

    await ctx.fiber.dispose()
  })

  it('defaults the agents list to empty (no pre-created agents)', async () => {
    const ctx = await mount({ workspaceContext: false })
    expect(ctx.get('agents')?.get(SessionId('main'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forwards a pre-created agent to the loop and the persona to system-prompt', async () => {
    const ctx = await mount({
      agents: [{ id: SessionId('main'), provider: 'mock', model: 'mock' }],
      persona: 'You are main.',
      workspaceContext: false,
    })
    const agent = ctx.get('agents')?.list()[0]
    expect(agent?.id).toBe(agent?.session.id)
    expect(agent?.id).toMatch(/^main-session-/)
    const assembly = await ctx.get('systemPrompt')!.assemble()
    expect(assembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are main.')
    await ctx.fiber.dispose()
  })

  it('forwards the global maxParallelToolCalls config to agent-loop', async () => {
    const ctx = await mount({
      agents: [{ id: SessionId('main'), provider: 'mock', model: 'mock' }],
      maxParallelToolCalls: 3,
      workspaceContext: false,
    })
    expect(ctx.get('agentLoop')?.config.maxParallelToolCalls).toBe(3)
    await ctx.fiber.dispose()
  })

  it('tolerates a schema-bypassing direct apply (the ?? fallbacks fire)', async () => {
    // ctx.plugin validates + defaults the bundle config first; a direct apply
    // skips the schema, so the forwarding `?? []` / `?? ''` are what fire.
    const ctx = new Context()
    agentCore.apply(ctx, { workspaceContext: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('agents')?.list()).toHaveLength(0)
    const assembly = await ctx.get('systemPrompt')!.assemble()
    expect(assembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('')
    await ctx.fiber.dispose()
  })

  it('uses owner defaults for a schema-bypassing empty goal opt-in', async () => {
    const ctx = new Context()
    agentCore.apply(ctx, {
      workspaceContext: false,
      agents: [{ id: SessionId('defaulted-goal'), provider: 'mock', model: 'mock' }],
      goals: {},
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const agent = ctx.agents.list()[0]
    if (agent === undefined) throw new Error('default goal test has no live agent')
    expect(ctx.goals.create(agent, { objective: 'defaulted' })).toMatchObject({
      objective: 'defaulted', maxGoalRounds: 256,
    })
    expect(ctx.tools.get('get_goal')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('loads workspace instructions into requests through the bundled spine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-workspace-context-'))
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(join(root, 'AGENTS.md'), 'bundled project rule')
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await mount({ workspaceContext: { maxBytes: 65536 } })
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      ctx.llm.registerAdapter(['mock'], adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId('main-session'),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const agent = handle.agent

      agent.send([{ type: 'text', text: 'hi' }])
      await waitForIdle(ctx, agent)

      const sentText = adapter.requests[0]?.messages.map(messageText).join('\n')
      expect(sentText).toContain('hi')
      expect(sentText).toContain('bundled project rule')
      expect(adapter.requests[0]?.system).toContain('You are an AI agent powered by the DeepSeek Harness SDK.')
      expect(adapter.requests[0]?.system).not.toContain('bundled project rule')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards workspace-context config to the bundled loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-workspace-context-disabled-'))
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(join(root, 'AGENTS.md'), 'must not be injected')
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await mount({ workspaceContext: { maxBytes: 0 } })
      ctx.llm.registerAdapter(['mock'], adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId('main-disabled-session'),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      handle.agent.send([{ type: 'text', text: 'hi' }])
      await waitForIdle(ctx, handle.agent)

      expect(adapter.requests[0]?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards skill config to the registry, local provider, and model-facing consumer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-home-'))
    const agentsHome = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-agents-'))
    const custom = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-skill-custom-'))
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'custom-skill.md'), '---\nname: custom-skill\ndescription: Custom skill\n---\n\nCustom body.\n')
    const ctx = await mount({
      agents: [],
      workspaceContext: false,
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

  it('shares top-level dshHome between local skills and the managed bash environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-agent-core-shared-home-'))
    const agentsHome = await mkdtemp(join(tmpdir(), 'dsh-agent-core-shared-agents-'))
    await mkdir(join(home, 'skills'), { recursive: true })
    await writeFile(join(home, 'skills', 'shared-skill.md'), '---\nname: shared-skill\ndescription: Shared home skill\n---\n\nShared body.\n')

    const ctx = await mount({
      dshHome: home,
      workspaceContext: false,
      skills: { local: { agentsHome } },
    }, true)

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['shared-skill'])
    const execution: ToolExecution = {
      token: Symbol('agent-core-dsh-home-test') as ToolExecution['token'],
      callId: CallId('agent-core-dsh-home'),
      name: 'bash',
      arguments: { command: 'true' },
    }
    expect(ctx.bashEnv.collect(execution)).toMatchObject({ DSH_HOME: home, DSH_SHELL: '1' })
    await ctx.fiber.dispose()
  })

  it('rejects conflicting global and nested DSH home directories', () => {
    expect(() => {
      agentCore.apply(new Context(), {
        dshHome: '/global-dsh-home',
        workspaceContext: false,
        skills: { local: { dshHome: '/nested-dsh-home' } },
      })
    }).toThrow('agent-spine-demo: dshHome and skills.local.dshHome must resolve to the same directory')
  })

  it('places workspace instructions before the skill catalog in the session prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-spine-demo-prefix-order-'))
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(join(root, 'AGENTS.md'), 'workspace rule before skills')
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await mount({ workspaceContext: { maxBytes: 65536 } })
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.skills.register({
        name: 'prefix-order-skill',
        description: 'Skill catalog after workspace rules',
        source: 'runtime',
        content: 'body',
      })
      const handle = await ctx.agents.create({
        sessionId: SessionId('prefix-order-session'),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      handle.agent.send([{ type: 'text', text: 'hi' }])
      await waitForIdle(ctx, handle.agent)

      expect(messageText(adapter.requests[0]?.messages[0])).toContain('workspace rule before skills')
      expect(messageText(adapter.requests[0]?.messages[1])).toContain('prefix-order-skill')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards its bundled tool configs to tool-bash and tool-tasks', async () => {
    const ctx = await mount({
      workspaceContext: false,
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

  it('can omit skills and model-facing task controls for a foreground-only deployment', async () => {
    const ctx = await mount({
      workspaceContext: false,
      skills: { enabled: false },
      toolBash: { enableRunInBackground: false },
      toolTasks: false,
    }, true)

    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['bash'])
    expect(ctx.get('skills')).toBeUndefined()
    expect(ctx.get('tasks')).toBeDefined()

    await ctx.fiber.dispose()
  })

  it('picks shared spine config without leaking front-door fields', () => {
    const appConfig = {
      model: 'front-door-only',
      persona: 'You are merged.',
      toolOrder: ['zulu'],
      tools: { mode: 'native' as const },
      dshHome: '/tmp/dsh-home',
      workspaceContext: false as const,
      skills: { enabled: false },
      toolBash: { enableRunInBackground: false },
      toolTasks: false as const,
      llmRetry: { maxTransientRetries: 1, jitterRatio: 0 },
    }

    expect(agentCore.pickSpineConfig(appConfig)).toEqual({
      persona: appConfig.persona,
      toolOrder: appConfig.toolOrder,
      tools: appConfig.tools,
      dshHome: appConfig.dshHome,
      workspaceContext: false,
      skills: appConfig.skills,
      toolBash: appConfig.toolBash,
      toolTasks: appConfig.toolTasks,
      llmRetry: appConfig.llmRetry,
    })
    expect(agentCore.pickSpineConfig({ workspaceContext: false })).toEqual({ workspaceContext: false })
  })

  it('uses the default skill config when apply is called directly without skills', async () => {
    await withIsolatedSkillHomes(async () => {
      const ctx = new Context()
      agentCore.apply(ctx, { agents: [], workspaceContext: false })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.skills).toBeDefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    })
  })

  it('forwards toolOrder to the system-prompt assembly', async () => {
    const ctx = await mount({ toolOrder: ['zulu', TOOL_ORDER_REST], workspaceContext: false })
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

  it('supports direct apply with workspace instructions disabled and no forwarded agents', async () => {
    const ctx = new Context()
    agentCore.apply(ctx, { workspaceContext: false })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(ctx.get('agents')?.list()).toEqual([])
    expect(ctx.get('systemPrompt')).toBeDefined()
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
