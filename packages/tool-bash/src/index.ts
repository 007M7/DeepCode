/**
 * The model-facing bash tools: `bash`, `bash_output`, `bash_kill`. Pure
 * schema + text shaping — every process concern lives behind the `ctx.bash`
 * executor seam (`@deepseek-ai/dsh-bash`), so sandbox/permission/remote
 * executor implementations swap in without touching what the model sees.
 *
 * Background notifications: when a background task completes, a short notice
 * is injected into the owning agent's session (`agent.inject()` — the
 * documented context seam). Injection is durable context for the NEXT model
 * request, not a wake-up: an idle agent stays idle until something sends a
 * message, which is why the tool descriptions tell the model to poll with
 * `bash_output`.
 *
 * TODO(permissions): commands run with the executor's full authority. The
 * permission/sandbox seam is the `tools/execute` waterfall (veto/ask) plus
 * sandboxing `BashExecutor` implementations — see docs/architecture.md
 * § plugin checklist.
 *
 * @module @deepseek-ai/dsh-tool-bash
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BashRunResult, BashTask, CollectedOutput } from '@deepseek-ai/dsh-bash'

export const name = 'tool-bash'
export const inject = ['tools', 'bash']

/**
 * Validate model-produced arguments. `defineTool`'s `InferArgs` typing is
 * compile-time only — at runtime `arguments` is whatever JSON the model
 * emitted, so every field is checked before it reaches the executor.
 *
 * TODO(RFC 005): this hand-rolled validation is the per-tool stopgap until
 * `defineTool` validates parsed args against the SchemaSpec itself (the
 * converter already encodes the structure). When that lands, delete this and
 * let the registry reject malformed calls — see docs/rfc/005.
 */
function validateBashArgs(args: {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
}): void {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined
    && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.workdir !== undefined && typeof args.workdir !== 'string') {
    throw new Error(`invalid workdir: expected a string, got ${JSON.stringify(args.workdir)}`)
  }
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') {
    throw new Error(`invalid run_in_background: expected a boolean, got ${JSON.stringify(args.run_in_background)}`)
  }
}

/** Require a string `task_id` (model-produced, so runtime-checked). */
function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid task_id: expected a string, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are REPORTED, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 */
export function renderResult(result: BashRunResult): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // Timeout is reported independently of how the process actually ended: a
  // command can trap SIGTERM and exit 0 after our timer fired (e.g.
  // `trap "exit 0" TERM; sleep 60`), giving timedOut:true / exitCode:0 /
  // signal:null — the model must still see that the command was cut short.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** Status line for background task reads. */
function statusLine(task: BashTask): string {
  switch (task.status) {
    case 'running': return '[status: running]'
    case 'killed': return `[status: killed${task.signal !== null ? ` by ${task.signal}` : ''}]`
    case 'completed': return `[status: completed, exit code: ${task.exitCode ?? 0}]`
  }
}

export function apply(ctx: Context): void {
  // Background completion → inject a notice into the owning agent's session.
  // Tracks the agent per task id; entries drop once notified.
  const owners = new Map<string, Agent>()
  ctx.bash.onTaskDone((task) => {
    const agent = owners.get(task.id)
    owners.delete(task.id)
    if (!agent) return
    try {
      agent.inject(
        [{ type: 'text', text: `background bash task ${task.id} finished ${statusLine(task)}. Read its output with bash_output.` }],
        { source: { kind: 'plugin', plugin: 'tool-bash' } },
      )
    } catch (error: unknown) {
      // The ONE expected failure: the agent was disposed between task
      // completion and this injection (LoopAgent.inject throws
      // `agent "<id>" is disposed`). That race is benign — drop the notice.
      // Anything else is a real bug and must surface, not be swallowed.
      if (error instanceof Error && error.message.includes('is disposed')) return
      throw error
    }
  })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
      + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
      + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
      + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported. '
      + 'Set `run_in_background: true` for long-running commands: the call returns a task id immediately; '
      + 'poll it with `bash_output` and stop it with `bash_kill`.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000). The command is killed on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command.' },
      run_in_background: { type: 'boolean', description: 'Run in the background and return a task id immediately. No timeout applies.' },
    },
    async execute(args, exec) {
      validateBashArgs(args)
      // `description` is display/logging metadata only (surfaced to UIs via
      // the tool/call session event); it is intentionally NOT forwarded to
      // ctx.bash and has no effect on execution.
      const request = {
        command: args.command,
        ...args.workdir !== undefined ? { workdir: args.workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...exec.signal ? { signal: exec.signal } : {},
      }
      if (args.run_in_background === true) {
        const task = ctx.bash.start(ctx.bash.resolve(request))
        if (exec.agent) owners.set(task.id, exec.agent)
        return [{ type: 'text', text: `started background task ${task.id}` }]
      }
      const result = await ctx.bash.run(ctx.bash.resolve(request))
      if (result.aborted) throw new Error('command aborted')
      return [{ type: 'text', text: renderResult(result) }]
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bash_output',
    description: 'Read new output from a background bash task started with `bash` + `run_in_background`. '
      + 'Returns only output produced since the previous bash_output call, plus the task status. '
      + 'Tasks keep running while you do other work; poll again later for more output.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the bash tool.' },
    },
    // execute is synchronous (registry reads + string shaping) but the
    // ToolDefinition contract wants a Promise — hence resolve(), not async.
    execute(args) {
      const read = ctx.bash.readOutput(validateTaskId(args.task_id))
      let text = read.delta.length > 0 ? read.delta : '(no new output)'
      if (read.lossy) {
        const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p): p is string => p !== undefined)
        text += `\n[some output was dropped from memory; full output: ${paths.join(', ')}]`
      }
      text += `\n${statusLine(read.task)}`
      return Promise.resolve([{ type: 'text', text }])
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bash_kill',
    description: 'Kill a running background bash task (SIGTERM, then SIGKILL) by task id.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the bash tool.' },
    },
    execute(args) {
      const id = validateTaskId(args.task_id)
      const killed = ctx.bash.kill(id)
      return Promise.resolve([{
        type: 'text',
        text: killed ? `killed background task ${id}` : `task ${id} had already finished`,
      }])
    },
  }))
}
