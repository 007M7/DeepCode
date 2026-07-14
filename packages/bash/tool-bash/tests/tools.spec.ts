import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { BashExecutor, BashTaskId, setSandboxMode } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskRead, OwnerToken } from '@deepseek-ai/dsh-bash'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { renderResult } from '@deepseek-ai/dsh-tool-bash'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-spec-'))

// Pure-config passthrough runner (same knob the snapshot tier uses): skips the
// profile args up to `--` and execs the command unconfined — deterministic
// without a host bwrap.
const PASSTHROUGH_RUNNER = ['bash', '-c', 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"', 'passthrough-runner']
const PASSTHROUGH_RUNNER_CONFIG = {
  runnerCommand: PASSTHROUGH_RUNNER,
  // The script has no pre-exec failure path; the provider still requires an
  // explicit dialect so a future script change cannot silently turn runner
  // failure into an ordinary command result.
  runnerFailureSignatures: ['passthrough-runner: profile rejected'],
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  ;(ctx.bash as LocalBashExecutor).internals = { spillDir }
  await ctx.plugin(ToolBash)
  return ctx
}

/**
 * Build a fake {@link Agent} whose session token is `sessionId`, REGISTER it in
 * `ctx.agents` (the completion-notice path finds the owning agent by scanning
 * the registry for a matching `session.header.id`), and return it. The returned
 * agent is also passed to `execute` as `exec.agent` so it owns the spawned task.
 * The registration disposer is tracked so {@link unregisterFakeAgents} can drop
 * it (simulating the owning session disconnecting before a task completes).
 */
const fakeAgentDisposers = new Map<Context, (() => Promise<void> | void)[]>()
function registerFakeAgent(ctx: Context, sessionId: string, inject: (...args: unknown[]) => void): Agent {
  // A config agent has distinct registry (`agent.id`) and owner (`session.header.id`) tokens.
  // Keeping them unequal makes notice lookup by the wrong field fail instead of passing by chance.
  const agent = { id: `agent-${sessionId}`, inject, session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as unknown as Agent
  const dispose = ctx.agents.register(agent)
  const list = fakeAgentDisposers.get(ctx) ?? []
  list.push(dispose)
  fakeAgentDisposers.set(ctx, list)
  return agent
}

/** Unregister every fake agent in this ctx (simulate the owning session disconnecting). */
function unregisterFakeAgents(ctx: Context): void {
  for (const dispose of fakeAgentDisposers.get(ctx) ?? []) void dispose()
  fakeAgentDisposers.delete(ctx)
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ callId: CallId(`call-${++callCounter}`), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function callUntilText(
  ctx: Context,
  name: string,
  args: unknown,
  expected: string,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<typeof call>>> {
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<typeof call>> | undefined
  while (Date.now() < deadline) {
    last = await call(ctx, name, args)
    if (text(last).includes(expected)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`${name} output did not include ${JSON.stringify(expected)}; last text was ${JSON.stringify(last !== undefined ? text(last) : '')}`)
}

abstract class TestBashExecutor extends BashExecutor {
  resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 0,
      ...request.signal ? { signal: request.signal } : {},
      owner: request.owner,
      sandboxMode: request.sandboxMode,
    }
  }
}

class LossyReadBashExecutor extends TestBashExecutor {
  private readonly task: BashTask = {
    id: BashTaskId('bash-lossy'),
    command: 'fake',
    status: 'running',
    exitCode: null,
    signal: null,
    done: Promise.resolve(),
  }

  run(): Promise<BashRunResult> {
    return Promise.reject(new Error('not used'))
  }

  start(): BashTask {
    return this.task
  }

  get(id: BashTaskId): BashTask | undefined {
    return id === this.task.id ? this.task : undefined
  }

  ownerOf(): OwnerToken | undefined {
    return undefined
  }

  list(): BashTask[] {
    return [this.task]
  }

  readOutput(id: BashTaskId): BashTaskRead {
    if (id !== this.task.id) throw new Error(`unknown bash task "${id}"`)
    return { task: this.task, delta: 'tail', lossy: true }
  }

  kill(): boolean {
    return false
  }
}

describe('bash tool', () => {
  it('returns stdout for a successful command', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'echo hello', description: 'test command' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('hello\n')
  })

  it('reports (no output) for silent commands', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'true', description: 'test command' })
    expect(text(result)).toBe('(no output)')
  })

  it('marks stderr sections', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'echo out; echo err >&2', description: 'test command' })
    expect(text(result)).toBe('out\n[stderr]\nerr\n')
    expect(result.isError).toBe(false)
  })

  it('reports non-zero exits without isError', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'echo failing; exit 3', description: 'test command' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('failing\n[exit code: 3]')
  })

  it('reports timeout kills with both markers (timeout first)', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'sleep 60', description: 'test command', timeoutMs: 100 })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('(no output)\n[timed out after 100ms]\n[killed by signal: SIGTERM]')
  })

  it('reports a timeout even when the command traps the signal and exits 0', async () => {
    // The signal-independent timeout marker: a trapped SIGTERM that exits 0
    // after our timer fired must NOT look like a clean success. (bash may
    // print "Terminated" to stderr for the killed sleep — environment
    // dependent — so assert the marker, not the exact body.)
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'trap "exit 0" TERM; sleep 60', description: 'test command', timeoutMs: 100 })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[timed out after 100ms]')
    expect(text(result)).not.toContain('[exit code:')
  })

  it('reports truncation with the spill path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, { maxOutputBytes: 100, graceMs: 200 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir }
    await ctx.plugin(ToolBash)
    const result = await call(ctx, 'bash', { command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i; done', description: 'test command' })
    expect(text(result)).toContain('[output truncated; full output: ')
    expect(text(result)).toContain('line-0100')
  })

  it('honors workdir', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'pwd', description: 'test command', workdir: '/tmp' })
    expect(text(result).trim()).toMatch(/\/tmp$/)
  })

  it('surfaces spawn failures as isError', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'true', description: 'test command', workdir: '/nonexistent-dsh' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/ENOENT/)
  })

  it('surfaces aborts as isError', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      callId: CallId('call-abort'),
      name: 'bash',
      arguments: { command: 'sleep 60', description: 'test command' },
      signal: controller.signal,
    })
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/aborted/)
  })

  // Type and required-key violations are now rejected by the harness
  // (defineTool validates against the SchemaSpec — the arg-validation RFC) before execute.
  it.each([
    [{}, /missing required property "command"/],
    [{ command: 42, description: 'd' }, /"command" must be a string/],
    [{ command: 'x' }, /missing required property "description"/],
    [{ command: 'x', description: 7 }, /"description" must be a string/],
    [{ command: 'x', description: 'd', timeoutMs: 'soon' }, /"timeoutMs" must be a number/],
    [{ command: 'x', description: 'd', workdir: 7 }, /"workdir" must be a string/],
    [{ command: 'x', description: 'd', run_in_background: 'yes' }, /"run_in_background" must be a boolean/],
  ])('rejects schema-invalid args %j', async (args, pattern) => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
  })

  // Value constraints the SchemaSpec can't express stay in the tool body.
  it.each([
    [{ command: '  ', description: 'd' }, /invalid command/],
    [{ command: 'x', description: '   ' }, /invalid description/],
    [{ command: 'x', description: 'd', timeoutMs: -1 }, /invalid timeoutMs/],
  ])('rejects value-invalid args %j', async (args, pattern) => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
  })

  it('rejects a non-JSON numeric argument before tool-specific validation', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', {
      command: 'x', description: 'd', timeoutMs: Number.NaN,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tool execution arguments must be losslessly JSON-serializable')
  })

  it('registers all three schemas in the system prompt assembly', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(['bash', 'bash_output', 'bash_kill'])
    const bashSchema = ctx.tools.schemas()[0]!
    expect(bashSchema.parameters).toMatchObject({
      type: 'object',
      required: ['command', 'description'],
    })
  })

  it('contributes the exit-code habit as its prompt section (guidance the descriptions cannot carry)', async () => {
    const ctx = await setup()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'tool:bash')
    expect(section?.order).toBe(105)
    expect(section?.text).toContain('[exit code: N]')
  })

  it('unregisters everything when the plugin fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, {})
    const fiber = await ctx.plugin(ToolBash)
    expect(ctx.tools.schemas()).toHaveLength(3)
    expect((await ctx.systemPrompt.assemble()).sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona', 'tool:bash'])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    // Only the system-prompt plugin's own built-in sections remain.
    expect((await ctx.systemPrompt.assemble()).sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona'])
  })

  it('tools depend on the executor: no registration without ctx.bash', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    // inject: ['tools', 'bash'] keeps the plugin pending until bash exists.
    await ctx.plugin(ToolBash)
    expect(ctx.tools.schemas()).toHaveLength(0)
    await ctx.plugin(LocalBashExecutor, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.tools.schemas()).toHaveLength(3)
  })
})

