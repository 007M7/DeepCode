/**
 * Model-facing `pwsh` tool over the `ctx.bash` executor seam. Intended for
 * Windows compositions where a PowerShell executor (e.g.
 * `@deepseek-ai/dsh-pwsh-local`) backs `ctx.bash`; the tool contract is
 * PowerShell-dialect: native `C:\...` paths and `$env:NAME` variables.
 *
 * Minimal by design: no background tasks, no sandbox escalation — this is the
 * "works on my Windows machine" profile until the full bash-tool feature set
 * gets a PowerShell twin.
 *
 * @module @deepseek-ai/dsh-tool-pwsh
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { Context } from 'cordis'
import z from 'schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { TerminalCallView, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-bash'
import type { BashRunResult, DshEnvironment } from '@deepseek-ai/dsh-bash'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-paths'

export const name = 'tool-pwsh'
export const inject = ['tools', 'bash', 'systemPrompt']

/** Plugin config (currently empty; kept as a schema so deployments can grow it). */
export interface Config {
  /** DeepSeek Harness home directory exposed as `DSH_HOME`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Runtime configuration schema for the pwsh tool plugin. */
export const Config: z<Config> = z.object({
  dshHome: z.string(),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface PwshToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
}

/** The canonical foreground result of one pwsh call (the `output.schema` value shape). */
interface PwshForegroundResult {
  kind: 'foreground'
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
}

/* jscpd:ignore-start -- minimal mirror of dsh-tool-bash's validation and execute plumbing (Agent Note). */
function validatePwshArgs(args: PwshToolArgs): void {
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
/* jscpd:ignore-end */

function pwshDescription(): string {
  return 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. '
    + 'Each call runs in a fresh pwsh process: no state (cwd, variables, functions) persists between calls — '
    + 'pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment '
    + 'variables with `$env:NAME`. Non-zero exits are reported as `[exit code: N]`. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.'
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the session header cwd and leave executor defaulting as the fallback.
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: Agent }): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(headerCwd, modelWorkdir)
  }
  return modelWorkdir
}

/**
 * The model-facing text of one foreground pwsh result: stdout, a marked
 * stderr section, then the applicable timeout, signal, and exit markers —
 * each separated by a newline only when the accumulated text lacks one, so a
 * trailing newline in stdout never produces a blank line.
 *
 * @param value - the canonical foreground result (the schema-derived value shape).
 * @returns the model-facing text.
 */
function renderPwshOutput(value: RenderablePwshOutput): string {
  let rendered = value.stdout.text
  const marker = (line: string): void => {
    rendered += rendered.length > 0 && !rendered.endsWith('\n') ? `\n${line}` : line
  }
  if (value.stderr.text.length > 0) marker(`[stderr]\n${value.stderr.text}`)
  if (value.timedOut) marker(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) marker(`[killed by signal: ${value.signal}]`)
  if (value.exitCode !== null) marker(`[exit code: ${value.exitCode}]`)
  return rendered
}

/**
 * Detach the executor DTO from readonly seam interfaces into plain JSON data.
 * @param result - the executor's run outcome.
 * @returns the canonical foreground result the tool returns and renders.
 */
function canonicalPwshResult(result: BashRunResult): PwshForegroundResult {
  const output = (stream: BashRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  }
}

/** The rendered fields of a foreground result — the schema-derived value shape (no `kind`, plain-string signal). */
interface RenderablePwshOutput {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: { text: string }
  stderr: { text: string }
}

/**
 * The managed `DSH_*` snapshot for one pwsh call: the harness home, a shell
 * marker, and the session identity when an agent is present.
 */
function collectDshEnv(exec: ToolExecution, dshHome: string): DshEnvironment {
  const values: Record<string, string> = {
    [DSH_HOME_ENV]: dshHome,
    [`${DSH_ENV_PREFIX}SHELL`]: '1',
  }
  if (exec.agent !== undefined) {
    values[`${DSH_ENV_PREFIX}SESSION_ID`] = exec.agent.session.header.id
  }
  return values
}

export function apply(ctx: Context, config: Config = {}): void {
  const dshHome = resolveDshHome(config.dshHome)

  ctx.systemPrompt.section({
    name: 'tool:pwsh',
    order: 105,
    text: 'Check the [exit code: N] marker on every pwsh result; investigate failures before moving on.',
  })

  ctx.tools.register(defineTool({
    name: 'pwsh',
    description: pwshDescription(),
    parameters: {
      command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "Get-Process" → "List running processes".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
    },
    output: {
      // The foreground result wire shape mirrors dsh-tool-bash's by contract —
      // consumers of one must accept the other (see the pwsh-tool-and-executor
      // Agent Note).
      /* jscpd:ignore-start -- deliberate foreground-result schema symmetry with dsh-tool-bash. */
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
          stderr: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
        },
      },
      /* jscpd:ignore-end */
      render: (_args, value) => [{
        type: 'text',
        text: renderPwshOutput(value),
      }],
    },
    /* jscpd:ignore-start -- the foreground execute path mirrors dsh-tool-bash's by design (see the pwsh-tool-and-executor Agent Note). */
    async execute(args: PwshToolArgs, exec) {
      validatePwshArgs(args)
      const workdir = resolveWorkdir(args.workdir, exec)
      const result = await ctx.bash.run(ctx.bash.resolve({
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        dshEnv: collectDshEnv(exec, dshHome),
        signal: exec.signal,
      }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return canonicalPwshResult(result)
    },
    /* jscpd:ignore-end */
    presentCall: (args: PwshToolArgs): TerminalCallView => ({
      card: 'terminal',
      title: args.command,
      description: args.description,
      ...args.workdir !== undefined ? { cwd: args.workdir } : {},
    }),
    presentResult: (_args: unknown, result: ToolResult): ToolResultView | undefined => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
    },
  }))
}
