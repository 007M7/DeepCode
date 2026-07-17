import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import UserInteractionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-interaction'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { BashExecutor, setSandboxMode } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import ModesService, { DEFAULT_MODE, EXIT_PLAN_MODE, PLAN_MODE, foldMode, resolveConfig } from '../src/index.ts'
import type { ModeConfig } from '../src/index.ts'

/**
 * Drives the REAL plugin: mounts `dsh-mode` beside real `SystemPrompt` and
 * `ToolRegistry` services, with fake Agents carrying real `Session`s (the
 * tool-todo test shape). Turn boundaries are simulated by appending the real
 * boundary events and dispatching the interception seams the loop fires there
 * (`agent/prompt-submit` / `agent/turn-continuation`) — exactly the seams the
 * flush rides in production.
 */

function agentWithSession(id = 'agent-1', options: { mode?: string } = {}): Agent & { session: Session } {
  const session = new Session(SessionId(id))
  return { id: AgentId(id), session, options } as unknown as Agent & { session: Session }
}

async function setup(config?: ModeConfig): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(ModesService, config)
  return ctx
}

/**
 * Append a boundary event and dispatch the interception seam the loop fires
 * there — `agent/prompt-submit` inside the just-opened turn,
 * `agent/turn-continuation` after the step closed — exactly the seams the
 * flush rides (post-commit `session/event` observers are observe-only).
 */
async function boundary(ctx: Context, agent: Agent & { session: Session }, type: 'turn/start' | 'step/end'): Promise<void> {
  const events = agentEvents(ctx, agent)
  if (type === 'turn/start') {
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await events.waterfall('agent/prompt-submit', [{ type: 'text', text: 'boundary probe' }], { kind: 'user' }, () => Promise.resolve({ kind: 'allow' }))
    return
  }
  agent.session.append('step/end', { turn: 1, step: 1 })
  await events.waterfall('agent/turn-continuation', 1, { action: 'stop' }, () => Promise.resolve({ action: 'stop' }))
}

/** Append a minimal `request/header` snapshot so the log has a "what the model was told" anchor. */
function header(session: Session): void {
  session.append('request/header', { header: { config: { model: 'test-model' } }, reason: 'initial' })
}

function noticeTexts(session: Session): string[] {
  return session.events
    .filter(event => event.type === 'context/message')
    .map(event => (event.data as { content: { type: string; text?: string }[] }).content.map(block => block.text ?? '').join(''))
}