describe('background tools', () => {
  it('bash with run_in_background returns a task id immediately', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', { command: 'sleep 0.2; echo bg-done', description: 'test command', run_in_background: true })
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(/^started background task bash-\d+$/)
  })

  it('bash_output polls incrementally and reports status', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'echo first; sleep 1; echo second', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)

    const first = await callUntilText(ctx, 'bash_output', { task_id: id }, 'first')
    expect(text(first)).toContain('first')
    expect(text(first)).toContain('[status: running]')

    await ctx.bash.get(id)!.done
    const second = await call(ctx, 'bash_output', { task_id: id })
    expect(text(second)).toContain('second')
    expect(text(second)).not.toContain('first')
    expect(text(second)).toContain('[status: completed, exit code: 0]')

    const third = await call(ctx, 'bash_output', { task_id: id })
    expect(text(third)).toContain('(no new output)')
  })

  it('bash_output flags lossy reads with spill paths', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, { maxOutputBytes: 100, graceMs: 200 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir }
    await ctx.plugin(ToolBash)

    const started = await call(ctx, 'bash', { command: 'for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    await ctx.bash.get(id)!.done
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toContain('[some output was dropped from memory; full output: ')
  })

  it('bash_output reports unavailable when a lossy read has no safe spill path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LossyReadBashExecutor)
    await ctx.plugin(ToolBash)

    const read = await call(ctx, 'bash_output', { task_id: 'bash-lossy' })
    expect(text(read)).toBe('tail\n[some output was dropped from memory; full output: (unavailable)]\n[status: running]')
  })

  it('bash_kill stops a running task; repeat reports already-finished', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'sleep 60', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)

    const killed = await call(ctx, 'bash_kill', { task_id: id })
    expect(text(killed)).toBe(`killed background task ${id}`)
    await ctx.bash.get(id)!.done

    const again = await call(ctx, 'bash_kill', { task_id: id })
    expect(text(again)).toBe(`task ${id} had already finished`)

    const status = await call(ctx, 'bash_output', { task_id: id })
    expect(text(status)).toContain('[status: killed by SIGTERM]')
  })

  it('unknown task ids are isError for both tools', async () => {
    const ctx = await setup()
    const read = await call(ctx, 'bash_output', { task_id: 'bash-999' })
    expect(read.isError).toBe(true)
    expect(text(read)).toMatch(/unknown bash task/)
    const kill = await call(ctx, 'bash_kill', { task_id: 'bash-999' })
    expect(kill.isError).toBe(true)
  })

  it.each([
    ['bash_output', {}, /missing required property "task_id"/],
    ['bash_output', { task_id: 9 }, /"task_id" must be a string/],
    ['bash_kill', { task_id: '' }, /invalid task_id/],
  ])('%s rejects invalid task_id %j', async (tool, args, pattern) => {
    const ctx = await setup()
    const result = await call(ctx, tool, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
  })

  it('injects a completion notice into the owning agent (found via the registry by session token)', async () => {
    const ctx = await setup()
    const inject = vi.fn()
    // Notices look up the agent in ctx.agents by session token, so passing it to execute is not
    // enough: the fake must be registered with a matching `session.header.id`.
    const agent = registerFakeAgent(ctx, 'bg', inject)

    const started = await ctx.tools.execute({
      callId: CallId('call-bg'),
      name: 'bash',
      arguments: { command: 'true', description: 'test command', run_in_background: true },
      agent,
    })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    await ctx.bash.get(id)!.done

    expect(inject).toHaveBeenCalledTimes(1)
    const [content, options] = inject.mock.calls[0] as [
      { type: string; text: string }[],
      { source: { kind: string; plugin: string } },
    ]
    expect(content[0]!.text).toContain(`background bash task ${id} finished`)
    expect(content[0]!.text).toContain('bash_output')
    expect(options.source).toEqual({ kind: 'plugin', plugin: 'tool-bash' })
  })

  it('swallows ONLY the disposed-agent inject error', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'bg', () => { throw new Error('agent "x" is disposed') })

    const started = await ctx.tools.execute({
      callId: CallId('call-bg2'),
      name: 'bash',
      arguments: { command: 'true', description: 'test command', run_in_background: true },
      agent,
    })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    await expect(ctx.bash.get(id)!.done).resolves.toBeUndefined()
  })

  it('rethrows a non-disposed inject failure (not blindly swallowed)', async () => {
    const ctx = await setup()
    // A real bug in inject (not the benign disposed race) must surface — the
    // base-class notifier contains it (logs, does not reject task.done), but
    // the listener itself must have thrown rather than silently eaten it.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const agent = registerFakeAgent(ctx, 'bg', () => { throw new Error('unexpected inject bug') })

      const started = await ctx.tools.execute({
        callId: CallId('call-bg3'),
        name: 'bash',
        arguments: { command: 'true', description: 'test command', run_in_background: true },
        agent,
      })
      const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
      await ctx.bash.get(id)!.done
      // notifyTaskDone caught and logged the rethrown error.
      expect(errorSpy).toHaveBeenCalled()
      const logged = errorSpy.mock.calls.flat().some(arg => arg instanceof Error && arg.message === 'unexpected inject bug')
      expect(logged).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops the notice cleanly when the owning agent is gone from the registry by completion', async () => {
    // Host-scoped bash tasks can outlive a per-session agent after an ACP disconnect. The task
    // retains its owner token, but with no matching live agent the notice is dropped without error.
    const ctx = await setup()
    const inject = vi.fn()
    const agent = registerFakeAgent(ctx, 'bg', inject)
    const started = await ctx.tools.execute({
      callId: CallId('call-bg4'),
      name: 'bash',
      arguments: { command: 'true', description: 'test command', run_in_background: true },
      agent,
    })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    // Unregister the agent BEFORE the task completes (simulate disconnect).
    unregisterFakeAgents(ctx)
    await expect(ctx.bash.get(id)!.done).resolves.toBeUndefined()
    expect(inject).not.toHaveBeenCalled()
  })

  it('does not notify when no agent owned the task', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'true', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    await expect(ctx.bash.get(id)!.done).resolves.toBeUndefined()
  })
})

