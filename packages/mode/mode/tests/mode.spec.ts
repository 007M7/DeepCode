import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent, type RequestErrorDecision } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import UserInteractionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-interaction'
import CommandService from '@deepseek-ai/dsh-commands'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ModesService, { DEFAULT_MODE, EXIT_PLAN_MODE, PLAN_MODE, foldMode, resolveConfig } from '../src/index.ts'
import type { ModeConfig } from '../src/index.ts'

const TEST_PLAN_SECTION = 'Test plan mode instructions.'
const PLAN_CONFIG = { modes: { plan: { section: TEST_PLAN_SECTION } } } satisfies ModeConfig

/**
 * Drives the REAL plugin: mounts `dsh-mode` beside real `SystemPrompt` and
 * `ToolRegistry` services, with fake Agents carrying real `Session`s and a
 * real scoped `agent.ctx` minted through `createScope`.
 * Turn boundaries are simulated by appending the real boundary events and
 * dispatching the interception seams the loop fires there. Recovery retries
 * exercise the separate `agent/request-error` wrapper.
 */

async function agentWithSession(ctx: Context, id = 'agent-1', { mode }: { mode?: string } = {}): Promise<Agent & { session: Session }> {
  const session = new Session(SessionId(id))
  const agent = { id: SessionId(id), session, options: {} } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  // A seeded mode lands before the creation announcement, matching resume.
  if (mode !== undefined) session.append('mode/set', { mode })
  // The loop announces creation after publication.
  ctx.emit('agent/created', agent)
  return agent
}

/** Assemble exactly as the loop does: the agent is both subject and scope. */
function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}

async function setup(config: ModeConfig = PLAN_CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(ModesService, config)
  return ctx
}

/**
 * Append a boundary event and dispatch the interception seam the loop fires
 * there — `agent/prompt-submit` inside the just-opened turn,
 * `agent/turn-continuation` after the step closed. Recovery retries use the
 * separately covered `agent/request-error` wrapper; post-commit
 * `session/event` observers remain observe-only.
 */
async function boundary(ctx: Context, agent: Agent & { session: Session }, type: 'turn/start' | 'step/end'): Promise<void> {
  const events = agentEvents(ctx, agent)
  if (type === 'turn/start') {
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await events.waterfall('agent/prompt-submit', [{ type: 'text', text: 'boundary probe' }], { kind: 'user' }, new AbortController().signal, () => Promise.resolve({ kind: 'allow' }))
    return
  }
  agent.session.append('step/end', { turn: 1, step: 1 })
  await events.waterfall('agent/turn-continuation', 1, { action: 'stop' }, new AbortController().signal, () => Promise.resolve({ action: 'stop' }))
}

/** Dispatch the closed-step recovery seam with one terminal decision. */
function recoveryBoundary(
  ctx: Context,
  agent: Agent & { session: Session },
  decision: RequestErrorDecision,
): Promise<RequestErrorDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/request-error',
    1,
    1,
    new Error('request failed'),
    { message: 'request failed', code: 'SERVER' },
    [],
    new AbortController().signal,
    () => Promise.resolve(decision),
  )
}

/** Append a minimal `request/header` snapshot so the log has a "what the model was told" anchor. */
function header(session: Session): void {
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
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
    signal: new AbortController().signal,
    ...agent ? { agent } : {},
  })
}

