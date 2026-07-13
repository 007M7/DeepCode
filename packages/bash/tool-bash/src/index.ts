/**
 * Model-facing `bash`, `bash_output`, and `bash_kill` tools over the executor
 * seam. Background tasks are fenced by owning session, completion injects a
 * durable notice, and confining executors add one-shot approval-based escalation.
 * @module @deepseek-ai/dsh-tool-bash
 */

import type { Context } from 'cordis'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Side-effect type import: declaration-merges `ctx.approval`, consumed
// opportunistically by the escalation gate (`ctx.get('approval')` — the seam
// stays optional at runtime, same pattern as dsh-tools' ask routing).
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { BashTaskId, OwnerToken, effectiveSandboxMode } from '@deepseek-ai/dsh-bash'
import type { BashRunResult, BashTask, CollectedOutput } from '@deepseek-ai/dsh-bash'

export const name = 'tool-bash'
export const inject = ['tools', 'bash', 'systemPrompt']

/**
 * Validate the constraints the SchemaSpec can't express. `defineTool`
 * validates parsed args against the SchemaSpec before `execute` runs (the
 * arg-validation RFC), so type/required/enum checks are already done and `args`
 * is the validated `InferArgs` shape here. What remains are value constraints
 * the DSL has no vocabulary for: non-empty strings, a positive finite timeout,
 * and the escalation pairing (`sandbox_permissions` and `justification` travel
 * together — an approval prompt without a reason, or a reason driving nothing,
 * is a malformed ask).
 */