function registerNamedTools(ctx: Context, names: string[]): void {
  for (const name of names) {
    ctx.tools.register(defineTool({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
}

let callCounter = 0
function execute(ctx: Context, name: string, agent?: Agent) {
  return ctx.tools.execute({
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: {},
    ...agent ? { agent } : {},
  })
}

describe('resolveConfig', () => {
  it('merges the built-in plan definition: guidance section + read-only access cap, no tool list', () => {
    const resolved = resolveConfig({})
    const plan = resolved.definitions.get(PLAN_MODE)
    expect(plan).toEqual({ section: plan?.section, access: 'read-only' })
    expect(plan?.section).toContain('plan mode')
  })

  it('lets config override plan and add further modes', () => {
    const resolved = resolveConfig({ modes: {
      plan: { section: 'custom plan' },
      review: { section: 'review', access: 'workspace-write' },
    } })
    expect(resolved.definitions.get(PLAN_MODE)).toEqual({ section: 'custom plan' })
    expect(resolved.definitions.get('review')).toEqual({ section: 'review', access: 'workspace-write' })
  })

  it('rejects the reserved default key loudly', () => {
    expect(() => resolveConfig({ modes: { default: { section: '' } } }))
      .toThrow('"default" is reserved')
  })

  it('rejects a malformed definition loudly', () => {
    expect(() => resolveConfig({ modes: { bad: { section: 5 } as unknown as { section: string } } }))
      .toThrow('needs a string `section`')
    // Unknown keys fail loud — a tool allow/deny list is deliberately not
    // part of the vocabulary, and a config still carrying one must not be
    // silently accepted as if it shaped anything.
    expect(() => resolveConfig({ modes: { bad: { section: '', tools: ['read'] } as unknown as { section: string } } }))
      .toThrow('unknown key(s) tools — a definition is { section, access? }')
  })

  it('validates access against the sandbox-mode ladder', () => {
    expect(() => resolveConfig({ modes: { locked: { section: 's', access: 'sealed' as never } } }))
      .toThrow('unknown access "sealed" — one of: read-only, workspace-write, danger-full-access')
    const resolved = resolveConfig({ modes: { locked: { section: 's', access: 'workspace-write' } } })
    expect(resolved.definitions.get('locked')).toEqual({ section: 's', access: 'workspace-write' })
  })
})

describe('foldMode', () => {
  it('folds an empty log to the default mode and takes the last mode/set otherwise', () => {
    const session = new Session(SessionId('fold'))
    expect(foldMode(session.events)).toBe(DEFAULT_MODE)
    session.append('mode/set', { mode: 'plan' })
    session.append('mode/set', { mode: 'default' })
    session.append('mode/set', { mode: 'plan' })
    expect(foldMode(session.events)).toBe('plan')
  })

  it('folds a prefix when `end` is given', () => {
    const session = new Session(SessionId('fold-prefix'))
    session.append('mode/set', { mode: 'plan' })
    session.append('mode/set', { mode: 'default' })
    expect(foldMode(session.events, 1)).toBe('plan')
    expect(foldMode(session.events, 0)).toBe(DEFAULT_MODE)
  })
})

describe('ctx.modes: list/get/set', () => {
  it('lists default first, then the configured definitions', async () => {
    const ctx = await setup({ modes: { review: { section: 's' } } })
    expect(ctx.modes.list()).toEqual([DEFAULT_MODE, PLAN_MODE, 'review'])
  })

  it('reads the folded mode, mapping a dropped definition to default', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
    agent.session.append('mode/set', { mode: PLAN_MODE })
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
    agent.session.append('mode/set', { mode: 'retired' })
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
  })

  it('rejects an unknown mode name loudly, naming the vocabulary', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    expect(() => { ctx.modes.set(agent, 'nope') }).toThrow('unknown mode "nope" — available modes: default, plan')
  })

  it('accepts default as a target (exit-to-default is a valid write)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    ctx.modes.set(agent, DEFAULT_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE, pending: DEFAULT_MODE })
  })

  it('drops a no-op set (target equals pending, else the current fold)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, DEFAULT_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
    ctx.modes.set(agent, PLAN_MODE)
    ctx.modes.set(agent, PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
  })

  it('seeds the initial mode from AgentOptions.mode on agent/created', async () => {
    const ctx = await setup()
    const agent = agentWithSession('seeded', { mode: PLAN_MODE })
    ctx.emit('agent/created', agent)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
    const bare = agentWithSession('unseeded')
    ctx.emit('agent/created', bare)
    expect(ctx.modes.get(bare)).toEqual({ current: DEFAULT_MODE })
  })
})

describe('the boundary flush', () => {
  it('flushes the pending intent as a mode/set at turn/start', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
  })

  it('flushes at step/end too (a mid-turn flip lands on the following step)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('nets out a flip sequence that returns to the folded mode (no append, no notice)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    ctx.modes.set(agent, DEFAULT_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(agent.session.events.some(event => event.type === 'mode/set')).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates nothing before the first request header (the section is the state statement)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates once when the flushed mode differs from what the last header told the model', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    header(agent.session)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
    await boundary(ctx, agent, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
  })

  it('narrates a switch back to the default mode with the default wording', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    ctx.modes.set(agent, DEFAULT_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session back to the default mode.'])
  })

  it('stays silent when the header already reflects the flushed mode', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    agent.session.append('mode/set', { mode: DEFAULT_MODE })
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates a folded mode the config no longer defines, once, at turn starts', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'retired' })
    await boundary(ctx, agent, 'turn/start')
    await boundary(ctx, agent, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual([
      'Mode "retired" is no longer defined in this deployment\'s configuration; the session continues in the default mode.',
    ])
    await boundary(ctx, agent, 'step/end')
    expect(noticeTexts(agent.session)).toHaveLength(1)
  })

  it('contains an append failure instead of blocking the prompt or the turn', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const original = agent.session.append.bind(agent.session)
    // Only the flush's own mode/set append fails; the boundary event itself
    // lands (the loop appended it before the seam fires).
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'mode/set') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append
    await boundary(ctx, agent, 'step/end')
    expect(warn).toHaveBeenCalledOnce()
    // The failed flush re-parks the intent (cleared only after a landed
    // append), so the next healthy boundary converges the log with the
    // picker's optimistic state instead of dropping the switch forever.
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
    agent.session.append = original
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent).pending).toBeUndefined()
  })

  it('contains an append failure on the prompt-submit seam the same way', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const original = agent.session.append.bind(agent.session)
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'mode/set') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append
    await boundary(ctx, agent, 'turn/start')
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
  })
})