describe('background task ownership (cross-session isolation)', () => {
  /** Run a tool on behalf of a specific agent (sets exec.agent). */
  function callAs(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent | undefined, name: string, args: unknown) {
    return ctx.tools.execute({ callId: CallId(`own-${++callCounter}`), name, arguments: args, ...agent ? { agent } : {} })
  }
  // Ownership uses `session.header.id`, not object identity. Distinct ids keep the isolation tests
  // from passing accidentally because every fake produced the same owner token.
  const fakeAgent = (sessionId: string) =>
    ({ inject: () => undefined, session: { header: { version: 0, id: sessionId, createdAt: 0 } } }) as unknown as import('@deepseek-ai/dsh-agent').Agent

  it('rejects bash_output/bash_kill for a task owned by a DIFFERENT session token', async () => {
    const ctx = await setup()
    const a = fakeAgent('sess-a')
    const b = fakeAgent('sess-b')
    // Agent A starts a long-running background task.
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)

    // Agent B (a different session token) cannot read or kill A's task.
    const readByB = await callAs(ctx, b, 'bash_output', { task_id: id })
    expect(readByB.isError).toBe(true)
    expect(text(readByB)).toMatch(/belongs to another session/)
    const killByB = await callAs(ctx, b, 'bash_kill', { task_id: id })
    expect(killByB.isError).toBe(true)
    expect(text(killByB)).toMatch(/belongs to another session/)

    // The task is still running (B's kill did nothing) — A can still kill it.
    const killByA = await callAs(ctx, a, 'bash_kill', { task_id: id })
    expect(killByA.isError).toBe(false)
    expect(text(killByA)).toBe(`killed background task ${id}`)
  })

  it('a DIFFERENT Agent object with the SAME session token may access the task (ownership is by token, not object identity)', async () => {
    // Ownership fences by session.header.id, NOT Agent object identity. Two
    // distinct Agent objects sharing one session token (e.g. an agent re-created
    // on the same session) are the SAME owner.
    const ctx = await setup()
    const a1 = fakeAgent('sess-shared')
    const a2 = fakeAgent('sess-shared') // distinct object, same token
    const started = await callAs(ctx, a1, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    const readByA2 = await callAs(ctx, a2, 'bash_output', { task_id: id })
    expect(readByA2.isError).toBe(false)
    await callAs(ctx, a1, 'bash_kill', { task_id: id }) // cleanup
  })

  it('the no-agent (non-loop) caller cannot access an owned task', async () => {
    const ctx = await setup()
    const a = fakeAgent('sess-a')
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    // A call with no exec.agent has no token → cannot prove ownership of an owned task.
    const read = await callAs(ctx, undefined, 'bash_output', { task_id: id })
    expect(read.isError).toBe(true)
    expect(text(read)).toMatch(/belongs to another session/)
    await callAs(ctx, a, 'bash_kill', { task_id: id }) // cleanup
  })

  it('an UNOWNED task (started with no agent) is accessible to anyone', async () => {
    const ctx = await setup()
    // Started by a non-loop caller (no exec.agent) → no owner token recorded.
    const started = await callAs(ctx, undefined, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    // Any agent (and the no-agent caller) may read/kill it.
    const read = await callAs(ctx, fakeAgent('sess-x'), 'bash_output', { task_id: id })
    expect(read.isError).toBe(false)
    const killed = await callAs(ctx, undefined, 'bash_kill', { task_id: id })
    expect(killed.isError).toBe(false)
  })

  it('the owner can still access its task AFTER it completes (owner token persists on the task)', async () => {
    const ctx = await setup()
    const a = fakeAgent('sess-a')
    const b = fakeAgent('sess-b')
    const started = await callAs(ctx, a, 'bash', { command: 'echo done', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    await ctx.bash.get(id)!.done
    // Completion does NOT clear ownership: B is still rejected, A still allowed.
    const readByB = await callAs(ctx, b, 'bash_output', { task_id: id })
    expect(readByB.isError).toBe(true)
    expect(text(readByB)).toMatch(/belongs to another session/)
    const readByA = await callAs(ctx, a, 'bash_output', { task_id: id })
    expect(readByA.isError).toBe(false)
  })

  it('ownership SURVIVES an independent tool-bash HMR reload (token lives on the executor)', async () => {
    // The executor task owns the token, so reloading only tool-bash preserves ownership. A
    // plugin-local map would lose it and incorrectly expose the task to agent B.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir }
    const fiber = await ctx.plugin(ToolBash)

    const a = fakeAgent('sess-a')
    const b = fakeAgent('sess-b')
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    // Before reload: B is rejected (A owns it).
    expect((await callAs(ctx, b, 'bash_output', { task_id: id })).isError).toBe(true)

    // Reload ONLY tool-bash; the executor and its running task (with its owner
    // token) survive.
    await fiber.dispose()
    await ctx.plugin(ToolBash)
    expect(ctx.bash.get(id)?.status).toBe('running')
    expect(ctx.bash.ownerOf(id)).toBe('sess-a')

    // After reload, ownership is INTACT → B is STILL rejected.
    expect((await callAs(ctx, b, 'bash_output', { task_id: id })).isError).toBe(true)
    await callAs(ctx, a, 'bash_kill', { task_id: id }) // cleanup
  })
})

describe('session-cwd routing (per-session workdir)', () => {
  function callAs(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent | undefined, args: unknown) {
    return ctx.tools.execute({ callId: CallId(`cwd-${++callCounter}`), name: 'bash', arguments: args, ...agent ? { agent } : {} })
  }
  // An agent whose session header carries a cwd (what session/new records).
  const agentInCwd = (cwd: string) =>
    ({ inject: () => undefined, session: { header: { version: 0, id: 'c', createdAt: 0, cwd } } }) as unknown as import('@deepseek-ai/dsh-agent').Agent

  it('defaults bash to the agent\'s session cwd (not the server launch dir)', async () => {
    const ctx = await setup()
    const result = await callAs(ctx, agentInCwd('/tmp'), { command: 'pwd', description: 'pwd' })
    expect(text(result).trim()).toMatch(/\/tmp$/)
  })

  it('an explicit absolute workdir overrides the session cwd', async () => {
    const ctx = await setup()
    const result = await callAs(ctx, agentInCwd('/'), { command: 'pwd', description: 'pwd', workdir: '/tmp' })
    expect(text(result).trim()).toMatch(/\/tmp$/)
  })

  it('a relative workdir is resolved against the session cwd', async () => {
    const ctx = await setup()
    // session cwd /usr + relative 'bin' → /usr/bin
    const result = await callAs(ctx, agentInCwd('/usr'), { command: 'pwd', description: 'pwd', workdir: 'bin' })
    expect(text(result).trim()).toMatch(/\/usr\/bin$/)
  })

  it('two sessions with different cwds each run bash in their own dir', async () => {
    const ctx = await setup()
    const inUsr = await callAs(ctx, agentInCwd('/usr'), { command: 'pwd', description: 'pwd' })
    const inTmp = await callAs(ctx, agentInCwd('/tmp'), { command: 'pwd', description: 'pwd' })
    expect(text(inUsr).trim()).toMatch(/\/usr$/)
    expect(text(inTmp).trim()).toMatch(/\/tmp$/)
  })

  it('falls back to the executor default when the agent has no session cwd', async () => {
    const ctx = await setup()
    // No exec.agent at all → executor uses its config/process.cwd() default.
    const result = await ctx.tools.execute({ callId: CallId('cwd-noagent'), name: 'bash', arguments: { command: 'pwd', description: 'pwd' } })
    expect(result.isError).toBe(false)
    expect(text(result).trim().length).toBeGreaterThan(0)
  })
})

describe('renderResult', () => {
  const base = {
    exitCode: 0 as number | null,
    signal: null as NodeJS.Signals | null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  }

  it('renders stderr-only output without a stdout prefix', () => {
    expect(renderResult({ ...base, stderr: { text: 'err\n', truncated: false } }))
      .toBe('[stderr]\nerr\n')
  })

  it('adds a separator when stdout does not end with a newline', () => {
    expect(renderResult({
      ...base,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    })).toBe('out\n[stderr]\nerr')
  })

  it('appends exit-code markers after a newline for unterminated output', () => {
    expect(renderResult({ ...base, exitCode: 7, stdout: { text: 'x', truncated: false } }))
      .toBe('x\n[exit code: 7]')
  })

  it('renders signal kills without the timeout marker when not timed out', () => {
    expect(renderResult({ ...base, exitCode: null, signal: 'SIGKILL' }))
      .toBe('(no output)\n[killed by signal: SIGKILL]')
  })

  it('reports a timeout that exited 0 (trapped signal) without a kill marker', () => {
    expect(renderResult({ ...base, exitCode: 0, signal: null, timedOut: true }))
      .toBe('(no output)\n[timed out after 1000ms]')
  })

  it('orders the timeout marker before a kill marker', () => {
    expect(renderResult({ ...base, exitCode: null, signal: 'SIGTERM', timedOut: true }))
      .toBe('(no output)\n[timed out after 1000ms]\n[killed by signal: SIGTERM]')
  })

  it('notes truncation with a fallback when the spill path is missing', () => {
    expect(renderResult({ ...base, stdout: { text: 'tail', truncated: true } }))
      .toBe('tail\n[output truncated; full output: (unavailable)]')
  })
})

describe('status lines', () => {
  it('reports kills without a recorded signal (executor raced process exit)', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'sleep 60', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    const task = ctx.bash.get(id)!

    await call(ctx, 'bash_kill', { task_id: id })
    await task.done
    // Simulate the variant where the close event carried no signal.
    task.signal = null
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toContain('[status: killed]')
  })

  it('reports completed tasks with a null exit code as exit 0', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'true', description: 'test command', run_in_background: true })
    const id = BashTaskId(/task (bash-\d+)/.exec(text(started))![1]!)
    const task = ctx.bash.get(id)!
    await task.done
    // Defensive: completed tasks always carry an exit code in practice; the
    // ?? 0 fallback covers task shapes from other executor implementations.
    task.exitCode = null
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toContain('[status: completed, exit code: 0]')
  })
})

