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
 * Task ownership: a background task's OWNER is an opaque token — the owning
 * agent's `session.header.id` — passed to the executor at spawn
 * (`resolve({ …, owner })`) and stored ON THE TASK inside the executor
 * (`@deepseek-ai/dsh-bash`'s `ownerOf(id)` seam), NOT in a plugin-local map.
 * `bash_output`/`bash_kill` compare `ctx.bash.ownerOf(id)` to the caller's token
 * and reject a task owned by a DIFFERENT session (`owner !== undefined && owner
 * !== caller`); an unowned task (no token — started by a non-agent caller) is
 * open to anyone. Task ids are global and predictable (`bash-1`, …); under
 * multi-session ACP (RFC 011) this token check is the fence that stops one
 * session's agent from reading or killing another session's background task.
 *
 * Storing the token on the task in the EXECUTOR (disposed with the `dsh-bash`
 * fiber), rather than in this plugin, is what makes ownership survive a
 * `tool-bash` HMR reload — a reload that reset a plugin-local map would orphan
 * a task spawned before it. (The `onTaskDone` listener is still effect-scoped
 * to this plugin's `apply`, so a
 * completion landing during the reload gap still drops its one notice — the
 * pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)
 *
 * TODO(permissions): commands run with the executor's full authority. The
 * permission/sandbox seam is the `tools/pre-execute` waterfall (deny/ask) plus
 * sandboxing `BashExecutor` implementations — see docs/architecture.md
 * § Extending The Harness.
 *
 * @module @deepseek-ai/dsh-tool-bash
 */

import type { Context } from 'cordis'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BashTaskId, OwnerToken } from '@deepseek-ai/dsh-bash'
import type { BashRunResult, BashTask, CollectedOutput } from '@deepseek-ai/dsh-bash'

export const name = 'tool-bash'
export const inject = ['tools', 'bash']

/**
 * Validate the constraints the SchemaSpec can't express. `defineTool` now
 * validates parsed args against the SchemaSpec before `execute` runs (the
 * arg-validation RFC), so type/required/enum checks are already done and `args`
 * is the validated `InferArgs` shape here. What remains are value constraints
 * the DSL has no vocabulary for: non-empty strings and a positive, finite
 * timeout.
 */
function validateBashArgs(args: {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
}): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

/**
 * Reject an empty `task_id`. Type and presence are guaranteed by the
 * SchemaSpec validation (the arg-validation RFC); only the non-empty constraint, which the
 * DSL can't express, is left to check here.
 */