describe('the soft layer', () => {
  it('keeps a default-mode assembly identical to a no-dsh-mode deployment (exit tool dropped)', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('')
  })

  it('leaves an agent-less assembly untouched', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('')
  })

  it('keeps the full toolset in plan mode, adds the exit tool, and renders the mode section', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'todo_write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'todo_write', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toContain('plan mode')
  })

  it('drops exit_plan_mode outside plan mode (custom modes never see it)', async () => {
    const ctx = await setup({ modes: { review: { section: 'reviewing' } } })
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'review' })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('reviewing')
  })

  it('leaves foreign post-next() additions alone in plan mode (no general tool filtering)', async () => {
    // A foreign listener that post-processes await next(): the mode filter
    // wraps outside it (prepend) but hides only the exit tool outside plan
    // and the bash trio under an unhonorable cap — a foreign addition
    // survives, because which tools a mode admits is deliberately not this
    // plugin's decision (the effects question stays parked; module doc).
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const final = await next()
      final.tools = [...final.tools, { name: 'added-later', description: 'added after next()', parameters: {} }]
      return final
    })
    await ctx.plugin(ModesService)
    registerNamedTools(ctx, ['read'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'added-later'])
  })

  it('keeps run_code the only wire tool in plan mode under the registry Code Mode; the SDK gains the exit binding', async () => {
    // Minimal scriptable runtime: the SDK section resolves ctx.codeRuntime at
    // assembly time (the code-mode.spec fake's shape).
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry, { mode: 'code' })
    await ctx.plugin(FakeRuntime)
    await ctx.plugin(ModesService)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    // The SDK documents the full binding set plus the exit — plan mode no
    // longer prunes capabilities; its restraint is the section + the sandbox.
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('read(args:')
    expect(sdk).toContain('write(args:')
    expect(sdk).toContain('exit_plan_mode(args:')
  })

  it('keeps native wire schemas and the SDK in step under mode both', async () => {
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry, { mode: 'both' })
    await ctx.plugin(FakeRuntime)
    await ctx.plugin(ModesService)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    // ONE visibility rule covers both surfaces: in plan the exit tool is
    // present on the wire AND in the SDK, alongside the untouched toolset.
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['exit_plan_mode', 'read', 'run_code', 'write'])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('read(args:')
    expect(sdk).toContain('write(args:')
    expect(sdk).toContain('exit_plan_mode(args:')
  })

  it('default-mode Code Mode SDK is byte-identical to a no-dsh-mode deployment (exit binding hidden)', async () => {
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const withModes = new Context()
    await withModes.plugin(SystemPrompt)
    await withModes.plugin(ToolRegistry, { mode: 'code' })
    await withModes.plugin(FakeRuntime)
    await withModes.plugin(ModesService)
    registerNamedTools(withModes, ['read', 'write'])
    const agent = agentWithSession()
    const sdk = (await withModes.systemPrompt.assemble({ agent })).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('read(args:')
    expect(sdk).toContain('write(args:')
    // The always-registered exit tool is callable only in plan mode, so a
    // default-mode SDK advertising it would offer a binding that can only
    // error — and diverge from a deployment that never loaded dsh-mode:
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRegistry, { mode: 'code' })
    await bare.plugin(FakeRuntime)
    registerNamedTools(bare, ['read', 'write'])
    const bareSdk = (await bare.systemPrompt.assemble({ agent })).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toBe(bareSdk)
    expect(sdk).not.toContain('exit_plan_mode(args:')
  })

  it('treats a dropped folded definition as the default mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'retired' })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'write'])
  })
})

