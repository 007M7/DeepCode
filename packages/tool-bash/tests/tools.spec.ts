import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { renderResult } from '@deepseek-ai/dsh-tool-bash'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-spec-'))

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  ;(ctx.bash as LocalBashExecutor).internals = { spillDir, graceMs: 200 }
  await ctx.plugin(ToolBash)
  return ctx
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ callId: CallId(`call-${++callCounter}`), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
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
    await ctx.plugin(LocalBashExecutor, { maxOutputBytes: 100 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir, graceMs: 200 }
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
    [{ command: 'x', description: 'd', timeoutMs: Number.NaN }, /invalid timeoutMs/],
  ])('rejects value-invalid args %j', async (args, pattern) => {
    const ctx = await setup()
    const result = await call(ctx, 'bash', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
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

  it('unregisters everything when the plugin fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, {})
    const fiber = await ctx.plugin(ToolBash)
    expect(ctx.tools.schemas()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
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
    const started = await call(ctx, 'bash', { command: 'echo first; sleep 0.3; echo second', description: 'test command', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!

    await new Promise(resolve => setTimeout(resolve, 150))
    const first = await call(ctx, 'bash_output', { task_id: id })
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
    await ctx.plugin(LocalBashExecutor, { maxOutputBytes: 100 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir, graceMs: 200 }
    await ctx.plugin(ToolBash)

    const started = await call(ctx, 'bash', { command: 'for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', description: 'test command', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    await ctx.bash.get(id)!.done
    const read = await call(ctx, 'bash_output', { task_id: id })
    expect(text(read)).toContain('[some output was dropped from memory; full output: ')
  })

  it('bash_kill stops a running task; repeat reports already-finished', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'sleep 60', description: 'test command', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!

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

  it('injects a completion notice into the owning agent', async () => {
    const ctx = await setup()
    const inject = vi.fn()
    const agent = { inject, session: { header: { version: 1, id: 'bg', createdAt: 0 } } } as unknown as import('@deepseek-ai/dsh-agent').Agent

    const started = await ctx.tools.execute({
      callId: CallId('call-bg'),
      name: 'bash',
      arguments: { command: 'true', description: 'test command', run_in_background: true },
      agent,
    })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
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
    const agent = {
      inject: () => { throw new Error('agent "x" is disposed') },
      session: { header: { version: 1, id: 'bg', createdAt: 0 } },
    } as unknown as import('@deepseek-ai/dsh-agent').Agent

    const started = await ctx.tools.execute({
      callId: CallId('call-bg2'),
      name: 'bash',
      arguments: { command: 'true', description: 'test command', run_in_background: true },
      agent,
    })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    await expect(ctx.bash.get(id)!.done).resolves.toBeUndefined()
  })

  it('rethrows a non-disposed inject failure (not blindly swallowed)', async () => {
    const ctx = await setup()
    // A real bug in inject (not the benign disposed race) must surface — the
    // base-class notifier contains it (logs, does not reject task.done), but
    // the listener itself must have thrown rather than silently eaten it.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const agent = {
        inject: () => { throw new Error('unexpected inject bug') },
        session: { header: { version: 1, id: 'bg', createdAt: 0 } },
      } as unknown as import('@deepseek-ai/dsh-agent').Agent

      const started = await ctx.tools.execute({
        callId: CallId('call-bg3'),
        name: 'bash',
        arguments: { command: 'true', description: 'test command', run_in_background: true },
        agent,
      })
      const id = /task (bash-\d+)/.exec(text(started))![1]!
      await ctx.bash.get(id)!.done
      // notifyTaskDone caught and logged the rethrown error.
      expect(errorSpy).toHaveBeenCalled()
      const logged = errorSpy.mock.calls.flat().some(arg => arg instanceof Error && arg.message === 'unexpected inject bug')
      expect(logged).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not notify when no agent owned the task', async () => {
    const ctx = await setup()
    const started = await call(ctx, 'bash', { command: 'true', description: 'test command', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    await expect(ctx.bash.get(id)!.done).resolves.toBeUndefined()
  })
})

describe('background task ownership (cross-session isolation)', () => {
  /** Run a tool on behalf of a specific agent (sets exec.agent). */
  function callAs(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent | undefined, name: string, args: unknown) {
    return ctx.tools.execute({ callId: CallId(`own-${++callCounter}`), name, arguments: args, ...agent ? { agent } : {} })
  }
  // Distinct identities — ownership is by agent object identity, not id.
  const fakeAgent = () => ({ inject: () => undefined, session: { header: { version: 1, id: 'bg', createdAt: 0 } } }) as unknown as import('@deepseek-ai/dsh-agent').Agent

  it('rejects bash_output/bash_kill for a task owned by a DIFFERENT agent', async () => {
    const ctx = await setup()
    const a = fakeAgent()
    const b = fakeAgent()
    // Agent A starts a long-running background task.
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!

    // Agent B cannot read or kill A's task.
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

  it('the no-agent (non-loop) caller cannot access an owned task', async () => {
    const ctx = await setup()
    const a = fakeAgent()
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    // A call with no exec.agent cannot prove ownership of an owned task.
    const read = await callAs(ctx, undefined, 'bash_output', { task_id: id })
    expect(read.isError).toBe(true)
    expect(text(read)).toMatch(/belongs to another session/)
    await callAs(ctx, a, 'bash_kill', { task_id: id }) // cleanup
  })

  it('an UNOWNED task (started with no agent) is accessible to anyone', async () => {
    const ctx = await setup()
    // Started by a non-loop caller (no exec.agent) → no recorded owner.
    const started = await callAs(ctx, undefined, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    // Any agent (and the no-agent caller) may read/kill it.
    const read = await callAs(ctx, fakeAgent(), 'bash_output', { task_id: id })
    expect(read.isError).toBe(false)
    const killed = await callAs(ctx, undefined, 'bash_kill', { task_id: id })
    expect(killed.isError).toBe(false)
  })

  it('the owner can still access its task AFTER it completes (owner record persists)', async () => {
    const ctx = await setup()
    const a = fakeAgent()
    const b = fakeAgent()
    const started = await callAs(ctx, a, 'bash', { command: 'echo done', description: 'bg', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    await ctx.bash.get(id)!.done
    // Completion does NOT clear ownership: B is still rejected, A still allowed.
    const readByB = await callAs(ctx, b, 'bash_output', { task_id: id })
    expect(readByB.isError).toBe(true)
    expect(text(readByB)).toMatch(/belongs to another session/)
    const readByA = await callAs(ctx, a, 'bash_output', { task_id: id })
    expect(readByA.isError).toBe(false)
  })

  it('documents the HMR caveat: an independent tool-bash reload resets ownership', async () => {
    // The ownership map is per-plugin-instance (TODO(tool-bash-owner-hmr)). When
    // ONLY tool-bash is reloaded (bash/executor + task survive), the new instance
    // has an empty map, so the previously-owned task becomes unowned (open). This
    // test pins that documented behavior — a regression here (e.g. an accidental
    // global map) would change it.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    ;(ctx.bash as LocalBashExecutor).internals = { spillDir, graceMs: 200 }
    const fiber = await ctx.plugin(ToolBash)

    const a = fakeAgent()
    const b = fakeAgent()
    const started = await callAs(ctx, a, 'bash', { command: 'sleep 60', description: 'bg', run_in_background: true })
    const id = /task (bash-\d+)/.exec(text(started))![1]!
    // Before reload: B is rejected (A owns it).
    expect((await callAs(ctx, b, 'bash_output', { task_id: id })).isError).toBe(true)

    // Reload ONLY tool-bash; the executor and its running task survive.
    await fiber.dispose()
    await ctx.plugin(ToolBash)
    expect(ctx.bash.get(id)?.status).toBe('running')

    // After reload the fresh map has no owner → B can now access it (the caveat).
    expect((await callAs(ctx, b, 'bash_output', { task_id: id })).isError).toBe(false)
    await callAs(ctx, b, 'bash_kill', { task_id: id }) // cleanup
  })
})

describe('session-cwd routing (per-session workdir)', () => {
  function callAs(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent | undefined, args: unknown) {
    return ctx.tools.execute({ callId: CallId(`cwd-${++callCounter}`), name: 'bash', arguments: args, ...agent ? { agent } : {} })
  }
  // An agent whose session header carries a cwd (what session/new records).
  const agentInCwd = (cwd: string) =>
    ({ inject: () => undefined, session: { header: { version: 1, id: 'c', createdAt: 0, cwd } } }) as unknown as import('@deepseek-ai/dsh-agent').Agent

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
    const id = /task (bash-\d+)/.exec(text(started))![1]!
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
    const id = /task (bash-\d+)/.exec(text(started))![1]!
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
  it('bash presentCall: title is "description — command" (execute cards hide rawInput), command also in rawInput', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')?.presentCall?.({ command: 'ls -la src', description: 'List files in src' })
    expect(present).toEqual({ title: 'List files in src — ls -la src', kind: 'execute', rawInput: 'ls -la src' })
  })

  it('bash presentResult: wraps the model-facing text in a fenced console block', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')!.presentResult!(
      { command: 'echo hi', description: 'echo' },
      { content: [{ type: 'text', text: 'hi\n[exit code: 0]\n\n' }], isError: false },
    )
    // Trailing blank lines are trimmed; the body is fenced as ```console.
    expect(present).toEqual({ content: [{ type: 'text', text: '```console\nhi\n[exit code: 0]\n```' }] })
  })

  it('bash presentResult: leaves a non-text (unexpected) result untouched → undefined (UI keeps raw content)', async () => {
    const ctx = await setup()
    const present = ctx.tools.get('bash')!.presentResult!(
      { command: 'x', description: 'x' },
      { content: [{ type: 'image', url: 'https://x/y.png' }], isError: false },
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
      .toEqual({ title: 'Read output from background task bash-3', kind: 'execute', rawInput: 'bash-3' })
    expect(ctx.tools.get('bash_kill')!.presentCall!({ task_id: 'bash-3' }))
      .toEqual({ title: 'Kill background task bash-3', kind: 'execute', rawInput: 'bash-3' })
  })

  it('presentCall validates softly: malformed args (missing required description) return undefined, never throw', async () => {
    const ctx = await setup()
    // defineTool wraps presentCall to soft-validate against the schema and fall
    // back to undefined (a generic UI presentation) rather than throwing on the
    // display path — it may run on replay of arbitrary logged args. The
    // ToolDefinition.presentCall takes `unknown`, so a malformed shape needs no cast.
    expect(ctx.tools.get('bash')?.presentCall?.({ command: 'ls' })).toBeUndefined()
  })
})
