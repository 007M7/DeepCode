import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TaskService from '@deepseek-ai/dsh-tasks'
import type { TaskHooks, TaskOutcome, TaskSnapshot, TaskStart } from '@deepseek-ai/dsh-tasks'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import { statusLine } from '@deepseek-ai/dsh-tool-tasks'

const agentRegistryDisposers = new WeakMap<Agent, () => void>()

async function setup(config: ToolTasks.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const agentsFiber = await ctx.plugin(AgentRegistry)
  await ctx.plugin(TaskService)
  const toolsFiber = await ctx.plugin(ToolTasks, config)
  return { ctx, agentsFiber, toolsFiber }
}

/**
 * A fake agent whose session token is `sessionId`, registered in `ctx.agents`.
 * The agent id is deliberately different so session authorization and exact
 * lifecycle ownership cannot be confused in tests.
 */
function fakeAgent(ctx: Context, sessionId: string, inject: (...args: unknown[]) => void = () => {}): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const agent = {
    id: `agent-${sessionId}`,
    ctx: scopeFiber.ctx,
    inject,
    session: { header: { version: 0, id: sessionId, createdAt: 0 } },
  } as unknown as Agent
  agentRegistryDisposers.set(agent, ctx.agents.register(agent))
  return agent
}

function detachAgent(agent: Agent): void {
  const dispose = agentRegistryDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing registry disposer for agent "${agent.id}"`)
  dispose()
}

/** A controllable producer start-spec (settle `done` on demand, record cancels). */
function producer(overrides: Partial<Omit<TaskStart, 'run'> & TaskHooks> = {}) {
  let settle!: (outcome: TaskOutcome) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, ...hookOverrides } = overrides
  const hooks: TaskHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<TaskOutcome>((res) => { settle = res }),
    ...hookOverrides,
  }
  const spec: TaskStart = { kind, label, ...owner !== undefined ? { owner } : {}, run: () => hooks }
  return { spec, settle, cancels }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ callId: CallId(`call-${++callCounter}`), name, arguments: args, ...agent ? { agent } : {} })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('tool-tasks setup', () => {
  it('attaches the control surface on load and detaches it with the fiber', async () => {
    const { ctx, toolsFiber } = await setup()
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow()
    await toolsFiber.dispose()
    expect(() => ctx.tasks.start(producer().spec)).toThrow('no control surface is attached')
  })

  it('rejects a config whose default wait exceeds the cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(TaskService)
    await expect(ctx.plugin(ToolTasks, { waitTimeoutMs: 100, maxWaitTimeoutMs: 50 }))
      .rejects.toThrow('waitTimeoutMs (100) exceeds maxWaitTimeoutMs (50)')
  })

  it('renders status lines with and without producer detail', () => {
    const base = { id: 'bash-1', kind: 'bash', label: 'x', startedAt: 0, reported: false } as unknown as TaskSnapshot
    expect(statusLine({ ...base, status: 'running' })).toBe('[status: running]')
    expect(statusLine({ ...base, status: 'completed', detail: 'exit code: 0' })).toBe('[status: completed, exit code: 0]')
  })

  it('applies the built-in wait bounds when apply() receives a bare config', async () => {
    // Bypasses the schemastery defaults on purpose: apply() must stand on its
    // own `??` fallbacks when embedded programmatically without the schema.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(TaskService)
    ToolTasks.apply(ctx, {})
    expect(ctx.tools.get('task_output')).toBeDefined()
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow()
  })
})

describe('task_output', () => {
  it('reads a consuming delta with a trailing status line', async () => {
    const { ctx } = await setup()
    const chunks = ['line one\n', '']
    ctx.tasks.start(producer({ readOutput: () => chunks.shift() ?? '' }).spec)

    // A body already ending in a newline gets no doubled separator.
    expect(text(await call(ctx, 'task_output', { task_id: 'bash-1' }))).toBe('line one\n[status: running]')
    expect(text(await call(ctx, 'task_output', { task_id: 'bash-1' }))).toBe('(no new output)\n[status: running]')
  })

  it('returns the final output of a settled final-output task', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.tasks.start(p.spec)
    expect(text(await call(ctx, 'task_output', { task_id: 'subagent-1' }))).toBe('(no new output)\n[status: running]')

    p.settle({ status: 'completed', detail: 'completed', output: 'the answer' })
    await tick()
    expect(text(await call(ctx, 'task_output', { task_id: 'subagent-1' }))).toBe('the answer\n[status: completed, completed]')
  })

  it('wait: true blocks until settlement and reports the terminal state', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.tasks.start(p.spec)

    const pending = call(ctx, 'task_output', { task_id: 'subagent-1', wait: true })
    p.settle({ status: 'completed', output: 'done deal' })
    expect(text(await pending)).toBe('done deal\n[status: completed]')
  })

  it('wait: true times out against the configured cap and leaves the task alive', async () => {
    const { ctx } = await setup({ waitTimeoutMs: 10, maxWaitTimeoutMs: 20 })
    ctx.tasks.start(producer().spec)

    // A model-supplied timeout far above the cap is clamped: this returns
    // promptly (≤ the 20ms cap), not after ten minutes.
    const result = await call(ctx, 'task_output', { task_id: 'bash-1', wait: true, timeout_ms: 600_000 })
    expect(text(result)).toBe('(no new output)\n[status: running]')
  })

  it('rejects an empty or unknown task id as an errored result', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'task_output', { task_id: '' })).isError).toBe(true)
    const unknown = await call(ctx, 'task_output', { task_id: 'bash-99' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('unknown task bash-99')
  })
})

describe('task_list', () => {
  it('lists caller-visible tasks and renders the empty case', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'task_list', {}))).toBe('(no background tasks)')

    const alice = fakeAgent(ctx, 'sess-alice')
    ctx.tasks.start(producer({ owner: alice, label: 'pnpm test' }).spec)
    ctx.tasks.start(producer({ kind: 'subagent', label: 'open research' }).spec)
    const p = producer({ owner: alice, label: 'build' })
    ctx.tasks.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(text(await call(ctx, 'task_list', {}, alice))).toBe([
      'bash-1 [bash] running — pnpm test',
      'subagent-1 [subagent] running — open research',
      'bash-2 [bash] completed — build',
    ].join('\n'))
    // A different caller sees only the unowned task.
    const bob = fakeAgent(ctx, 'sess-bob')
    expect(text(await call(ctx, 'task_list', {}, bob))).toBe('subagent-1 [subagent] running — open research')
  })
})

describe('task_kill', () => {
  it('requests cancellation with the forwarded reason', async () => {
    const { ctx } = await setup()
    const p = producer()
    ctx.tasks.start(p.spec)

    const result = await call(ctx, 'task_kill', { task_id: 'bash-1', reason: 'superseded' })
    expect(text(result)).toBe('requested cancellation of task bash-1')
    expect(p.cancels).toEqual(['superseded'])
  })

  it('reports an already-finished task without consuming its pending delta', async () => {
    const { ctx } = await setup()
    let delta = 'unread tail'
    const p = producer({ readOutput: () => { const d = delta; delta = ''; return d } })
    ctx.tasks.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(text(await call(ctx, 'task_kill', { task_id: 'bash-1' })))
      .toBe('task bash-1 had already finished [status: completed, exit code: 0]')
    // The kill described the task via a non-consuming snapshot: the delta is intact.
    expect(text(await call(ctx, 'task_output', { task_id: 'bash-1' }))).toBe('unread tail\n[status: completed, exit code: 0]')
  })

  it('rejects an empty task id as an errored result', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'task_kill', { task_id: '' })).isError).toBe(true)
  })
})

describe('tool-owned UI presentation (presentCall)', () => {
  it('renders generic cards for all three control tools', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('task_output')?.presentCall?.({ task_id: 'bash-1' }))
      .toEqual({ card: 'generic', title: 'Read output from background task bash-1', kind: 'read', rawInput: 'bash-1' })
    expect(ctx.tools.get('task_list')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List background tasks', kind: 'read' })
    expect(ctx.tools.get('task_kill')?.presentCall?.({ task_id: 'subagent-2' }))
      .toEqual({ card: 'generic', title: 'Kill background task subagent-2', kind: 'execute', rawInput: 'subagent-2' })
  })
})

describe('completion notices', () => {
  it('injects a notice into the owning agent when an unreported task settles', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = fakeAgent(ctx, 'sess-1', inject)
    const p = producer({ owner, label: 'pnpm test' })
    ctx.tasks.start(p.spec)

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith(
      [{ type: 'text', text: 'background task bash-1 (bash: pnpm test) finished [status: completed, exit code: 0]. Read its output with task_output.' }],
      { source: { kind: 'plugin', plugin: 'tool-tasks' } },
    )
  })

  it('suppresses the notice for a task the model already killed', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = fakeAgent(ctx, 'sess-1', inject)
    const p = producer({ owner })
    ctx.tasks.start(p.spec)

    await call(ctx, 'task_kill', { task_id: 'bash-1' }, owner)
    p.settle({ status: 'killed' })
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('suppresses the notice when a wait returned the terminal state', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = fakeAgent(ctx, 'sess-1', inject)
    const p = producer({ owner, kind: 'subagent' })
    ctx.tasks.start(p.spec)

    const pending = call(ctx, 'task_output', { task_id: 'subagent-1', wait: true }, owner)
    p.settle({ status: 'completed', output: 'answer' })
    expect(text(await pending)).toContain('answer')
    expect(inject).not.toHaveBeenCalled()
  })

  it('drops the notice for unowned tasks and for a disposed owner (benign race)', async () => {
    const { ctx } = await setup()
    // Unowned: settles with nobody to notify — nothing throws.
    const unowned = producer()
    ctx.tasks.start(unowned.spec)
    unowned.settle({ status: 'completed' })
    await tick()

    // Disposed owner: inject throws the disposed message — contained.
    const inject = vi.fn(() => { throw new Error('agent "agent-sess-1" is disposed') })
    const owner = fakeAgent(ctx, 'sess-1', inject)
    const p = producer({ owner })
    ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('does not route an old owner completion notice to a same-session replacement', async () => {
    const { ctx } = await setup()
    const oldInject = vi.fn(() => { throw new Error('agent "agent-shared" is disposed') })
    const oldOwner = fakeAgent(ctx, 'shared', oldInject)
    const p = producer({ owner: oldOwner })
    ctx.tasks.start(p.spec)

    detachAgent(oldOwner)
    const replacementInject = vi.fn()
    fakeAgent(ctx, 'shared', replacementInject)
    p.settle({ status: 'completed' })
    await tick()

    expect(oldInject).toHaveBeenCalledTimes(1)
    expect(replacementInject).not.toHaveBeenCalled()
  })

  it('propagates a non-disposed inject failure (a real bug must surface)', async () => {
    const { ctx } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = fakeAgent(ctx, 'sess-1', () => { throw new Error('unexpected inject bug') })
    const p = producer({ owner })
    ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    // The throw escapes the notice listener and is contained (logged) by the
    // registry's per-listener containment — visible, not swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected inject bug'))
  })

  it('keeps using the exact owner after the agent registry is gone', async () => {
    const { ctx, agentsFiber } = await setup()
    const inject = vi.fn()
    const owner = fakeAgent(ctx, 'sess-1', inject)

    // Settlement must not depend on a later registry lookup: the exact owner
    // supplied at start remains the destination while its own scope is live.
    const p1 = producer({ owner })
    ctx.tasks.start(p1.spec)
    const p2 = producer({ owner })
    ctx.tasks.start(p2.spec)

    await agentsFiber.dispose()
    p1.settle({ status: 'completed' })
    p2.settle({ status: 'failed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(2)
  })
})