describe('the hard layer', () => {
  it('passes agent-less and default-mode executions through', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agentless = await execute(ctx, 'write')
    expect(agentless.isError).toBe(false)
    const agent = agentWithSession()
    const defaulted = await execute(ctx, 'write', agent)
    expect(defaulted.isError).toBe(false)
  })

  it('runs non-shell calls in plan mode untouched — restraint outside the shell is the section, not a gate', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const reading = await execute(ctx, 'read', agent)
    expect(reading.isError).toBe(false)
    const writing = await execute(ctx, 'write', agent)
    expect(writing.isError).toBe(false)
  })

  it('judges by the logged mode only — a pending plan intent neither gates nor clamps', async () => {
    const ctx = await setup()
    await ctx.plugin(FakeSandboxExecutor, { mode: 'workspace-write' })
    registerNamedTools(ctx, ['write'])
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const result = await execute(ctx, 'write', agent)
    expect(result.isError).toBe(false)
    expect(await ctx.bash.resolveMode(agent.session)).toBe('workspace-write')
  })

  it('treats a dropped folded definition as the default mode (no clamp, no guard)', async () => {
    const ctx = await setup()
    await ctx.plugin(FakeSandboxExecutor, { mode: 'workspace-write' })
    registerNamedTools(ctx, ['write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'retired' })
    const result = await execute(ctx, 'write', agent)
    expect(result.isError).toBe(false)
    expect(await ctx.bash.resolveMode(agent.session)).toBe('workspace-write')
  })
})

describe('exit_plan_mode', () => {
  async function setupWithReview(answer?: { selected: string[]; custom?: string }) {
    const ctx = await setup()
    await ctx.plugin(UserInteractionService)
    const asked: AskUserQuestionRequest[] = []
    if (answer !== undefined) {
      ctx.userInteraction.registerProvider({
        ask: (request) => {
          asked.push(request)
          return Promise.resolve({ answers: [{ id: 'plan-review', ...answer }] })
        },
      })
    }
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    return { ctx, agent, asked }
  }

  function callExit(ctx: Context, agent: Agent | undefined, plan = '# The plan\n\ndo things') {
    return ctx.tools.execute({
      callId: CallId(`call-exit-${++callCounter}`),
      name: EXIT_PLAN_MODE,
      arguments: { plan },
      ...agent ? { agent } : {},
    })
  }

  it('registers the tool with one required plan argument', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === EXIT_PLAN_MODE)
    const parameters = schema?.parameters as { required?: string[]; properties?: Record<string, unknown> }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['plan'])
    expect(parameters.required).toEqual(['plan'])
  })

  it('rejects an agent-less call', async () => {
    const ctx = await setup()
    const result = await callExit(ctx, undefined)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode requires a calling agent (no session to switch)' }])
  })

  it('rejects a call outside plan mode (defense in depth behind the gate)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode is only available in plan mode' }])
  })

  it('degrades to the manual exit when no user-interaction seam is composed', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: no user-interaction channel is available to review the plan; ask the user to switch the session mode instead' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('degrades the same way when the seam has no provider (NO_PROVIDER)', async () => {
    const { ctx, agent } = await setupWithReview()
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: no user-interaction provider is registered' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('approve: records the boundary-applied switch and confirms (the fold flips at the flush)', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }])
    // Boundary-applied, not a direct append: the fold stays plan until the
    // step's end, so the plan policy covers any remaining call of the SAME batch.
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE, pending: DEFAULT_MODE })
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.agent).toBe(agent)
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep planning'])
  })

  it('an approved exit keeps the plan clamp until the boundary (same-batch policy holds)', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    await ctx.plugin(FakeSandboxExecutor, { mode: 'workspace-write' })
    const approved = await callExit(ctx, agent)
    expect(approved.isError).toBe(false)
    // A bash call of the SAME assistant response (no boundary between) was
    // requested under the plan-shaped header — the read-only clamp must
    // still hold for it; the boundary flush is what widens the next step.
    expect(await ctx.bash.resolveMode(agent.session)).toBe('read-only')
    await boundary(ctx, agent, 'step/end')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('workspace-write')
  })

  it('the exit flush narrates nothing — the tool result is the narration', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    header(agent.session)
    await callExit(ctx, agent)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('approve with a note carries the note into the confirmation', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'], custom: 'ship it small' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step. User note: ship it small' }])
  })

  it('keep planning returns the corrective error carrying the feedback verbatim', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Keep planning'], custom: 'consider the resume path' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: consider the resume path' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('keep planning without feedback returns the generic corrective error', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Keep planning'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
  })

  it('a custom-text-only answer is feedback, never consent', async () => {
    const { ctx, agent } = await setupWithReview({ selected: [], custom: 'add tests first' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: add tests first' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('a missing answer item reads as keep-planning', async () => {
    const { ctx, agent } = await setupWithReview()
    ctx.userInteraction.registerProvider({ ask: () => Promise.resolve({ answers: [] }) })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
  })

  it('forwards the execution abort signal to the review question', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    const controller = new AbortController()
    const result = await ctx.tools.execute({
      callId: CallId(`call-exit-${++callCounter}`),
      name: EXIT_PLAN_MODE,
      arguments: { plan: '# P' },
      agent,
      signal: controller.signal,
    })
    expect(result.isError).toBe(false)
    expect(asked[0]?.signal).toBe(controller.signal)
  })

  it('a throwing provider surfaces as the corrective isError and the mode stays plan', async () => {
    const { ctx, agent } = await setupWithReview()
    ctx.userInteraction.registerProvider({ ask: () => { throw new Error('review aborted') } })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: review aborted' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('presents the call as a generic card titled by the plan first heading', async () => {
    const ctx = await setup()
    const def = ctx.tools.get(EXIT_PLAN_MODE)!
    expect(def.presentCall?.({ plan: '## Fix the flake\n\nsteps' })).toEqual({
      card: 'generic',
      title: 'Fix the flake',
      kind: 'other',
      content: [{ type: 'text', text: '## Fix the flake\n\nsteps' }],
    })
    expect(def.presentCall?.({ plan: 'no heading here' })).toEqual({
      card: 'generic',
      title: 'Plan',
      kind: 'other',
      content: [{ type: 'text', text: 'no heading here' }],
    })
  })

  it('presents the result as a generic review card', async () => {
    const ctx = await setup()
    const def = ctx.tools.get(EXIT_PLAN_MODE)!
    const content = [{ type: 'text' as const, text: 'ok' }]
    expect(def.presentResult?.({ plan: '# P' }, { content, isError: false })).toEqual({
      card: 'generic',
      title: 'Plan review',
      content,
    })
  })
})

