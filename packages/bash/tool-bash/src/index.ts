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
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tasks'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-bash'
import { processOutcome } from './background.ts'
import { parseExitStatus, renderProcessRead, renderResult } from './render.ts'

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
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

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

const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

function bashDescription(backgroundEnabled: boolean, escalationModes: readonly SandboxMode[]): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a task id immediately; read its output with `task_output` and stop it with `task_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const base = 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
    + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
    + 'just hit; escalating up front is fine only when this session already denied the same access. '
    + 'A rejected escalation is final for that command — stop and explain, never work around '
    + 'it — but it does not forbid attempting or escalating other commands later.'
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
  // A foreground run is a terminal; an explicit workdir supplies its cwd.
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
  // A finished foreground run supplies raw output and parsed exit status.
  // The bridge derives the no-capability fenced fallback from `output`.
  return { card: 'terminal', output: raw, ...parseExitStatus(raw) }
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

export function apply(ctx: Context, config: Config): void {
  const backgroundEnabled = config.enableRunInBackground ?? true
  const defaultMode = ctx.bash.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS

  const sessionOverride = (exec: ToolExecution): SandboxMode | undefined =>
    defaultMode === undefined || exec.agent === undefined ? undefined : effectiveSandboxMode(exec.agent.session.events)

  const approveEscalation = async (mode: string, justification: string, exec: ToolExecution): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
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
      reason: `escalate sandbox to ${mode}: ${justification}`,
      ...exec.signal ? { signal: exec.signal } : {},
    })
    switch (outcome) {
      case 'allowed-once': return mode as SandboxMode
      case 'rejected': throw new Error(`the user rejected escalating this command to "${mode}"`)
      case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
      case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

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
    description: bashDescription(backgroundEnabled, escalationModes),
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
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string' as const,
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      } : {},
    },
    async execute(args: BashToolArgs, exec) {
      validateBashArgs(args)
      // `description` is display/logging metadata only (surfaced to UIs via
      // the tool/call session event); it is intentionally NOT forwarded to
      // ctx.bash and has no effect on execution.
      // Default the workdir to the calling agent's session cwd so each ACP
      // session runs in its own workspace (see resolveWorkdir); an explicit
      // model workdir still wins.
      const sandboxMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveEscalation(args.sandbox_permissions, args.justification, exec)
        : sessionOverride(exec)
      const workdir = resolveWorkdir(args.workdir, exec)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...sandboxMode !== undefined ? { sandboxMode } : {},
      }
      if (args.run_in_background === true) {
        // The schema omission is advertising, not enforcement — the arg
        // validator deliberately allows undeclared keys, so a caller (or a
        // model that has seen the parameter elsewhere) can still send it.
        // A disabled deployment must refuse at execution time, loud.
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
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
        // tasks.start preflights (surface fence, owner cleanup) BEFORE run()
        // spawns anything, and cannot fail after — the process can never
        // start without a collectable id.
        const id = tasks.start({
          kind: 'bash',
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => {
            const proc = ctx.bash.start(ctx.bash.resolve(request))
            return {
              cancel: () => void proc.kill(),
              done: proc.done.then(() => processOutcome(proc)),
              readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            }
          },
        })
        return [{ type: 'text', text: `started background task ${id}` }]
      }
      const result = await ctx.bash.run(ctx.bash.resolve({
        ...request,
        ...exec.signal ? { signal: exec.signal } : {},
      }))
      if (result.aborted) throw new Error('command aborted')
      return [{ type: 'text', text: renderResult(result, escalationModes) }]
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }))
}
