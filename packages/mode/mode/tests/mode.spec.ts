import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import UserInteractionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-interaction'
import ModesService, { DEFAULT_MODE, EXIT_PLAN_MODE, PLAN_MODE, foldMode, resolveConfig } from '../src/index.ts'
import type { ModeConfig } from '../src/index.ts'

/**
 * Drives the REAL plugin: mounts `dsh-mode` beside real `SystemPrompt` and
 * `ToolRegistry` services, with fake Agents carrying real `Session`s (the
 * tool-todo test shape). Turn boundaries are simulated by appending the real
 * boundary events and emitting `session/event` by hand — exactly the feed the
 * store wires in production.
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

/** Append a boundary event and hand-emit the `session/event` feed the store would. */
function boundary(ctx: Context, session: Session, type: 'turn/start' | 'step/end'): void {
  const event = type === 'turn/start'
    ? session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    : session.append('step/end', { turn: 1, step: 1 })
  ctx.emit('session/event', session, event as SessionEvent)
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
  it('merges the built-in plan definition with the read-only allowlist', () => {
    const resolved = resolveConfig({})
    const plan = resolved.definitions.get(PLAN_MODE)
    expect(plan?.tools).toEqual(['read', 'todo_write', 'web_search', 'web_fetch', 'ask_user_question', EXIT_PLAN_MODE])
    expect(plan?.section).toContain('plan mode')
  })

  it('lets config override plan and add further modes', () => {
    const resolved = resolveConfig({ modes: {
      plan: { section: 'custom plan', tools: ['read'] },
      review: { section: 'review', tools: ['read', 'write'] },
    } })
    expect(resolved.definitions.get(PLAN_MODE)).toEqual({ section: 'custom plan', tools: ['read'] })
    expect(resolved.definitions.get('review')).toEqual({ section: 'review', tools: ['read', 'write'] })
  })

  it('rejects the reserved default key loudly', () => {
    expect(() => resolveConfig({ modes: { default: { section: '', tools: [] } } }))
      .toThrow('"default" is reserved')
  })

  it('rejects a malformed definition loudly', () => {
    expect(() => resolveConfig({ modes: { bad: { section: 5, tools: [] } as unknown as { section: string; tools: string[] } } }))
      .toThrow('needs a string `section`')
    expect(() => resolveConfig({ modes: { bad: { section: '', tools: 'read' } as unknown as { section: string; tools: string[] } } }))
      .toThrow('needs a `tools` array')
    expect(() => resolveConfig({ modes: { bad: { section: '', tools: [7] } as unknown as { section: string; tools: string[] } } }))
      .toThrow('needs a `tools` array')
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
    const ctx = await setup({ modes: { review: { section: 's', tools: [] } } })
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
    boundary(ctx, agent.session, 'turn/start')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE })
  })

  it('flushes at step/end too (a mid-turn flip lands on the following step)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    boundary(ctx, agent.session, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
  })

  it('nets out a flip sequence that returns to the folded mode (no append, no notice)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    ctx.modes.set(agent, DEFAULT_MODE)
    boundary(ctx, agent.session, 'turn/start')
    expect(agent.session.events.some(event => event.type === 'mode/set')).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates nothing before the first request header (the section is the state statement)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    boundary(ctx, agent.session, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates once when the flushed mode differs from what the last header told the model', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    header(agent.session)
    ctx.modes.set(agent, PLAN_MODE)
    boundary(ctx, agent.session, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
    boundary(ctx, agent.session, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
  })

  it('narrates a switch back to the default mode with the default wording', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    ctx.modes.set(agent, DEFAULT_MODE)
    boundary(ctx, agent.session, 'step/end')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session back to the default mode.'])
  })

  it('stays silent when the header already reflects the flushed mode', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    header(agent.session)
    agent.session.append('mode/set', { mode: DEFAULT_MODE })
    ctx.modes.set(agent, PLAN_MODE)
    boundary(ctx, agent.session, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates a folded mode the config no longer defines, once, at turn starts', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'retired' })
    boundary(ctx, agent.session, 'turn/start')
    boundary(ctx, agent.session, 'turn/start')
    expect(noticeTexts(agent.session)).toEqual([
      'Mode "retired" is no longer defined in this deployment\'s configuration; the session continues in the default mode.',
    ])
    boundary(ctx, agent.session, 'step/end')
    expect(noticeTexts(agent.session)).toHaveLength(1)
  })

  it('ignores non-boundary session events on the feed', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const event = agent.session.append('mode/set', { mode: DEFAULT_MODE })
    ctx.emit('session/event', agent.session, event as SessionEvent)
    expect(ctx.modes.get(agent).pending).toBe(PLAN_MODE)
  })

  it('contains an append failure instead of killing the session feed', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const original = agent.session.append.bind(agent.session)
    agent.session.append = (() => { throw new Error('backend gone') })
    expect(() => { boundary({ emit: ctx.emit.bind(ctx) } as never as Context, agent.session, 'step/end') }).toThrow('backend gone')
    agent.session.append = original
    const event = agent.session.append('step/end', { turn: 1, step: 2 })
    agent.session.append = (() => { throw new Error('backend gone') })
    ctx.emit('session/event', agent.session, event as SessionEvent)
    expect(warn).toHaveBeenCalledOnce()
    // The failed flush re-parks the intent (cleared only after a landed
    // append), so the next healthy boundary converges the log with the
    // picker's optimistic state instead of dropping the switch forever.
    expect(ctx.modes.get(agent)).toEqual({ current: DEFAULT_MODE, pending: PLAN_MODE })
    agent.session.append = original
    boundary(ctx, agent.session, 'step/end')
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent).pending).toBeUndefined()
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

  it('filters plan-mode tools to the allowlist and renders the mode section', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'todo_write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'todo_write'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toContain('plan mode')
  })

  it('drops exit_plan_mode outside plan mode even when a custom allowlist names it', async () => {
    const ctx = await setup({ modes: { review: { section: 'reviewing', tools: ['read', EXIT_PLAN_MODE] } } })
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'review' })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read'])
    expect(assembly.sections.find(section => section.name === 'mode:policy')?.text).toBe('reviewing')
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

  it('passes allowlisted calls and denies the rest with the plan-mode reason', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: PLAN_MODE })
    const allowed = await execute(ctx, 'read', agent)
    expect(allowed.isError).toBe(false)
    const denied = await execute(ctx, 'write', agent)
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{
      type: 'text',
      text: 'Error: tool "write" is not available in plan mode; continue planning and present your plan with exit_plan_mode when ready',
    }])
  })

  it('denies with the generic reason in a custom mode', async () => {
    const ctx = await setup({ modes: { review: { section: 's', tools: ['read'] } } })
    registerNamedTools(ctx, ['write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'review' })
    const denied = await execute(ctx, 'write', agent)
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{ type: 'text', text: 'Error: tool "write" is not available in "review" mode' }])
  })

  it('judges by the logged mode only — a pending intent does not gate', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agent = agentWithSession()
    ctx.modes.set(agent, PLAN_MODE)
    const result = await execute(ctx, 'write', agent)
    expect(result.isError).toBe(false)
  })

  it('treats a dropped folded definition as the default mode (no gate)', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agent = agentWithSession()
    agent.session.append('mode/set', { mode: 'retired' })
    const result = await execute(ctx, 'write', agent)
    expect(result.isError).toBe(false)
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
    expect(result.content).toEqual([{ type: 'text', text: 'Plan approved — plan mode exited; the full toolset returns on your next step.' }])
    // Boundary-applied, not a direct append: the fold stays plan until the
    // step's end, so the gate covers any remaining call of the SAME batch.
    expect(foldMode(agent.session.events)).toBe(PLAN_MODE)
    expect(ctx.modes.get(agent)).toEqual({ current: PLAN_MODE, pending: DEFAULT_MODE })
    boundary(ctx, agent.session, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.agent).toBe(agent)
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep planning'])
  })

  it('an approved exit cannot smuggle a same-batch call past the gate', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    registerNamedTools(ctx, ['write'])
    const approved = await callExit(ctx, agent)
    expect(approved.isError).toBe(false)
    // The next call of the SAME assistant response (no boundary between):
    // requested under the plan-shaped header, so the gate must still deny it.
    const smuggled = await execute(ctx, 'write', agent)
    expect(smuggled.isError).toBe(true)
    expect(smuggled.content).toEqual([{
      type: 'text',
      text: 'Error: tool "write" is not available in plan mode; continue planning and present your plan with exit_plan_mode when ready',
    }])
    boundary(ctx, agent.session, 'step/end')
    const next = await execute(ctx, 'write', agent)
    expect(next.isError).toBe(false)
  })

  it('the exit flush narrates nothing — the tool result is the narration', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    header(agent.session)
    await callExit(ctx, agent)
    boundary(ctx, agent.session, 'step/end')
    expect(foldMode(agent.session.events)).toBe(DEFAULT_MODE)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('approve with a note carries the note into the confirmation', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'], custom: 'ship it small' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Plan approved — plan mode exited; the full toolset returns on your next step. User note: ship it small' }])
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