/**
 * A minimal confining executor for the access-cap tests: only `sandboxMode`
 * (the capability fact both policy layers and `resolveMode` read) matters;
 * the process API is never exercised here.
 */
class FakeSandboxExecutor extends BashExecutor {
  constructor(ctx: Context, private readonly config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access' } = {}) {
    super(ctx)
  }

  override get sandboxMode() {
    return this.config.mode
  }

  resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: '/w',
      timeoutMs: 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1000,
      sandboxMode: request.sandboxMode,
    }
  }

  run(_spec: BashExecSpec): Promise<BashRunResult> {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  start(_spec: BashExecSpec): BashProcess { throw new Error('unused in access-cap tests') }
}

describe('the access cap (bash/resolve-mode clamp)', () => {
  async function sandboxSetup(mode: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined, config?: ModeConfig): Promise<Context> {
    const ctx = await setup(config)
    await ctx.plugin(FakeSandboxExecutor, mode !== undefined ? { mode } : {})
    return ctx
  }

  it('clamps the plan-mode resolution to read-only over a wider knob and default', async () => {
    const ctx = await sandboxSetup('workspace-write')
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    expect(await ctx.bash.resolveMode(agent.session)).toBe('read-only')
    setSandboxMode(agent.session, 'danger-full-access')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('read-only')
  })

  it('leaves the default-mode resolution alone (knob ?? executor default)', async () => {
    const ctx = await sandboxSetup('workspace-write')
    const agent = agentWithSession()
    expect(await ctx.bash.resolveMode(agent.session)).toBe('workspace-write')
    setSandboxMode(agent.session, 'danger-full-access')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('danger-full-access')
  })

  it('is a min, not a replace: a knob narrower than the cap stays', async () => {
    const ctx = await sandboxSetup('danger-full-access', { modes: { locked: { section: 's', access: 'workspace-write' } } })
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'locked' })
    expect(await ctx.bash.resolveMode(agent.session)).toBe('workspace-write')
    setSandboxMode(agent.session, 'read-only')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('read-only')
  })

  it('a mode without access leaves the resolution alone', async () => {
    const ctx = await sandboxSetup('read-only', { modes: { review: { section: 's' } } })
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'review' })
    setSandboxMode(agent.session, 'danger-full-access')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('danger-full-access')
  })

  it('a sessionless resolution passes through the clamp untouched', async () => {
    const ctx = await sandboxSetup('workspace-write')
    expect(await ctx.bash.resolveMode(undefined)).toBe('workspace-write')
  })

  it('orthogonality: the knob set during plan is capped, then re-emerges intact on exit', async () => {
    const ctx = await sandboxSetup('workspace-write')
    const agent = agentWithSession()
    // Enter plan, then flip the knob mid-mode: the cap holds it down…
    agent.session.append('mode/set', { mode: PLAN_MODE })
    setSandboxMode(agent.session, 'danger-full-access')
    expect(await ctx.bash.resolveMode(agent.session)).toBe('read-only')
    // …and leaving plan uncovers the standing knob, unwritten by the cap.
    agent.session.append('mode/set', { mode: DEFAULT_MODE })
    expect(await ctx.bash.resolveMode(agent.session)).toBe('danger-full-access')
  })
})