describe('tool-owned UI presentation (presentCall / presentResult)', () => {
  it('bash presentCall: a foreground run is a terminal card (command title, description, workdir → cwd absolute or relative)', async () => {
    const ctx = await setup()
    // No explicit workdir → a terminal card with no cwd (the UI bridge fills the
    // session cwd it owns; the pure presenter can't see it).
    expect(ctx.tools.get('bash')?.presentCall?.({ command: 'ls -la src', description: 'List files in src' }))
      .toEqual({ card: 'terminal', title: 'ls -la src', description: 'List files in src' })
    // An ABSOLUTE workdir is surfaced verbatim as the terminal cwd header.
    expect(ctx.tools.get('bash')?.presentCall?.({ command: 'pwd', description: 'Print dir', workdir: '/tmp/x' }))
      .toEqual({ card: 'terminal', title: 'pwd', description: 'Print dir', cwd: '/tmp/x' })
    // A RELATIVE workdir is passed through AS-IS (the bridge resolves it against
    // the session cwd, matching where execution runs) — not dropped.
    expect(ctx.tools.get('bash')?.presentCall?.({ command: 'pwd', description: 'Print dir', workdir: 'sub' }))
      .toEqual({ card: 'terminal', title: 'pwd', description: 'Print dir', cwd: 'sub' })
  })

  it('bash presentResult: a terminal result carries RAW output (newlines intact) + parsed exit code', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')!.presentResult!(
      { command: 'echo hi', description: 'echo' },
      { content: [{ type: 'text', text: 'hi\n[exit code: 0]\n\n' }], isError: false },
    )
    // A terminal result keeps the RAW bytes (newlines intact) a terminal renderer
    // needs; the bridge derives the fenced fallback. exitCode is parsed back from
    // the [exit code: N] marker.
    expect(present).toEqual({ card: 'terminal', output: 'hi\n[exit code: 0]\n\n', exitCode: 0 })
  })

  it('bash presentResult: a non-zero exit and a signal kill parse into exitCode / signal', async () => {
    const ctx = await setup()
    const args = { command: 'x', description: 'x' }
    const nonzero = ctx.tools.get('bash')!.presentResult!(args, { content: [{ type: 'text', text: 'oops\n[exit code: 3]' }], isError: false })
    expect(nonzero).toEqual({ card: 'terminal', output: 'oops\n[exit code: 3]', exitCode: 3 })
    const killed = ctx.tools.get('bash')!.presentResult!(args, { content: [{ type: 'text', text: 'gone\n[killed by signal: SIGKILL]' }], isError: false })
    expect(killed).toEqual({ card: 'terminal', output: 'gone\n[killed by signal: SIGKILL]', signal: 'SIGKILL' })
  })

  it('bash presentResult exit parse is the inverse of renderResult markers (round-trip)', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')!
    // For each renderResult outcome, the rendered text fed back through
    // presentResult recovers the matching structured exit — the parse and the
    // marker emission co-evolve in one file, so this pins the pair.
    const base = {
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: '', truncated: false },
    }
    const cases = [
      { result: { ...base, exitCode: 0, signal: null, timedOut: false }, expect: { exitCode: 0 } },
      { result: { ...base, exitCode: 7, signal: null, timedOut: false }, expect: { exitCode: 7 } },
      { result: { ...base, exitCode: null, signal: 'SIGTERM' as const, timedOut: false }, expect: { signal: 'SIGTERM' } },
      // A trapped-timeout run that exits 0 has no signal/exit marker → reads as exit 0 (it did exit 0).
      { result: { ...base, exitCode: 0, signal: null, timedOut: true }, expect: { exitCode: 0 } },
    ]
    for (const c of cases) {
      const rendered = renderResult(c.result)
      const out = present.presentResult!({ command: 'x', description: 'x' }, { content: [{ type: 'text', text: rendered }], isError: false })
      // Drop card + output; the remaining fields are the parsed exit.
      const { card: _c, output: _o, ...exit } = out as { card: string; output?: string; exitCode?: number; signal?: string }
      expect(exit).toEqual(c.expect)
    }
  })

  it('bash presentResult: a clean exit-0 whose output ENDS in marker-like text is NOT read as a failure', async () => {
    const ctx = await setup()
    const args = { command: 'printf "[exit code: 5]"', description: 'print' }
    // A successful command may print marker-like text. A clean result appends no marker or
    // newline; parsing requires the leading newline emitted for real markers, so this stays exit 0.
    const out = ctx.tools.get('bash')!.presentResult!(args, { content: [{ type: 'text', text: '[exit code: 5]' }], isError: false })
    expect(out).toEqual({ card: 'terminal', output: '[exit code: 5]', exitCode: 0 })
    // Same for a fake signal marker with no leading newline.
    const sig = ctx.tools.get('bash')!.presentResult!(args, { content: [{ type: 'text', text: '[killed by signal: SIGKILL]' }], isError: false })
    expect(sig).toEqual({ card: 'terminal', output: '[killed by signal: SIGKILL]', exitCode: 0 })
  })

  it('bash presentCall/presentResult: a run_in_background call is a generic card and its ack carries no exit pill', async () => {
    const ctx = await setup()
    // The background start returns a task-id ack, not a streamed run — a generic
    // execute card with the command as rawInput and the description as content.
    const call = ctx.tools.get('bash')!.presentCall!({ command: 'sleep 100', description: 'wait', run_in_background: true })
    expect(call).toEqual({ card: 'generic', title: 'sleep 100', kind: 'execute', rawInput: 'sleep 100', content: [{ type: 'text', text: 'wait' }] })
    // The ack result is a generic fenced-text card — no terminal output / exit pill.
    const result = ctx.tools.get('bash')!.presentResult!(
      { command: 'sleep 100', description: 'wait', run_in_background: true },
      { content: [{ type: 'text', text: 'started background task bash-1' }], isError: false },
    )
    expect(result).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nstarted background task bash-1\n```' }] })
  })

  it('bash presentResult: an isError result is a generic card (no real process exit to report)', async () => {
    const ctx = await setup()
    // A spawn failure / abort has no process exit — the body is an error message,
    // not renderResult output, so a generic fenced card, no terminal output/exit.
    const out = ctx.tools.get('bash')!.presentResult!(
      { command: 'x', description: 'x' },
      { content: [{ type: 'text', text: 'command aborted' }], isError: true },
    )
    expect(out).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\ncommand aborted\n```' }] })
  })

  it('bash presentResult: leaves a non-text (unexpected) result untouched → undefined (UI keeps raw content)', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')!.presentResult!(
      { command: 'x', description: 'x' },
      { content: [{ type: 'reasoning', text: 'unexpected' }], isError: false },
    )
    expect(present).toBeUndefined()
  })

  it('bash presentResult: a result that is not exactly one block → undefined (no single text to fence)', async () => {
    const ctx = await setup()
    const args = { command: 'x', description: 'x' }
    // Empty content (no block) and multi-block content both fall through.
    expect(ctx.tools.get('bash')!.presentResult!(args, { content: [], isError: false })).toBeUndefined()
    expect(ctx.tools.get('bash')!.presentResult!(args, {
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      isError: false,
    })).toBeUndefined()
  })

  it('bash_output / bash_kill presentCall: a readable task-scoped title, task id as rawInput', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('bash_output')!.presentCall!({ task_id: 'bash-3' }))
      .toEqual({ card: 'generic', title: 'Read output from background task bash-3', kind: 'execute', rawInput: 'bash-3' })
    expect(ctx.tools.get('bash_kill')!.presentCall!({ task_id: 'bash-3' }))
      .toEqual({ card: 'generic', title: 'Kill background task bash-3', kind: 'execute', rawInput: 'bash-3' })
  })

  it('presentCall validates softly: malformed args (missing required description) return undefined, never throw', async () => {
    const ctx = await setup()
    // `defineTool` soft-validates replayed logged args before presentation. Invalid shapes return
    // undefined for generic UI rendering rather than throwing; `presentCall` accepts `unknown`.
    expect(ctx.tools.get('bash')?.presentCall?.({ command: 'ls' })).toBeUndefined()
  })
})

