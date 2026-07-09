/**
 * The model-facing `bash` tool. Pure schema + text shaping — every process
 * concern lives behind the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`),
 * so sandbox/permission/remote executor implementations swap in without
 * touching what the model sees.
 *
 * Background runs are TASKS, not bash-private state: `run_in_background`
 * starts a process through the seam and registers its handle with the generic
 * `ctx.tasks` runtime (`@deepseek-ai/dsh-tasks`), which owns the id, the
 * owner fence, the completion notice, and the model-facing collect/stop
 * tools (`task_output`/`task_list`/`task_kill` from
 * `@deepseek-ai/dsh-tool-tasks`). Whether the parameter is exposed at all is
 * THIS plugin's `enableRunInBackground` config (default on) — the registry
 * never rewrites a producer's schema.
 *
 * The tool-call abort signal is deliberately NOT wired to a background
 * process: after the task id is returned the parent step may end while the
 * work continues; cancellation belongs to `task_kill` and the owner-disposal
 * cleanup. A signal already aborted before the call refuses to start.
 *
 * TODO(permissions): commands run with the executor's full authority. The
 * permission/sandbox seam is the `tools/pre-execute` waterfall (deny/ask) plus
 * sandboxing `BashExecutor` implementations — see docs/architecture.md
 * § Extending The Harness.
 *
 * @module @deepseek-ai/dsh-tool-bash
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tasks'
import type { BashProcess, BashProcessRead, BashRunResult, CollectedOutput } from '@deepseek-ai/dsh-bash'

export const name = 'tool-bash'
export const inject = ['tools', 'bash', 'systemPrompt']

/** Config: whether the model may background commands (the producer-opt-in flag). */
export interface Config {
  /**
   * Expose `run_in_background` in the bash schema (default true). Disabled,
   * the parameter is absent entirely — schema and capability never disagree.
   * Backgrounding also needs the `ctx.tasks` runtime at call time; a missing
   * one fails the call loud with the load-these-packages message.
   */
  enableRunInBackground?: boolean
}

export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
})

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
 * @param result - the completed foreground run from the executor.
 * @returns the model-facing text: output body (or `(no output)`), then any timeout/signal/exit markers, each on its own line.
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

/**
 * Shape one background-process read into the `task_output` delta the model
 * sees: the incremental delta, plus the lossy-read notice (with full-stream
 * spill paths) when in-memory truncation dropped unread bytes. Empty-delta
 * rendering (`(no new output)`) is the control surface's job, not this
 * producer's. Exported for tests.
 * @param read - one incremental read from the process handle.
 * @returns the delta text with any loss notice appended.
 */
export function renderProcessRead(read: BashProcessRead): string {
  if (!read.lossy) return read.delta
  const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p): p is string => p !== undefined)
  const notice = `[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`
  if (read.delta.length === 0) return notice
  return `${read.delta}${read.delta.endsWith('\n') ? '' : '\n'}${notice}`
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail — a nonzero exit is
 * REPORTED, not failed, exactly like the foreground rendering. Exported for
 * tests.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.tasks` registration.
 */
export function processOutcome(proc: BashProcess): { status: 'completed' | 'killed'; detail: string } {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
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
 * `task_output`), so it is NOT marked terminal and renders as an ordinary
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

export function apply(ctx: Context, config: Config): void {
  const backgroundEnabled = config.enableRunInBackground ?? true

  // The bash tool's cross-call HABIT, which the per-tool description cannot
  // carry (it describes one call): the exit-code marker is only useful
  // if the model actually checks it every time.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
      + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
      + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
      + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
      + (backgroundEnabled
        ? 'Set `run_in_background: true` for long-running commands: the call returns a task id immediately; '
          + 'read its output with `task_output` and stop it with `task_kill`.'
        : 'Background execution is not available; long-running commands must finish within the timeout.'),
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
      ...backgroundEnabled ? {
        run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a task id immediately (collect with task_output, stop with task_kill). No timeout applies.' },
      } : {},
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
      }
      if (args.run_in_background === true) {
        // The generic runtime owns everything task-shaped; without it a task
        // id would be uncollectable — fail loud with the fix, not a dangle.
        const tasks = ctx.get('tasks')
        if (tasks === undefined) {
          throw new Error('background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks')
        }
        // A step already cancelled must not spawn; after the id is returned
        // the tool-call signal is deliberately NOT wired to the process
        // (cancellation belongs to task_kill / owner cleanup), so the check
        // happens here, once, instead of passing the signal to start().
        if (exec.signal?.aborted) throw new Error('command aborted')
        const proc = ctx.bash.start(ctx.bash.resolve(request))
        let id: string
        try {
          id = tasks.register({
            kind: 'bash',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            cancel: () => void proc.kill(),
            done: proc.done.then(() => processOutcome(proc)),
            readOutput: () => renderProcessRead(proc.readOutput()),
          })
        } catch (error: unknown) {
          // A failed registration must not leak the just-started process: the
          // model never received an id, so nothing could ever task_kill it.
          // Kill, await quiescence, then fail the call with the real cause.
          proc.kill()
          await proc.done
          throw error
        }
        return [{ type: 'text', text: `started background task ${id}` }]
      }
      const result = await ctx.bash.run(ctx.bash.resolve({
        ...request,
        ...exec.signal ? { signal: exec.signal } : {},
      }))
      if (result.aborted) throw new Error('command aborted')
      return [{ type: 'text', text: renderResult(result) }]
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }))
}