describe('resolveConfig', () => {
  it('requires the deployment to configure the plan instructions', () => {
    expect(() => resolveConfig({ modes: {} }))
      .toThrow('mode "plan" is required; put its model instructions in modes.plan.section')
    expect(() => resolveConfig({} as ModeConfig))
      .toThrow('mode "plan" is required; put its model instructions in modes.plan.section')
  })

  it('loads the configured plan instructions and further modes verbatim', () => {
    const resolved = resolveConfig({ modes: {
      plan: { section: TEST_PLAN_SECTION },
      review: { section: 'review' },
    } })
    expect(resolved.definitions.get(PLAN_MODE)).toEqual({ section: TEST_PLAN_SECTION })
    expect(resolved.definitions.get('review')).toEqual({ section: 'review' })
  })

  it('rejects the reserved default key loudly', () => {
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, default: { section: 'policy' } } }))
      .toThrow('"default" is reserved')
  })

  it('rejects an empty or untrimmed mode name loudly (the invariant would reject its selection)', () => {
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, '': { section: 'x' } } }))
      .toThrow('mode name "" must be non-empty and trimmed')
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, ' review ': { section: 'x' } } }))
      .toThrow('mode name " review " must be non-empty and trimmed')
  })

  it('rejects a malformed definition loudly', () => {
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, bad: { section: 5 } as unknown as { section: string } } }))
      .toThrow('needs a string `section`')
    expect(() => resolveConfig({ modes: { plan: { section: '   ' } } }))
      .toThrow('needs a non-empty `section`')
    // Unknown keys fail loud — a tool allow/deny list and enforcement knobs
    // are deliberately not part of the vocabulary, and a config still
    // carrying one must not be silently accepted as if it shaped anything.
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, bad: { section: 'bad', tools: ['read'] } as unknown as { section: string } } }))
      .toThrow('unknown key(s) tools — a definition is { section }')
    expect(() => resolveConfig({ modes: { ...PLAN_CONFIG.modes, bad: { section: 'bad', access: 'read-only' } as unknown as { section: string } } }))
      .toThrow('unknown key(s) access — a definition is { section }')
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
    const ctx = await setup({ modes: { ...PLAN_CONFIG.modes, review: { section: 's' } } })
    expect(ctx.modes.list()).toEqual([DEFAULT_MODE, PLAN_MODE, 'review'])
  })

  it('reads the folded mode, mapping a dropped definition to default', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
    agent.session.append('mode/set', { mode: PLAN_MODE })
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
    agent.session.append('mode/set', { mode: 'retired' })
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
  })

  it('rejects an unknown mode name loudly, naming the vocabulary', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(() => { ctx.modes.set(agent, 'nope') }).toThrow('unknown mode "nope" — available modes: default, plan')
  })

  it('accepts default as a target (exit-to-default is a valid write)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('mode/set', { mode: PLAN_MODE })
    ctx.modes.set(agent, DEFAULT_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE, pending: DEFAULT_MODE })
  })

  it('drops a no-op set (target equals pending, else the current fold)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, DEFAULT_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE })
    ctx.modes.set(agent, PLAN_MODE)
    ctx.modes.set(agent, PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
  })

})

