/**
 * Model-facing `bash` tool over the `ctx.bash` executor seam. Background calls
 * register process handles with `ctx.tasks`; their work uses task cancellation
 * rather than the tool-call signal after an id is returned.
 *
 * TODO(permissions): deployment policy belongs in `tools/pre-execute` and
 * sandboxing executors; see docs/architecture.md § Extending The Harness.
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

/** Configures whether the model may background commands. */
export interface Config {
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
}

export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
})

/** Parsed tool args; execute validates value constraints absent from SchemaSpec. */
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

/**
 * Present foreground calls as terminals and background starts as generic cards.
 * The command remains the title on both paths; foreground cwd is passed through
 * for the bridge to resolve, while background descriptions remain card content.
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
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
  // Background acknowledgements and errors have no terminal exit status.
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
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

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
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
      // Description is display metadata; workdir defaults to the caller's session.
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
        // Undeclared keys are allowed, so schema omission also needs enforcement.
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const tasks = ctx.get('tasks')
        if (tasks === undefined) {
          throw new Error('background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks')
        }
        // Reject pre-start cancellation; returned tasks use their own lifecycle.
        if (exec.signal?.aborted) throw new Error('command aborted')
        // Task preflight finishes before the starter can spawn a process.
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