function validateTaskId(value: string): BashTaskId {
  if (value.length === 0) {
    throw new Error(`invalid task_id: expected a string, got ${JSON.stringify(value)}`)
  }
  return BashTaskId(value)
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

// ---------------------------------------------------------------------------
// UI presentation (tool-owned). These shape how a UI (e.g. the ACP bridge)
// renders a bash call's pending and completed states. They are display-only and
// pure — a UI may call them during live streaming AND a session-log replay.
// ---------------------------------------------------------------------------

/**
 * Pending-state presentation for a `bash` call. The TITLE is the exact `command`
 * — a `kind: 'execute'` card is rendered as a terminal whose header label IS the
 * title, and an execute-kind card HIDES `rawInput` (Zed: `should_show_raw_input
 * = !is_terminal_tool`), so the command must BE the title to be seen. This
 * mirrors the reference ACP adapters (claude-agent-acp, codex-acp), which both
 * use the bare command as an execute tool's title. The model-written
 * `description` (a readable summary) rides as a `content` text block shown ABOVE
 * the card. (Note: claude-agent-acp DROPS the description in terminal mode and
 * shows only the card; surfacing it as a content block is a deliberate
 * divergence here — we keep the human summary visible alongside the card.)
 * `rawInput` still carries the bare command for non-execute UIs that DO render it.
 *
 * `terminal` marks the call so a capable UI renders a TERMINAL card — but ONLY a
 * FOREGROUND run is a terminal: a `run_in_background` call returns a task id
 * immediately (it never streams a terminal; its output is polled via
 * `bash_output`), so it is NOT marked terminal and renders as an ordinary
 * execute card. For a foreground run the `terminal.cwd` (header) is the model
 * `workdir` when given — ABSOLUTE as-is, RELATIVE for the UI bridge to resolve
 * against the session cwd; when omitted the bridge fills the session workspace
 * cwd (this PURE presenter, args only, can't see it).
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  // A background start is not an interactive terminal — a generic execute card
  // with the command as rawInput and the description as a content block.
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  // A foreground run IS a terminal: the command titles the card, the description
  // renders above it, and the cwd (when the model gave a workdir) heads it.
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Completed-state presentation for a `bash` call. Two parallel renderings of the
 * same output: `terminal.output` for a UI that shows a terminal card (the run's
 * stdout/stderr + status markers, exactly as the model sees them — the RAW text,
 * newlines preserved, since a terminal renderer relies on exact bytes), and a
 * fenced ```console `content` block as the fallback for a UI without terminal
 * support (the fences are a UI-only affordance, so they live here, not in the
 * model-facing result; the fenced body is trimmed of trailing blank lines for a
 * tidy block). A capable UI also gets an exit-status pill from `terminal.exitCode`
 * / `terminal.signal`, parsed from the status markers `renderResult` appended.
 *
 * Terminal output/exit is suppressed for results that are NOT a finished
 * foreground run: a `run_in_background` start (`isBackground` — the text is a
 * task-id ack, not a streamed run) and an `isError` result (a spawn failure or
 * abort — there is no real process exit to pill, and the body is an error
 * message, not `renderResult` output, so parsing it would be meaningless). Those
 * return a `generic` result whose content is the fenced ```console block. A
 * finished foreground run returns a `terminal` result carrying the RAW output
 * and the parsed exit status; the BRIDGE derives the fenced fallback from
 * `output` for a UI without terminal support, so the tool does not double-encode
 * it. A non-text result (unexpected for bash) falls through to `undefined`.
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  // A background ack or an errored run is not a real terminal exit: render the
  // fenced ```console fallback as generic content (no exit pill).
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  // A finished foreground run: RAW output + parsed exit for the terminal card.
  // The bridge derives the no-capability fenced fallback from `output`.
  return { card: 'terminal', output: raw, ...parseExitStatus(raw) }
}

/**
 * Recover the structured exit status from a rendered `renderResult` string — the
 * inverse of the status markers it appends. A `[killed by signal: SIG]` marker
 * yields `{signal}`; otherwise an `[exit code: N]` marker yields `{exitCode:N}`;
 * absent both we report `{exitCode:0}` (a clean run appends no marker — and a
 * trapped-timeout run that exits 0 also has none and is accurately exit 0).
 *
 * Why parse rendered text at all: `presentResult` is replay-safe and on a
 * `session/load` the ONLY thing persisted is this content text — the structured
 * `BashRunResult` is long gone — so unless the exit were added to the persisted
 * event schema (deliberately NOT done; see the terminal-rendering RFC), parsing
 * is the only channel. The match is anchored to a LEADING newline + end-of-string
 * because `renderResult` always inserts a `\n` before the marker (line ~124) onto
 * a non-empty body: a real marker is therefore always its own final line. That
 * defeats the common spoof (program output that simply ENDS in `[exit code: 5]`
 * with no trailing newline — a clean exit 0 — no longer reads as a failure).
 *
 * KNOWN RESIDUAL (inherent to the replay-only-sees-text design): a clean exit 0
 * whose body's FINAL line is itself exactly the marker text — `[exit code: N]`
 * or `[killed by signal: SIG]`, printed by the program with nothing after — is
 * still indistinguishable from a real marker and would show a wrong pill. This is
 * display-only (execution and the model-facing text are unaffected) and narrow;
 * the complete fix is to persist a structured exit on the result event, which the
 * RFC names as the escape hatch.
 */
function parseExitStatus(text: string): { exitCode: number } | { signal: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { exitCode: Number(exit[1]) }
  return { exitCode: 0 }
}

/** Pending-state presentation for `bash_output`/`bash_kill` (background-task tools). */
function presentTaskCall(verb: string, args: { task_id: string }): GenericCallView {
  return { card: 'generic', title: `${verb} background task ${args.task_id}`, kind: 'execute', rawInput: args.task_id }
}

/**
 * Resolve the working directory for a bash call. Precedence: an explicit model
 * `workdir` wins; otherwise default to the calling agent's session cwd
 * (`session.header.cwd`) so each ACP session's commands run in ITS workspace,
 * not the server's launch dir. A RELATIVE model `workdir` is resolved against
 * the session cwd (the tool tells the model to pass `workdir` instead of `cd`,
 * so a relative one should be relative to the session's root, not `process.cwd()`).
 * Returns `undefined` when neither is available (no agent / headerless session /
 * no session cwd) — the executor then applies its own config/`process.cwd()`
 * default, preserving today's non-ACP behavior.
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: Agent }): string | undefined {
  const sessionCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
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
  /**
   * The caller's owner TOKEN — the owning agent's `session.header.id`, or
   * `undefined` for a non-agent caller. Read `session.header.id` (NOT
   * `session.id`): every other subsystem keys off the header id (the ACP bridge,
   * both persistence backends), and the sibling `resolveWorkdir` already reads
   * `session.header.cwd`, so using `session.id` here would be the asymmetry smell
   * the conventions flag. The two are equal in production, but the header is the
   * canonical identity.
   */
  const callerToken = (exec: { agent?: Agent }): OwnerToken | undefined =>
    exec.agent ? OwnerToken(exec.agent.session.header.id) : undefined

  /**
   * Authorize a `bash_output`/`bash_kill` call against the task's stored owner
   * token. Rejects when the task HAS an owner and it differs from the caller's
   * token — using `!== undefined` semantics, NOT truthiness, so an empty-string
   * token is still a real owner (never treated as unowned). An unowned task
   * (`ownerOf` returns `undefined`) is allowed; a truly unknown id is also
   * `undefined` here and then fails loudly at the subsequent
   * `readOutput`/`kill` ("unknown bash task"). The conservative no-agent caller
   * (`callerToken` undefined) cannot match an owned task and is rejected.
   */
  const assertTaskAccess = (taskId: BashTaskId, exec: { agent?: Agent }): void => {
    const owner = ctx.bash.ownerOf(taskId)
    if (owner !== undefined && owner !== callerToken(exec)) {
      throw new Error(`task ${taskId} belongs to another session`)
    }
  }

  // Background completion → inject a notice into the owning agent's session.
  // Find the live agent by its session id token via the agent registry, read
  // opportunistically with `ctx.get('agents')` (NOT `ctx.agents`/static inject):
  // this listener runs from `task.done.then` on the bash fiber — a foreign
  // fiber — where the `ctx.agents` property proxy would throw through the
  // traceable shadow; `ctx.get(name)` is the topology-independent lookup. No
  // registry mounted (`undefined`) → drop the notice. Match on
  // `agent.session.header.id`, NOT the registry key: a config agent's id differs
  // from its session id, and the owner token IS the session id.
  ctx.bash.onTaskDone((task) => {
    const ownerToken = ctx.bash.ownerOf(task.id)
    if (ownerToken === undefined) return
    const agent = ctx.get('agents')?.list().find(a => OwnerToken(a.session.header.id) === ownerToken)
    if (!agent) return
    try {
      agent.inject(
        [{ type: 'text', text: `background bash task ${task.id} finished ${statusLine(task)}. Read its output with bash_output.` }],
        { source: { kind: 'plugin', plugin: 'tool-bash' } },
      )
    } catch (error: unknown) {
      // The ONE expected failure: the agent was disposed between task
      // completion and this injection (ReactLoopAgent.inject throws
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
      + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
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
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      run_in_background: { type: 'boolean', description: 'Run in the background and return a task id immediately. No timeout applies.' },
    },
    async execute(args, exec) {
      validateBashArgs(args)
      // `description` is display/logging metadata only (surfaced to UIs via
      // the tool/call session event); it is intentionally NOT forwarded to
      // ctx.bash and has no effect on execution.
      // Default the workdir to the calling agent's session cwd so each ACP
      // session runs in its own workspace (see resolveWorkdir); an explicit
      // model workdir still wins.
      const workdir = resolveWorkdir(args.workdir, exec)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...exec.signal ? { signal: exec.signal } : {},
      }
      if (args.run_in_background === true) {
        // Stamp the owner token (the agent's session id) onto the spec so the
        // executor stores it on the task — the isolation fence for bash_output/
        // bash_kill. Foreground runs pass no owner (they finish inline; nothing
        // to fence).
        const task = ctx.bash.start(ctx.bash.resolve({ ...request, owner: callerToken(exec) }))
        return [{ type: 'text', text: `started background task ${task.id}` }]
      }
      const result = await ctx.bash.run(ctx.bash.resolve(request))
      if (result.aborted) throw new Error('command aborted')
      return [{ type: 'text', text: renderResult(result) }]
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
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
    execute(args, exec) {
      const id = validateTaskId(args.task_id)
      assertTaskAccess(id, exec)
      const read = ctx.bash.readOutput(id)
      let text = read.delta.length > 0 ? read.delta : '(no new output)'
      if (read.lossy) {
        const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p): p is string => p !== undefined)
        const fullOutput = paths.length > 0 ? paths.join(', ') : '(unavailable)'
        text += `\n[some output was dropped from memory; full output: ${fullOutput}]`
      }
      text += `\n${statusLine(read.task)}`
      return Promise.resolve([{ type: 'text', text }])
    },
    presentCall: args => presentTaskCall('Read output from', args),
  }))

  ctx.tools.register(defineTool({
    name: 'bash_kill',
    description: 'Ask the executor to kill a running background bash task by task id.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the bash tool.' },
    },
    execute(args, exec) {
      const id = validateTaskId(args.task_id)
      assertTaskAccess(id, exec)
      const killed = ctx.bash.kill(id)
      return Promise.resolve([{
        type: 'text',
        text: killed ? `killed background task ${id}` : `task ${id} had already finished`,
      }])
    },
    presentCall: args => presentTaskCall('Kill', args),
  }))
}
