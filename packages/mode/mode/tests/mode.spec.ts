import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import UserInteractionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-interaction'
import CommandService from '@deepseek-ai/dsh-commands'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ModesService, { DEFAULT_MODE, EXIT_PLAN_MODE, PLAN_MODE, foldMode, resolveConfig } from '../src/index.ts'
import type { ModeConfig } from '../src/index.ts'

/**
 * Drives the REAL plugin: mounts `dsh-mode` beside real `SystemPrompt` and
 * `ToolRegistry` services, with fake Agents carrying real `Session`s and a
 * real scoped `agent.ctx` (minted through `createScope`, the tool-skill test
 * shape) so the registry's scoped restriction layer is exercised for real.
 * Turn boundaries are simulated by appending the real boundary events and
 * dispatching the interception seams the loop fires there
 * (`agent/prompt-submit` / `agent/turn-continuation`) — exactly the seams the
 * flush (and the visibility reconcile) ride in production.
 */

async function agentWithSession(ctx: Context, id = 'agent-1', { mode }: { mode?: string } = {}): Promise<Agent & { session: Session }> {
  const session = new Session(SessionId(id))
  const agent = { id: SessionId(id), session, options: {} } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  // A seeded mode lands BEFORE the creation announcement — the resume shape:
  // the log already folds to the mode when the reconcile first runs.
  if (mode !== undefined) session.append('mode/set', { mode })
  // The loop announces creation after publication; the reconcile that seeds
  // the exit tool's visibility restriction rides that announcement.
  ctx.emit('agent/created', agent)
  return agent
}

/** Assemble exactly as the loop does: the agent is both subject and scope. */
function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
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
    ...agent ? { agent } : {},
  })
}

describe('resolveConfig', () => {
  it('merges the built-in plan definition: a guidance section, nothing else', () => {
    const resolved = resolveConfig({})
    const plan = resolved.definitions.get(PLAN_MODE)
    expect(plan).toEqual({ section: plan?.section })
    expect(plan?.section).toContain('plan mode')
  })

  it('lets config override plan and add further modes', () => {
    const resolved = resolveConfig({ modes: {
      plan: { section: 'custom plan' },
      review: { section: 'review' },
    } })
    expect(resolved.definitions.get(PLAN_MODE)).toEqual({ section: 'custom plan' })
    expect(resolved.definitions.get('review')).toEqual({ section: 'review' })
  })

  it('rejects the reserved default key loudly', () => {
    expect(() => resolveConfig({ modes: { default: { section: '' } } }))
      .toThrow('"default" is reserved')
  })

  it('rejects a malformed definition loudly', () => {
    expect(() => resolveConfig({ modes: { bad: { section: 5 } as unknown as { section: string } } }))
      .toThrow('needs a string `section`')
    // Unknown keys fail loud — a tool allow/deny list and enforcement knobs
    // are deliberately not part of the vocabulary, and a config still
    // carrying one must not be silently accepted as if it shaped anything.
    expect(() => resolveConfig({ modes: { bad: { section: '', tools: ['read'] } as unknown as { section: string } } }))
      .toThrow('unknown key(s) tools — a definition is { section }')
    expect(() => resolveConfig({ modes: { bad: { section: '', access: 'read-only' } as unknown as { section: string } } }))
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
    const ctx = await setup({ modes: { review: { section: 's' } } })
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

  it('flushes at step/end too (a mid-turn flip lands on the following step)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
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
  it('keeps a default-mode assembly identical to a no-dsh-mode deployment (exit tool restricted away)', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx)
    const assembly = await assembleFor(ctx, agent)
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
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'todo_write', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toContain('plan mode')
  })

  it('drops exit_plan_mode outside plan mode (custom modes never see it)', async () => {
    const ctx = await setup({ modes: { review: { section: 'reviewing' } } })
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: 'review' })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('reviewing')
  })

  it('leaves foreign assemble additions alone in any mode (no assemble-layer filtering at all)', async () => {
    // The visibility rule lives in the registry's scoped restriction, not in
    // an assemble wrapper, so a foreign listener's post-next() addition is
    // never touched — in default mode included, where the exit tool itself is
    // already absent from the registry view.
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
    const planning = await agentWithSession(ctx, 'planning', { mode: PLAN_MODE })
    expect((await assembleFor(ctx, planning)).tools.map(tool => tool.name))
      .toEqual(['exit_plan_mode', 'read', 'added-later'])
    const defaulted = await agentWithSession(ctx, 'defaulted')
    expect((await assembleFor(ctx, defaulted)).tools.map(tool => tool.name))
      .toEqual(['read', 'added-later'])
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
    await ctx.plugin(ModesService)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    const assembly = await assembleFor(ctx, agent)
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
    const agent = await agentWithSession(withModes)
    const sdk = (await assembleFor(withModes, agent)).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
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
    const bareSdk = (await bare.systemPrompt.assemble({ agent, scope: agent })).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toBe(bareSdk)
    expect(sdk).not.toContain('exit_plan_mode(args:')
  })

  it('treats a dropped folded definition as the default mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { mode: 'retired' })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'write'])
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

  it('denies a default-mode exit_plan_mode dispatch through the registry view (UNKNOWN_TOOL, not a schema-only hide)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    const result = await callExitFor(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: unknown tool "exit_plan_mode"' }])
  })

  it('restores dispatch when the boundary flush enters plan and re-denies after the exit flush', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.modes.set(agent, PLAN_MODE)
    await boundary(ctx, agent, 'turn/start')
    // In plan the tool is visible again; without a review channel the execute
    // body answers (proving dispatch reached it), rather than UNKNOWN_TOOL.
    const inPlan = await callExitFor(ctx, agent)
    expect(inPlan.content).toEqual([{ type: 'text', text: 'Error: no user-interaction channel is available to review the plan; ask the user to switch the session mode instead' }])
    ctx.modes.set(agent, DEFAULT_MODE)
    await boundary(ctx, agent, 'step/end')
    const afterExit = await callExitFor(ctx, agent)
    expect(afterExit.content).toEqual([{ type: 'text', text: 'Error: unknown tool "exit_plan_mode"' }])
  })
})

/** Dispatch the exit tool as the loop would — through the registry, agent-scoped. */
function callExitFor(ctx: Context, agent: Agent) {
  return ctx.tools.execute({
    callId: CallId(`call-exit-${++callCounter}`),
    name: EXIT_PLAN_MODE,
    arguments: { plan: '# P' },
    agent,
  })
}

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

  it('re-checks the folded mode at execute (defense in depth behind the registry denial)', async () => {
    // A foreign writer appends the flip DIRECTLY (not through ctx.modes.set),
    // so no boundary has reconciled visibility yet: the registry still admits
    // the call and the execute body's own re-check is what rejects it.
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-1', { mode: PLAN_MODE })
    agent.session.append('mode/set', { mode: DEFAULT_MODE })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode is only available in plan mode' }])
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
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep planning'])
  })

  it('an approved exit keeps the plan surface until the boundary (same-batch fold holds)', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    const approved = await callExit(ctx, agent)
    expect(approved.isError).toBe(false)
    // Calls of the SAME assistant response (no boundary between) were
    // requested under the plan-shaped header — the fold stays plan for that
    // whole batch; the boundary flush is what flips the next step.
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.some(tool => tool.name === EXIT_PLAN_MODE)).toBe(true)
    await boundary(ctx, agent, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
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