describe('the model-facing bash tool builds its request from named args only (no {...args} forward)', () => {
  /**
   * Records requests passed to `resolve()` so tests can prove the model-facing tool forwards only
   * named arguments. It intentionally exposes neither `stdin` nor `env`; this catches a future
   * `...args` spread into the post-scrub env merge. The credential scrub remains the security
   * boundary; see the bash stdin/env RFC. Foreground `run()` is canned and `start()` is unused.
   */
  class RecordingBashExecutor extends BashExecutor {
    readonly requests: BashExecRequest[] = []
    resolve(request: BashExecRequest): BashExecSpec {
      this.requests.push(request)
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 0,
        ...request.signal ? { signal: request.signal } : {},
        ...request.stdin !== undefined ? { stdin: request.stdin } : {},
        ...request.env !== undefined ? { env: request.env } : {},
        owner: request.owner,
        sandboxMode: request.sandboxMode,
      }
    }
    run(): Promise<BashRunResult> {
      return Promise.resolve({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
        stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
      })
    }
    start(): BashTask { throw new Error('unused') }
    get(): BashTask | undefined { return undefined }
    ownerOf(): OwnerToken | undefined { return undefined }
    list(): BashTask[] { return [] }
    readOutput(): BashTaskRead { throw new Error('unused') }
    kill(): boolean { return false }
  }

  async function setupRecording() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(RecordingBashExecutor)
    await ctx.plugin(ToolBash)
    return { ctx, bash: ctx.bash as RecordingBashExecutor }
  }

  it('does not forward env/stdin even when the model includes them as extra arguments', async () => {
    const { ctx, bash } = await setupRecording()
    // Unknown `env` and `stdin` keys are ignored by the schema and named request construction.
    // This preserves the request shape; it is not a security boundary because shell syntax can
    // already set environment variables or feed stdin.
    await ctx.tools.execute({
      callId: CallId('no-forward-1'),
      name: 'bash',
      arguments: {
        command: 'echo hi',
        description: 'echo',
        env: { SNEAKY_API_KEY: 'leak' },
        stdin: 'malicious payload',
      },
    })
    expect(bash.requests).toHaveLength(1)
    const request = bash.requests[0]!
    expect(request.command).toBe('echo hi')
    expect('env' in request).toBe(false)
    expect('stdin' in request).toBe(false)
  })

  it('a background bash call likewise carries no env/stdin', async () => {
    const { ctx, bash } = await setupRecording()
    // start() throws in this recorder, but resolve() runs first and records the
    // request — which is all this no-forward assertion needs.
    await ctx.tools.execute({
      callId: CallId('no-forward-2'),
      name: 'bash',
      arguments: {
        command: 'sleep 1',
        description: 'sleep',
        run_in_background: true,
        env: { TOKEN: 'leak' },
        stdin: 'x',
      },
    })
    expect(bash.requests).toHaveLength(1)
    const request = bash.requests[0]!
    expect('env' in request).toBe(false)
    expect('stdin' in request).toBe(false)
    // The owner token IS set on a background call (the isolation fence) — proving
    // the recorder sees the real request the consumer built, so the absent
    // env/stdin above is a real negative, not a recorder that drops everything.
    expect('owner' in request).toBe(true)
  })
})