describe('the boundary flush', () => {
  it('flushes the pending intent as a mode/set at turn/start', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
  })

  it('flushes a set() that arrives while a downstream listener is still awaiting (post-next ordering)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    // A downstream async listener (the shipped hooks listeners' shape): the
    // selection lands DURING its await — after this boundary began, before it
    // returns. The prepended flush runs after next(), so the mode/set still
    // precedes the request this boundary gates.
    ctx.on('agent/turn-continuation', async (_agent, _turn, decision, _signal, next) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      ctx.modes.set(agent, PLAN_MODE)
      await next()
      return decision
    })
    agent.session.append('step/end', { turn: 1, step: 1 })
    await agentEvents(ctx, agent).waterfall(
      'agent/turn-continuation', 1, { action: 'stop' }, new AbortController().signal,
      () => Promise.resolve({ action: 'stop' }),
    )
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
  })

  it('flushes at step/end too (a mid-turn flip lands on the following step)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('keeps the pending intent parked when recovery does not retry', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    expect(await recoveryBoundary(ctx, agent, { action: 'fail' })).toEqual({ action: 'fail' })
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
  })

  it('contains an append failure at the retry boundary without changing its decision', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    const original = agent.session.append.bind(agent.session)
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'mode/set') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append

    expect(await recoveryBoundary(ctx, agent, { action: 'retry' })).toEqual({ action: 'retry' })
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
  })

  it('nets out a flip sequence that returns to the folded mode (no append, no notice)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    ctx.modes.set(agent, DEFAULT_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(agent.session.events.some(event => event.type === 'mode/set')).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates nothing before the first request header (the section is the state statement)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates once when the flushed mode differs from what the last header told the model', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    header(agent.session)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
    await boundary(ctx, agent, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
  })

  it('narrates a switch back to the default mode with the default wording', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    ctx.modes.set(agent, DEFAULT_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session back to the default mode.'])
  })

  it('stays silent when the header already reflects the flushed mode', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    agent.session.append('mode/set', { mode: DEFAULT_MODE })
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
  })


  it('contains an append failure instead of blocking the prompt or the turn', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
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
    const agent = await agentWithSession(ctx)
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
  it('keeps the tool schemas identical across default and plan mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx)
    const defaultAssembly = await assembleFor(ctx, agent)
    expect(defaultAssembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read', 'write'])
    expect(defaultAssembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('')

    agent.session.append('mode/set', { mode: PLAN_MODE })
    const planAssembly = await assembleFor(ctx, agent)
    expect(planAssembly.tools).toEqual(defaultAssembly.tools)
    expect(planAssembly.sections.find(section => section.name === 'mode:policy')?.text).toBe(TEST_PLAN_SECTION)
  })

  it('leaves an agent-less assembly untouched', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('')
  })

  it('keeps the full toolset in plan mode and renders the configured mode section', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'todo_write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'todo_write', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe(TEST_PLAN_SECTION)
  })

  it('keeps exit_plan_mode visible in custom modes while rendering their guidance', async () => {
    const ctx = await setup({ modes: { ...PLAN_CONFIG.modes, review: { section: 'reviewing' } } })
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: 'review' })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('reviewing')
  })

  it('leaves foreign assemble additions alone in any mode (no assemble-layer filtering at all)', async () => {
    // Modes do not filter the deployment's registry or later assembly additions.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const final = await next()
      final.tools = [...final.tools, { name: 'added-later', description: 'added after next()', parameters: {} }]
      return final
    })
    await ctx.plugin(ModesService, PLAN_CONFIG)
    registerNamedTools(ctx, ['read'])
    const planning = await agentWithSession(ctx, 'planning', { mode: PLAN_MODE })
    expect((await assembleFor(ctx, planning)).tools.map(tool => tool.name))
      .toEqual(['exit_plan_mode', 'read', 'added-later'])
    const defaulted = await agentWithSession(ctx, 'defaulted')
    expect((await assembleFor(ctx, defaulted)).tools.map(tool => tool.name))
      .toEqual(['exit_plan_mode', 'read', 'added-later'])
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
    await ctx.plugin(ModesService, PLAN_CONFIG)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    // The SDK documents the full binding set plus the exit — a mode never
    // prunes capabilities; it restrains by the section's guidance alone.
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
    await ctx.plugin(ModesService, PLAN_CONFIG)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const assembly = await assembleFor(ctx, agent)
    // The stable registry contribution reaches both surfaces: the exit tool
    // is present on the wire AND in the SDK alongside the untouched toolset.
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['exit_plan_mode', 'read', 'run_code', 'write'])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('read(args:')
    expect(sdk).toContain('write(args:')
    expect(sdk).toContain('exit_plan_mode(args:')
  })

  it('keeps the Code Mode SDK byte-identical across mode switches', async () => {
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const withModes = new Context()
    await withModes.plugin(SystemPrompt)
    await withModes.plugin(ToolRegistry, { mode: 'code' })
    await withModes.plugin(FakeRuntime)
    await withModes.plugin(ModesService, PLAN_CONFIG)
    registerNamedTools(withModes, ['read', 'write'])
    const agent = await agentWithSession(withModes)
    const defaultSdk = (await assembleFor(withModes, agent)).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(defaultSdk).toContain('read(args:')
    expect(defaultSdk).toContain('write(args:')
    expect(defaultSdk).toContain('exit_plan_mode(args:')
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const planSdk = (await assembleFor(withModes, agent)).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(planSdk).toBe(defaultSdk)

    // Loading the mode plugin deliberately adds one stable binding compared
    // with a deployment that does not compose plan mode at all.
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRegistry, { mode: 'code' })
    await bare.plugin(FakeRuntime)
    registerNamedTools(bare, ['read', 'write'])
    const bareSdk = (await bare.systemPrompt.assemble({ agent })).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(bareSdk).not.toContain('exit_plan_mode(args:')
    expect(defaultSdk).not.toBe(bareSdk)
  })

  it('treats a dropped folded definition as the default mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: 'retired' })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read', 'write'])
  })
})

describe('no execution gating beyond the exit tool', () => {
  it('passes agent-less and default-mode executions through', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agentless = await execute(ctx, 'write')
    expect(agentless.isError).toBe(false)
    const agent = await agentWithSession(ctx)
    const defaulted = await execute(ctx, 'write', agent)
    expect(defaulted.isError).toBe(false)
  })

  it('runs every call in plan mode untouched — modes restrain by guidance, enforcement knobs are separate axes', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'bash'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    for (const name of ['read', 'write', 'bash']) {
      const result = await execute(ctx, name, agent)
      expect(result.isError).toBe(false)
    }
  })

  it('treats a dropped folded definition as the default mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: 'retired' })
    const result = await execute(ctx, 'write', agent)
    expect(result.isError).toBe(false)
  })

})