describe('the bash tool under an access cap', () => {
  it('exposes and admits bash — and leaves the generic task controls alone — under a confining executor', async () => {
    const ctx = await setup()
    await ctx.plugin(FakeSandboxExecutor, { mode: 'workspace-write' })
    registerNamedTools(ctx, ['read', 'write', 'bash', 'task_output', 'task_kill'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['bash', EXIT_PLAN_MODE, 'read', 'task_kill', 'task_output', 'write'])
    for (const name of ['bash', 'task_output', 'task_kill']) {
      const result = await execute(ctx, name, agent)
      expect(result.isError).toBe(false)
    }
  })

  it('hides and denies bash in plan mode without any executor; the kind-generic task controls stay', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'bash', 'task_output', 'task_kill'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    // task_output/task_kill span every task kind (subagents included), so the
    // cap withholds only the starter it can reason about.
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'task_kill', 'task_output'])
    const denied = await execute(ctx, 'bash', agent)
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{
      type: 'text',
      text: 'Error: tool "bash" is not available in plan mode: its read-only sandbox cap needs a sandboxing bash executor, and none is mounted',
    }])
  })

  it('hides and denies bash in plan mode under a never-confining executor', async () => {
    const ctx = await setup()
    await ctx.plugin(FakeSandboxExecutor, {})
    registerNamedTools(ctx, ['read', 'bash'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read'])
    const denied = await execute(ctx, 'bash', agent)
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{
      type: 'text',
      text: 'Error: tool "bash" is not available in plan mode: its read-only sandbox cap needs a sandboxing bash executor, and none is mounted',
    }])
  })

  it('denies a bash call carrying sandbox_permissions under the cap (no widening mid-mode)', async () => {
    const ctx = await setup()
    await ctx.plugin(FakeSandboxExecutor, { mode: 'workspace-write' })
    registerNamedTools(ctx, ['bash'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const denied = await ctx.tools.execute({
      callId: CallId(`call-${++callCounter}`),
      name: 'bash',
      arguments: { command: 'rm -rf x', description: 'd', sandbox_permissions: 'workspace-write', justification: 'j' },
      agent,
    })
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{
      type: 'text',
      text: 'Error: sandbox escalation is not available in plan mode — the sandbox stays read-only while it is in force; put the wider-access step in the plan for after approval',
    }])
    // The same command WITHOUT the escalation fields passes the gate.
    const plain = await ctx.tools.execute({
      callId: CallId(`call-${++callCounter}`),
      name: 'bash',
      arguments: { command: 'ls', description: 'd' },
      agent,
    })
    expect(plain.isError).toBe(false)
  })

  it('a mode without access exposes bash regardless of the executor (explicit deployment choice)', async () => {
    const ctx = await setup({ modes: { shell: { section: 's' } } })
    registerNamedTools(ctx, ['bash'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'shell' })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['bash'])
    const result = await execute(ctx, 'bash', agent)
    expect(result.isError).toBe(false)
  })
})