describe('sandbox rendering', () => {
  const sandboxResult = (denied: boolean, exitCode: number): BashRunResult => ({
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: denied ? 'bash: /x: Read-only file system' : 'boom', truncated: false },
    sandbox: { mode: 'read-only', denied },
  })

  it('renders a denial marker BEFORE the exit-code marker (the $-anchored parse survives)', () => {
    const text = renderResult(sandboxResult(true, 1))
    expect(text).toMatch(/\[sandbox: file access denied under read-only mode\]\n\[exit code: 1\]$/)
  })

  it('appends the same-turn escalation hint to a denial exactly when the fields are advertised', () => {
    const hinted = renderResult(sandboxResult(true, 1), ['workspace-write', 'danger-full-access'])
    expect(hinted).toMatch(
      /denied under read-only mode\]\n\[sandbox: escalation available — retry this exact command once with sandbox_permissions [^\n]+\]\n\[exit code: 1\]$/, // eslint-disable-line @stylistic/max-len -- the hint sentence is pinned verbatim
    )
    // Default (no advertisement): no hint — a lever the schema does not offer is never suggested.
    expect(renderResult(sandboxResult(true, 1))).not.toContain('escalation available')
    // A non-denied result never hints, advertised or not.
    expect(renderResult(sandboxResult(false, 2), ['danger-full-access'])).not.toContain('escalation available')
  })

  it('renders no sandbox marker for a plain failure under a sandboxed mode', () => {
    expect(renderResult(sandboxResult(false, 2))).not.toContain('[sandbox:')
  })

  it('bash_output reports a settled background denial with the same marker', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSandboxProvider, PASSTHROUGH_RUNNER_CONFIG)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
    const bash = ctx.bash as SandboxBashExecutor
    bash.internals = { spillDir }
    await ctx.plugin(ToolBash)
    const started = await call(ctx, 'bash', { command: 'echo "x: Permission denied" >&2; exit 1', description: 'test command', run_in_background: true })
    const id = text(started).match(/started background task (bash-\d+)/)![1]
    await bash.list().find(task => task.id === id)!.done
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toMatch(
      /\[status: completed, exit code: 1\]\n\[sandbox: file access denied under read-only mode\]\n\[sandbox: escalation available[^\n]+\]$/,
    )
  })

  it('a settled background denial renders no escalation hint without a confining executor (defensive arm)', async () => {
    // Structurally near-unreachable through the real stack — every confining
    // default advertises the static target set — but the read path guards
    // it anyway: an executor that reports no sandboxMode (fields never
    // advertised) whose task nonetheless carries denial facts must render
    // the marker without suggesting a lever the schema does not offer.
    class FactsOnlyExecutor extends TestBashExecutor {
      private readonly task: BashTask = {
        id: BashTaskId('bash-facts'),
        command: 'fake',
        status: 'completed',
        exitCode: 1,
        signal: null,
        done: Promise.resolve(),
        sandbox: { mode: 'read-only', denied: true },
      }

      run(): Promise<BashRunResult> { return Promise.reject(new Error('not used')) }
      start(): BashTask { return this.task }
      get(id: string): BashTask | undefined { return id === this.task.id ? this.task : undefined }
      list(): BashTask[] { return [this.task] }
      kill(): boolean { return false }
      ownerOf(): OwnerToken | undefined { return undefined }
      readOutput(): BashTaskRead {
        return { task: this.task, delta: '', lossy: false }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FactsOnlyExecutor)
    await ctx.plugin(ToolBash)
    const read = await call(ctx, 'bash_output', { task_id: 'bash-facts' })
    expect(text(read)).toMatch(/\[sandbox: file access denied under read-only mode\]$/)
    expect(text(read)).not.toContain('escalation available')
  })

  it('bash_output reports a settled background RUNNER failure as a sandbox problem, outranking the denial marker', async () => {
    // A provider whose wrap carries a runner-failure signature: the settled
    // task's stderr matching it means the sandbox itself broke and the
    // command never ran — even though the same stderr also carries denial
    // words (a runner's error text may contain them).
    class FakeProvider extends SandboxProvider {
      confine(argv: readonly string[]): ConfinedArgv {
        return { argv: [...argv], enforcement: 'full', denialSignatures: ['permission denied'], runnerFailureSignatures: ['fake-runner: '] }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeProvider)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
    const bash = ctx.bash as SandboxBashExecutor
    bash.internals = { spillDir }
    await ctx.plugin(ToolBash)
    const started = await call(ctx, 'bash', { command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125', description: 'test command', run_in_background: true })
    const id = text(started).match(/started background task (bash-\d+)/)![1]
    await bash.list().find(task => task.id === id)!.done
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toMatch(/\[sandbox: the sandbox runner itself failed under read-only mode — the command did not run; /)
    expect(text(read)).toMatch(/this is a sandbox problem, not a command failure\]$/)
    expect(text(read)).not.toContain('file access denied')
  })

  it('classifies an executable configured runner that refuses its profile before the command runs', async () => {
    const signature = 'custom-runner-rejected'
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {
      runnerCommand: ['bash', '-c', `printf '${signature}\\n' >&2; exit 125`, 'custom-runner'],
      runnerFailureSignatures: [signature],
    })
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
    const bash = ctx.bash as SandboxBashExecutor
    bash.internals = { spillDir }

    await expect(bash.run(bash.resolve({ command: 'echo command-must-not-run' })))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })

    const task = bash.start(bash.resolve({ command: 'echo command-must-not-run' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })

  it('reports a real denial end-to-end through the shipping sandbox executor', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSandboxProvider, PASSTHROUGH_RUNNER_CONFIG)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
    const bash = ctx.bash as SandboxBashExecutor
    bash.internals = { spillDir }
    await ctx.plugin(ToolBash)
    const lockedDir = join(mkdtempSync(join(tmpdir(), 'dsh-tool-bash-denied-')), 'locked')
    mkdirSync(lockedDir)
    chmodSync(lockedDir, 0o555)
    const result = await call(ctx, 'bash', { command: `echo x > ${lockedDir}/f`, description: 'Write into a locked directory' })
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(
      /denied under read-only mode\]\n\[sandbox: escalation available[^\n]+\]\n\[exit code: \d+\]$/,
    )
  })
})