function validateBashArgs(args: BashToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.sandbox_permissions !== undefined && args.justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (args.justification !== undefined && args.sandbox_permissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (args.justification !== undefined && args.justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
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

/**
 * The bash tool's validated argument shape — the base parameters plus the two
 * escalation fields, which are ADVERTISED only when the mounted executor
 * reports a confining default mode (absent from the schema otherwise, so the
 * SchemaSpec validator rejects them before `execute` ever sees one).
 */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into the schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
 * whenever the mounted executor confines: cutting the enum down to the modes
 * wider than the executor's DEFAULT would strand a session whose effective
 * mode sits below it (a `danger-full-access` default would advertise nothing
 * while a narrower-switched session stays confined with no lever).
 */
const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * The bash tool's static description.
 */
function bashDescription(escalationModes: readonly SandboxMode[]): string {
  const base = 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
    + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way (a background task reports the same marker via bash_output once it has finished). '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Set `run_in_background: true` for long-running commands: the call returns a task id immediately; '
    + 'poll it with `bash_output` and stop it with `bash_kill`.'
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command IS denied and a wider mode would let it '
    + 'succeed, escalate immediately in the SAME turn — the ONE sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry IS how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively: ground the request in a real denial — normally the one THIS command '
    + 'just hit; escalating up front is fine only when this session already denied the same access. '
    + 'A rejected escalation is final for THAT command — stop and explain, never work around '
    + 'it — but it does not forbid attempting or escalating other commands later.'
}

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into model-visible stdout, marked stderr, and status
 * facts. Non-zero exits and sandbox denials remain ordinary results; only
 * infrastructure failure or abort makes the tool call itself fail.
 *
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises; non-empty
 *   adds the same-turn escalation hint after a denial marker (default `[]`: no hint).
 * @returns the model-facing text: output body (or `(no output)`), then any
 *   timeout/signal/exit markers, each on its own line.
 */
export function renderResult(
  result: BashRunResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
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
  // The sandbox marker precedes the exit-status markers so `[exit code: N]`
  // stays the LAST line (exitStatus() anchors its parse there). Denial is a
  // reported fact like timeout: the model decides how to react.
  if (result.sandbox?.denied) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
    // The same-turn nudge lives at the decision point: only when this
    // composition advertises the fields (a lever is never hinted that the
    // schema does not offer), and inside the sandbox marker family so the
    // exit-code marker stays the last line.
    if (escalationModes.length > 0) {
      markers.push('[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
    }
  }
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

// UI presentation (tool-owned).

/**
 * Present foreground calls as terminals and background starts as generic cards.
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
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
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
 * Recover exit status from the final marked line emitted by {@link renderResult}.
 * A program whose own final line exactly mimics a marker remains ambiguous for UI display.
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
 * Resolve an explicit workdir first, making a relative one session-cwd-relative;
 * otherwise use the session cwd and leave executor defaulting as the fallback.
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
  // The bash tools' cross-call HABIT, which the per-tool descriptions cannot
  // carry (they describe one call each): the exit-code marker is only useful
  // if the model actually checks it every time.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

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

  // Completion runs on the bash fiber, so use topology-independent lookup and
  // match the executor's stored session-owner token to a live agent.
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
      // The one expected failure: the agent was disposed between task completion and this
      // injection (ReactLoopAgent.inject throws `agent "<id>" is disposed`).
      if (error instanceof Error && error.message.includes('is disposed')) return
      throw error
    }
  })

  // The escalation surface exists whenever the mounted executor confines.
  const defaultMode = ctx.bash.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS

  /**
   * The session's standing mode override for an ordinary (non-escalating)
   * call: the `bash/sandbox-mode` fold of the calling agent's log, stamped
   * onto the request so EXECUTION follows the same effective mode the prompt
   * section states. Weakest precedence — an escalation grant (freshly
   * approved for exactly this call) outranks it, and without either the
   * executor's `resolve()` applies its configured default. Undefined for a
   * non-sandboxing executor (nothing honors it) and for agent-less callers
   * (no session to fold).
   */
  const sessionOverride = (exec: ToolExecution): SandboxMode | undefined =>
    defaultMode === undefined || exec.agent === undefined ? undefined : effectiveSandboxMode(exec.agent.session.events)

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes. Returns the granted mode to stamp onto the bash
   * request; throws the distinct fail-closed text for every other path (no
   * service composed, an agent-less execution, a rejection, a cancellation,
   * an unanswerable ask) — the registry turns the throw into this call's
   * isError result, and nothing has run. The seam is consumed
   * opportunistically (`ctx.get`, the dsh-tools ask-routing pattern), so a
   * deployment without it degrades per call, never at registration.
   */
  const approveEscalation = async (mode: string, justification: string, exec: ToolExecution): Promise<SandboxMode> => {
    // Schema validation only checks ADVERTISED keys, so an unadvertised `sandbox_permissions`
    // (no sandboxing executor) still reaches execute — reject it here so a human is never
    // prompted to "escalate" a sandbox that is not there.
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    // Reject sandbox widening against the call's effective mode before requesting approval.
    const effectiveMode = (sessionOverride(exec) ?? defaultMode) as SandboxMode
    if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
      throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
    }
    const approval = ctx.get('approval')
    if (approval === undefined) {
      throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
    }
    if (exec.agent === undefined) {
      throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'bash',
      callId: exec.callId,
      // Self-contained for the audit trail: approval/asked stores this
      // reason, and the target mode is part of the grant's identity.
      reason: `escalate sandbox to ${mode}: ${justification}`,
      ...exec.signal ? { signal: exec.signal } : {},
    })
    switch (outcome) {
      // The SchemaSpec enum already pinned `mode` to the closed target
      // vocabulary; the per-call check above proved it is strictly wider.
      case 'allowed-once': return mode as SandboxMode
      case 'rejected': throw new Error(`the user rejected escalating this command to "${mode}"`)
      case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
      case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  ctx.tools.register(defineTool({
    name: 'bash',
    description: bashDescription(escalationModes),
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
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry '
            + 'of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string' as const,
          description: 'Required with sandbox_permissions: one sentence for the user explaining '
            + 'why this exact command needs the wider access.',
        },
      } : {},
    },
    async execute(args: BashToolArgs, exec) {
      validateBashArgs(args)
      // `description` is display/logging metadata only (surfaced to UIs via the tool/call
      // session event); it is intentionally not forwarded to ctx.bash and has no effect on
      // execution.
      const sandboxMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveEscalation(args.sandbox_permissions, args.justification, exec)
        : sessionOverride(exec)
      // Default the workdir to the calling agent's session cwd so each ACP
      // session runs in its own workspace (see resolveWorkdir); an explicit
      // model workdir still wins.
      const workdir = resolveWorkdir(args.workdir, exec)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...exec.signal ? { signal: exec.signal } : {},
        ...sandboxMode !== undefined ? { sandboxMode } : {},
      }
      if (args.run_in_background === true) {
        // Stamp the owner token (the agent's session id) onto the spec so the executor stores
        // it on the task — the isolation fence for bash_output/ bash_kill.
        const task = ctx.bash.start(ctx.bash.resolve({ ...request, owner: callerToken(exec) }))
        return [{ type: 'text', text: `started background task ${task.id}` }]
      }
      const result = await ctx.bash.run(ctx.bash.resolve(request))
      if (result.aborted) throw new Error('command aborted')
      return [{ type: 'text', text: renderResult(result, escalationModes) }]
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
      if (read.task.sandbox?.runnerFailed) {
        // The sandbox RUNNER itself failed — the command never ran. The
        // foreground path surfaces this as the structured SANDBOX_UNAVAILABLE
        // error; a settled task's read carries the marker instead.
        text += `\n[sandbox: the sandbox runner itself failed under ${read.task.sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`
      } else if (read.task.sandbox?.denied) {
        // Mirrors the foreground result marker (and its same-turn escalation hint).
        text += `\n[sandbox: file access denied under ${read.task.sandbox.mode} mode]`
        if (escalationModes.length > 0) {
          text += '\n[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
        }
      }
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