describe('the /mode command', () => {
  it('registers only when a commands service is composed, and shows or switches the mode', async () => {
    const bare = await setup()
    expect(bare.get('commands')).toBeUndefined()

    const ctx = await setup()
    await ctx.plugin(CommandService)
    // The `ctx.inject` child mounts asynchronously once `commands` resolves.
    await new Promise(resolve => setImmediate(resolve))
    const agent = await agentWithSession(ctx)
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['mode'])

    const signal = new AbortController().signal
    const show = await ctx.commands.execute(agent, '/mode', signal)
    expect(show).toEqual({ kind: 'success', text: 'mode: default — available: default, plan' })

    const flip = await ctx.commands.execute(agent, '/mode plan', signal)
    expect(flip).toEqual({ kind: 'success', text: 'mode → plan (applies from the next turn)' })
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
    const pendingShow = await ctx.commands.execute(agent, '/mode', signal)
    expect(pendingShow).toEqual({ kind: 'success', text: 'mode: default (pending: plan) — available: default, plan' })

    const unknown = await ctx.commands.execute(agent, '/mode nope', signal)
    expect(unknown).toEqual({ kind: 'error', text: 'unknown mode "nope" — available modes: default, plan' })
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
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    return { ctx, agent, asked }
  }

  function callExit(ctx: Context, agent: Agent | undefined, plan = '# The plan\n\ndo things') {
    return ctx.tools.execute({
      callId: CallId(`call-exit-${++callCounter}`),
      name: EXIT_PLAN_MODE,
      arguments: { plan },
      signal: new AbortController().signal,
      ...agent ? { agent } : {},
    })
  }

  it('registers the tool with one required plan argument', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === EXIT_PLAN_MODE)
    const parameters = schema?.parameters as { required?: string[]; properties?: Record<string, unknown> }
    expect(schema?.description).toMatch(/^Use only in plan mode\./)
    expect(Object.keys(parameters.properties ?? {})).toEqual(['plan'])
    expect(parameters.required).toEqual(['plan'])
  })

  it('rejects an agent-less call', async () => {
    const ctx = await setup()
    const result = await callExit(ctx, undefined)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode requires a calling agent (no session to switch)' }])
  })

  it('rejects a call outside plan mode while remaining advertised', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain(EXIT_PLAN_MODE)
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode is only available in plan mode' }])
  })

  it('rejects an empty or heading-less plan before asking the reviewer', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    for (const plan of ['', 'do things']) {
      const result = await callExit(ctx, agent, plan)
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode requires a non-empty markdown plan starting with a # heading' }])
    }
    expect(asked).toHaveLength(0)
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('degrades to the manual exit when no user-interaction seam is composed', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
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
    expect(asked[0]?.questions[0]?.detail).toBe('# The plan\n\ndo things')
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep planning'])
  })

  it('carries the exact plan through a Code Mode review and logs the nested dispatch', async () => {
    const plan = '# Code Mode plan\n\nUse the existing seam.'
    class ExitRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      async run(request: CodeRunRequest): Promise<CodeRunResult> {
        const exit = request.bindings[0]?.functions[EXIT_PLAN_MODE]
        if (exit === undefined) throw new Error('missing exit_plan_mode binding')
        return { logs: [], value: await exit({ plan }) }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry, { mode: 'code' })
    await ctx.plugin(ExitRuntime)
    await ctx.plugin(ModesService, PLAN_CONFIG)
    await ctx.plugin(UserInteractionService)
    const asked: AskUserQuestionRequest[] = []
    ctx.userInteraction.registerProvider({
      ask: (request) => {
        asked.push(request)
        return Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
      },
    })
    const agent = await agentWithSession(ctx, 'code-mode-exit', { mode: PLAN_MODE })

    const result = await ctx.tools.execute({
      callId: CallId(`call-exit-${++callCounter}`),
      name: RUN_CODE_NAME,
      arguments: { code: `return await tools.${EXIT_PLAN_MODE}({ plan: ${JSON.stringify(plan)} })` },
      signal: new AbortController().signal,
      agent,
    })

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.questions[0]).toMatchObject({
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: plan,
    })
    expect(agent.session.events.find(event => event.type === 'tool/code-dispatch')?.data).toMatchObject({
      name: EXIT_PLAN_MODE,
      arguments: { plan },
      isError: false,
    })
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE, pending: DEFAULT_MODE })
  })

  it('an approved exit keeps plan guidance until the boundary and never removes the tool', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    const approved = await callExit(ctx, agent)
    expect(approved.isError).toBe(false)
    // Calls of the SAME assistant response (no boundary between) were
    // requested under the plan-shaped header — the fold stays plan for that
    // whole batch; the boundary flush is what flips the next step.
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.some(tool => tool.name === EXIT_PLAN_MODE)).toBe(true)
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe(TEST_PLAN_SECTION)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    const afterExit = await ctx.systemPrompt.assemble({ agent })
    expect(afterExit.tools).toEqual(assembly.tools)
    expect(afterExit.sections.find(section => section.name === 'mode:policy')?.text).toBe('')
  })

  it('the exit flush narrates nothing — the tool result is the narration', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    header(agent.session)
    await callExit(ctx, agent)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
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

  it('requires exactly the single Approve selection', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve', 'Keep planning'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('treats custom text alongside Approve as feedback, not consent', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'], custom: 'change the tests' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: change the tests' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('treats duplicate review answer items as non-consent', async () => {
    const { ctx, agent } = await setupWithReview()
    ctx.userInteraction.registerProvider({
      ask: () => Promise.resolve({ answers: [
        { id: 'plan-review', selected: ['Approve'] },
        { id: 'plan-review', selected: ['Keep planning'] },
      ] }),
    })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
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

  it('fails the call when the plugin is disposed while the review awaits (no phantom exit)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const fiber = await ctx.plugin(ModesService, PLAN_CONFIG)
    await ctx.plugin(UserInteractionService)
    let answer!: (value: { answers: { id: string; selected: string[] }[] }) => void
    ctx.userInteraction.registerProvider({
      ask: () => new Promise((resolve) => { answer = resolve }),
    })
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const pending = callExit(ctx, agent)
    // Let execute reach the review await, then unload the plugin (HMR) and
    // only afterwards approve. The boundary listeners are gone, so a success
    // would claim an exit that can never flush — the call must fail instead.
    await new Promise(resolve => setImmediate(resolve))
    await fiber.dispose()
    answer({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: the mode service was reloaded while the plan was under review; present the plan again' }])
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
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

describe('HMR disposal', () => {
  it('does not flush a retry boundary that resumes after plugin disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const fiber = await ctx.plugin(ModesService, PLAN_CONFIG)
    const agent = await agentWithSession(ctx, 'disposed-in-flight-recovery')
    const recoveryEntered = Promise.withResolvers<true>()
    const releaseRecovery = Promise.withResolvers<true>()
    ctx.on('agent/request-error', async (_agent, _turn, _step, _error, _failure, _history, _signal, _next) => {
      recoveryEntered.resolve(true)
      await releaseRecovery.promise
      return { action: 'retry' }
    })
    ctx.modes.set(agent, PLAN_MODE)

    const recovery = recoveryBoundary(ctx, agent, { action: 'fail' })
    await recoveryEntered.promise
    await fiber.dispose()
    releaseRecovery.resolve(true)

    expect(await recovery).toEqual({ action: 'retry' })
    expect(agent.session.events.some(event => event.type === 'mode/set')).toBe(false)
  })

  it('unregisters the service, listeners, prompt section, and stable exit tool with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const fiber = await ctx.plugin(ModesService, PLAN_CONFIG)
    const agent = await agentWithSession(ctx, 'disposed-recovery')
    ctx.modes.set(agent, PLAN_MODE)
    expect(ctx.get('modes')).toBeInstanceOf(ModesService)
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeDefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('mode:policy')

    await fiber.dispose()
    expect(ctx.get('modes')).toBeUndefined()
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('mode:policy')
    expect(await recoveryBoundary(ctx, agent, { action: 'retry' })).toEqual({ action: 'retry' })
    expect(agent.session.events.some(event => event.type === 'mode/set')).toBe(false)
  })
})