describe('sandbox escalation (sandbox_permissions / justification)', () => {
  /** Compose the real sandbox stack (passthrough runner) at a given default mode. */
  async function setupSandboxed(mode?: 'read-only' | 'workspace-write' | 'danger-full-access', opts: { approval?: boolean; policy?: 'ask' | 'never' } = {}) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSandboxProvider, PASSTHROUGH_RUNNER_CONFIG)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200, ...mode !== undefined ? { mode } : {} })
    const bash = ctx.bash as SandboxBashExecutor
    bash.internals = { spillDir }
    if (opts.approval === true) await ctx.plugin(ApprovalService, opts.policy !== undefined ? { policy: opts.policy } : {})
    await ctx.plugin(ToolBash)
    return { ctx, bash }
  }

  /** The registered bash tool's wire schema (what the model actually sees). */
  function bashSchema(ctx: Context) {
    const schema = ctx.tools.schemas().find(s => s.name === 'bash')
    if (!schema) throw new Error('bash tool not registered')
    return schema as unknown as { description: string; parameters: { properties: Record<string, { enum?: string[] }> } }
  }

  /**
   * A fake agent whose session records appends — the approval audit surface.
   * Seeded mid-turn: an escalating call always runs inside one, and request()
   * enforces the enclosure.
   */
  function escalationAgent(events: Array<{ type: string; data: Record<string, unknown> }>): Agent {
    return {
      id: 'agent-esc',
      session: {
        header: { version: 0, id: 'sess-esc', createdAt: 0 },
        events: [{ type: 'turn/start' }],
        append: (type: string, data: Record<string, unknown>) => { events.push({ type, data }) },
      },
    } as unknown as Agent
  }

  let escCall = 0
  function callAs(ctx: Context, agent: Agent | undefined, args: unknown) {
    return ctx.tools.execute({ callId: CallId(`call-esc-${++escCall}`), name: 'bash', arguments: args, ...agent ? { agent } : {} })
  }

  const ESCALATE = { command: 'true', description: 'test escalation', sandbox_permissions: 'workspace-write', justification: 'the test needs it' }

  it('advertises no escalation surface under a non-sandboxing executor', async () => {
    const ctx = await setup()
    expect(ctx.bash.sandboxMode).toBeUndefined()
    const schema = bashSchema(ctx)
    expect(schema.parameters.properties['sandbox_permissions']).toBeUndefined()
    expect(schema.parameters.properties['justification']).toBeUndefined()
    expect(schema.description).not.toContain('sanctioned exception')
  })

  it('advertises the full closed target vocabulary under any confining default', async () => {
    // The enum is deliberately NOT default-relative: a session's effective
    // mode is per-session and switchable, so every confining composition
    // advertises every possible target — strict widening is checked at
    // execution against the call's effective mode instead.
    for (const mode of [undefined, 'workspace-write', 'danger-full-access'] as const) {
      const { ctx } = await setupSandboxed(mode)
      const schema = bashSchema(ctx)
      expect(schema.parameters.properties['sandbox_permissions']?.enum).toEqual(['workspace-write', 'danger-full-access'])
      expect(schema.parameters.properties['justification']).toBeDefined()
      expect(schema.description).toContain('sanctioned exception')
    }
  })

  it('a non-widening request fails at execution with its own text and prompts no one', async () => {
    const { ctx } = await setupSandboxed('danger-full-access', { approval: true })
    const consulted = vi.fn()
    ctx.on('approval/request', (_req, next) => { consulted(); return next() })
    const result = await callAs(ctx, escalationAgent([]), { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: 'already wider' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not strictly wider than this call\'s current "danger-full-access" mode')
    expect(consulted).not.toHaveBeenCalled()
  })

  it('rejects sandbox_permissions without a justification, and vice versa, and a blank justification', async () => {
    const { ctx } = await setupSandboxed()
    const missing = await callAs(ctx, undefined, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('sandbox_permissions requires a justification')
    const orphan = await callAs(ctx, undefined, { command: 'true', description: 'd', justification: 'why not' })
    expect(orphan.isError).toBe(true)
    expect(text(orphan)).toContain('only valid together with sandbox_permissions')
    const blank = await callAs(ctx, undefined, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: '   ' })
    expect(blank.isError).toBe(true)
    expect(text(blank)).toContain('expected a non-empty sentence')
  })

  it('the schema enum rejects a mode outside the target vocabulary before execute (registry-level, any caller)', async () => {
    const { ctx } = await setupSandboxed()
    const result = await callAs(ctx, undefined, { command: 'true', description: 'd', sandbox_permissions: 'read-only', justification: 'narrow' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be one of')
  })

  it('rejects an unadvertised sandbox_permissions injection under a non-sandboxing executor', async () => {
    const ctx = await setup()
    const result = await callAs(ctx, undefined, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: 'sneaky' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not available in this composition')
  })

  it('fails closed with its own text when no approval service is composed', async () => {
    const { ctx } = await setupSandboxed()
    const result = await callAs(ctx, escalationAgent([]), ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval service is composed')
  })

  it('fails closed with its own text for an agent-less escalating call', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    const result = await callAs(ctx, undefined, ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no agent to route it through')
  })

  it('fails closed with its own text when the service has no answerer', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    const result = await callAs(ctx, escalationAgent([]), ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel is available')
  })

  it('a grant runs THAT call under the wider mode — the denial marker names it — and lands the audit pair', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    // A real unix denial under the passthrough runner: the marker's mode can
    // only say workspace-write if the override actually rode the spec.
    const lockedDir = join(mkdtempSync(join(tmpdir(), 'dsh-esc-denied-')), 'locked')
    mkdirSync(lockedDir)
    chmodSync(lockedDir, 0o555)
    const result = await callAs(ctx, escalationAgent(events), {
      command: `echo x > ${lockedDir}/f`,
      description: 'write into a locked directory',
      sandbox_permissions: 'workspace-write',
      justification: 'must write outside the workspace',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(/\[sandbox: file access denied under workspace-write mode\]/)
    expect(events.map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(events[0]?.data['toolName']).toBe('bash')
    expect(events[0]?.data['reason']).toBe('escalate sandbox to workspace-write: must write outside the workspace')
    expect(events[1]?.data['outcome']).toBe('allowed-once')
  })

  it('a granted background start settles with the wider mode\'s facts', async () => {
    const { ctx, bash } = await setupSandboxed('read-only', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const started = await callAs(ctx, escalationAgent([]), { ...ESCALATE, run_in_background: true })
    expect(started.isError).toBe(false)
    const id = text(started).match(/started background task (bash-\d+)/)?.[1]
    const task = bash.list().find(t => t.id === id)
    if (!task) throw new Error('escalated task not tracked')
    await task.done
    expect(task.sandbox).toMatchObject({ mode: 'workspace-write', denied: false })
  })

  it('a rejection denies with the user-said-no text and runs nothing', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
    // A live (non-aborted) signal rides the execution: the gate threads it
    // into the approval request so a turn cancellation can withdraw the ask.
    const result = await ctx.tools.execute({
      callId: CallId(`call-esc-${++escCall}`),
      name: 'bash',
      arguments: ESCALATE,
      agent: escalationAgent([]),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the user rejected escalating this command to "workspace-write"')
  })

  it('a cancellation denies with the cancelled text', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('cancelled'))
    const result = await callAs(ctx, escalationAgent([]), ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('approval for escalating to "workspace-write" was cancelled')
  })

  it('a rogue approval stand-in returning a non-vocabulary outcome hits the exhaustiveness backstop', async () => {
    const { ctx } = await setupSandboxed()
    ctx.provide('approval', { request: () => Promise.resolve('yolo') } as unknown as InstanceType<typeof ApprovalService>)
    const result = await callAs(ctx, escalationAgent([]), ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unreachable')
  })

  it('a never policy rejects an escalation deterministically without consulting any answerer', async () => {
    // The live-session e.md case: the model requests escalation against a
    // 'never' session — the prepend gate answers rejected before any
    // interactive answerer, the fail-closed text is the ordinary rejection
    // wording, and the audit pair still lands.
    const { ctx } = await setupSandboxed('read-only', { approval: true, policy: 'never' })
    const consulted = vi.fn()
    ctx.on('approval/request', (_req, next) => { consulted(); return next() })
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const result = await callAs(ctx, escalationAgent(events), ESCALATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the user rejected escalating this command to "workspace-write"')
    expect(consulted).not.toHaveBeenCalled()
    expect(events.map(e => e.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(events[1]?.data).toMatchObject({ outcome: 'rejected' })
  })

  it('a plain call under a sandboxing executor never consults approval', async () => {
    const { ctx } = await setupSandboxed('read-only', { approval: true })
    const asked = vi.fn()
    ctx.on('approval/request', (_req, next) => { asked(); return next() })
    const result = await callAs(ctx, escalationAgent([]), { command: 'echo plain', description: 'plain run' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('plain')
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('per-session sandbox mode (the bash/sandbox-mode fold)', () => {
  /** Compose the real sandbox stack (passthrough runner) at a given default mode. */
  async function setupModal(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only', opts: { approval?: boolean } = {}) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSandboxProvider, PASSTHROUGH_RUNNER_CONFIG)
    await ctx.plugin(SandboxBashExecutor, { graceMs: 200, mode })
    ;(ctx.bash as SandboxBashExecutor).internals = { spillDir }
    if (opts.approval === true) await ctx.plugin(ApprovalService)
    await ctx.plugin(ToolBash)
    return ctx
  }

  /**
   * An agent stand-in over a REAL Session — the stamping folds real events;
   * the opened turn satisfies approval's enclosure precondition on escalating
   * calls.
   */
  function sessionAgent(id: string): { agent: Agent; session: Session; injected: string[] } {
    const session = new Session(SessionId(id))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const injected: string[] = []
    const agent = {
      id,
      session,
      inject: (content: { type: string; text: string }[]) => { injected.push(content[0]?.text ?? '') },
    } as unknown as Agent
    return { agent, session, injected }
  }

  let modeCall = 0
  const callAs = (ctx: Context, agent: Agent | undefined, args: unknown) =>
    ctx.tools.execute({ callId: CallId(`call-mode-${++modeCall}`), name: 'bash', arguments: args, ...agent ? { agent } : {} })


  it('stamps calls with grant > session override > nothing (executor default)', async () => {
    const ctx = await setupModal('read-only', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const seen: (string | undefined)[] = []
    const original = ctx.bash.resolve.bind(ctx.bash)
    vi.spyOn(ctx.bash, 'resolve').mockImplementation((req) => {
      seen.push(req.sandboxMode)
      return original(req)
    })
    const { agent, session } = sessionAgent('sess-stamp-1')
    const run = { command: 'true', description: 'stamp probe' }
    await callAs(ctx, agent, run)                       // no override yet
    setSandboxMode(session, 'workspace-write')
    await callAs(ctx, agent, run)                       // standing override
    await callAs(ctx, undefined, run)                   // agent-less caller: no session to fold
    await callAs(ctx, agent, { ...run, sandbox_permissions: 'danger-full-access', justification: 'grant outranks override' })
    expect(seen).toEqual([undefined, 'workspace-write', undefined, 'danger-full-access'])
  })

  it('escalates relative to the session effective mode, not the executor default (narrower override)', async () => {
    // With a workspace-write default and read-only override, escalation must return to
    // workspace-write. The static target vocabulary exposes it, and validation compares it with
    // the call's effective override rather than a default-relative ladder.
    const ctx = await setupModal('workspace-write', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const seen: (string | undefined)[] = []
    const original = ctx.bash.resolve.bind(ctx.bash)
    vi.spyOn(ctx.bash, 'resolve').mockImplementation((req) => {
      seen.push(req.sandboxMode)
      return original(req)
    })
    const { agent, session } = sessionAgent('sess-esc-narrow')
    setSandboxMode(session, 'read-only')
    const result = await callAs(ctx, agent, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: 'the override is narrower than the default' })
    expect(result.isError).toBe(false)
    expect(seen).toEqual(['workspace-write'])
  })

  it('a danger-full-access default still offers the lever to a narrower-switched session', async () => {
    // Under the default-relative ladder these fields VANISHED (nothing is
    // wider than the default), stranding a read-only-overridden session
    // with no escalation path at all.
    const ctx = await setupModal('danger-full-access', { approval: true })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const schema = ctx.tools.schemas().find(t => t.name === 'bash') as unknown as { parameters: { properties: Record<string, { enum?: string[] }> } }
    expect(schema.parameters.properties['sandbox_permissions']?.enum).toEqual(['workspace-write', 'danger-full-access'])
    const { agent, session } = sessionAgent('sess-esc-dfa')
    setSandboxMode(session, 'read-only')
    const result = await callAs(ctx, agent, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: 'confined by override under a wide default' })
    expect(result.isError).toBe(false)
  })

  it('rejects a non-widening request against the OVERRIDDEN effective mode without prompting', async () => {
    const ctx = await setupModal('read-only', { approval: true })
    const consulted = vi.fn()
    ctx.on('approval/request', (_req, next) => { consulted(); return next() })
    const { agent, session } = sessionAgent('sess-esc-nonwide')
    setSandboxMode(session, 'danger-full-access')
    const result = await callAs(ctx, agent, { command: 'true', description: 'd', sandbox_permissions: 'workspace-write', justification: 'already wider via override' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not strictly wider than this call\'s current "danger-full-access" mode')
    expect(consulted).not.toHaveBeenCalled()
  })

  it('never stamps an override under a non-sandboxing executor (nothing honors it)', async () => {
    const ctx = await setup()
    const seen: (string | undefined)[] = []
    const original = ctx.bash.resolve.bind(ctx.bash)
    vi.spyOn(ctx.bash, 'resolve').mockImplementation((req) => {
      seen.push(req.sandboxMode)
      return original(req)
    })
    const { agent, session } = sessionAgent('sess-stamp-2')
    setSandboxMode(session, 'danger-full-access')
    await callAs(ctx, agent, { command: 'true', description: 'plain probe' })
    expect(seen).toEqual([undefined])
  })

})
