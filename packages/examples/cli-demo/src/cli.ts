/**
 * Command parser and one-turn driver for `dsh-cli-demo`. The executable wrapper
 * owns process signals; this module owns output, durability, and cleanup.
 * @module @deepseek-ai/dsh-cli-demo/cli
 */

import { parseArgs } from 'node:util'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { boot, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const CLI_NAME = 'dsh-cli-demo'
const DEFAULT_CONFIG_PATH = './cordis.yml'
const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const
const USAGE = `Usage: ${CLI_NAME} [--config path] [--output-format text|json|stream-json] (-p <task> | <task>)\n`

/** Supported CLI output encodings. */
export type OutputFormat = typeof OUTPUT_FORMATS[number]

/** Parsed command: help exits before boot; run carries one validated task. */
export type CliCommand =
  | { readonly kind: 'help' }
  | {
    readonly kind: 'run'
    readonly configPath: string
    readonly outputFormat: OutputFormat
    readonly task: string
  }

/** DSH-native final record emitted by JSON modes. */
export interface CliResult {
  readonly type: 'result'
  readonly sessionId: string
  readonly output: string
  readonly usage?: TokenUsage
}

/** Options for one turn against the configured top-level agent. */
export interface OneShotOptions {
  /** Exactly one nonblank user task. */
  readonly task: string
  /** Optional signal that cancels the selected agent. */
  readonly signal?: AbortSignal
  /** Synchronous task-turn observer; a throw cancels the agent and fails the run after flush. */
  readonly onEvent?: (sessionId: string, event: SessionEvent) => void
}

/** Injectable process boundaries used by {@link executeCli}. */
export interface CliRuntime {
  /** Process cwd for config resolution and `.env` loading. */
  readonly cwd?: string
  /** Cancellation signal, normally aborted by SIGINT or SIGTERM. */
  readonly signal?: AbortSignal
  /** Loader boot boundary. */
  readonly boot?: (name: string, absoluteConfigPath: string) => Promise<Context>
  /** Optional `.env` loader boundary. */
  readonly loadEnv?: (name: string, dir: string, warn: (line: string) => void) => void
  /** Stdout sink; throws are treated as output failures. */
  readonly writeStdout?: (chunk: string) => unknown
  /** Stderr diagnostic sink. */
  readonly writeStderr?: (chunk: string) => unknown
  /** Context disposal boundary. */
  readonly dispose?: (ctx: Context) => Promise<void>
}

interface ParsedArguments {
  readonly values: {
    readonly config?: string
    readonly 'output-format'?: string
    readonly help?: boolean
    readonly prompt?: string
  }
  readonly positionals: string[]
}

class CliArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgumentError'
  }
}

class CliInterruptedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CliInterruptedError'
  }
}

/** Render an arbitrary value without trusting its type traps or string coercion. */
function renderUnknown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Normalize an arbitrary thrown value without letting inspection escape containment. */
function toError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // A hostile proxy may throw during instanceof; use the total renderer below.
  }
  return new Error(renderUnknown(error))
}

function interruptionReason(signal: AbortSignal): string {
  return signal.reason === undefined ? 'interrupted' : renderUnknown(signal.reason)
}

/**
 * Parse the bin arguments and enforce the one-positional-task contract.
 * @param args - arguments after the executable name.
 * @returns a help or run command.
 * @throws {@link CliArgumentError} for unknown flags, invalid formats, or task cardinality.
 */
export function parseCliArgs(args: readonly string[]): CliCommand {
  let parsed: ParsedArguments
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string' },
        'output-format': { type: 'string' },
        help: { type: 'boolean' },
        prompt: { type: 'string', short: 'p' },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (error: unknown) {
    throw new CliArgumentError(toError(error).message)
  }

  if (parsed.values.help === true) return { kind: 'help' }
  const prompt = parsed.values.prompt
  if (prompt !== undefined && parsed.positionals.length > 0) {
    throw new CliArgumentError('-p/--prompt and a positional task are mutually exclusive')
  }
  if (prompt === undefined && parsed.positionals.length !== 1) {
    throw new CliArgumentError(`expected exactly one positional task or -p, received ${parsed.positionals.length} positional(s)`)
  }
  // Cardinality was checked above, so the fallback index zero exists.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const task = prompt ?? parsed.positionals[0]!
  if (task.trim().length === 0) throw new CliArgumentError('task must not be blank')

  const requestedFormat = parsed.values['output-format'] ?? 'text'
  if (!OUTPUT_FORMATS.some(format => format === requestedFormat)) {
    throw new CliArgumentError(`unsupported output format ${JSON.stringify(requestedFormat)}`)
  }
  return {
    kind: 'run',
    configPath: parsed.values.config ?? DEFAULT_CONFIG_PATH,
    outputFormat: requestedFormat as OutputFormat,
    task,
  }
}

function addUsage(total: TokenUsage | undefined, step: TokenUsage): TokenUsage {
  const next: TokenUsage = {
    inputTokens: (total?.inputTokens ?? 0) + step.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + step.outputTokens,
  }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (total?.[key] !== undefined || step[key] !== undefined) next[key] = (total?.[key] ?? 0) + (step[key] ?? 0)
  }
  return next
}

function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter(block => block.type === 'text')
  return blocks.length === 0 ? undefined : blocks.map(block => block.text).join('')
}

/** Wait for startup quiescence while making pre-run cancellation terminal. */
async function waitForStartupIdle(agent: Agent, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await agent.whenIdle()
    return
  }
  if (signal.aborted) {
    agent.cancel({ kind: 'user' })
    throw new CliInterruptedError(interruptionReason(signal))
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      agent.cancel({ kind: 'user' })
      reject(new CliInterruptedError(interruptionReason(signal)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void agent.whenIdle().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * Run one owned activity interval on the configured top-level agent, from the
 * task's durable enqueue receipt through whole-agent idle.
 * @param ctx - settled Loader root containing one agent plus `ctx.sessions`.
 * @param options - task, optional cancellation, and optional stream observer.
 * @returns the DSH-native result envelope after durable quiescence.
 */
export async function runOneShot(ctx: Context, options: OneShotOptions): Promise<CliResult> {
  const agents = ctx.get('agents')?.roots() ?? []
  const [agent] = agents
  if (agent === undefined || agents.length !== 1) {
    throw new Error(`config must create exactly one top-level agent, found ${agents.length}`)
  }
  await waitForStartupIdle(agent, options.signal)

  const message = createUserMessage({ content: [{ type: 'text', text: options.task }], source: { kind: 'user' } })
  let received = false
  let output = ''
  const usageByStep = new Map<string, TokenUsage>()
  let outputError: Error | undefined
  let interrupted: CliInterruptedError | undefined
  const observe = (sessionId: string, event: SessionEvent): void => {
    if (outputError !== undefined || options.onEvent === undefined) return
    try {
      options.onEvent(sessionId, event)
    } catch (error: unknown) {
      outputError = toError(error)
      queueMicrotask(() => {
        agent.cancel({ kind: 'user' })
      })
    }
  }

  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!received) {
      if (event.type !== 'agent/inbox/spliced'
        || !event.data.inserted.some(inserted => inserted.id === message.id)) return
      received = true
    }
    observe(session.id, event)
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.chunk.usage)
    }
    if (event.type === 'assistant/message') {
      output = assistantText(event) ?? output
      if (event.data.usage !== undefined) {
        usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.usage)
      }
    }
  })

  const signal = options.signal
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    onAbort = (): void => {
      interrupted ??= new CliInterruptedError(interruptionReason(signal))
      agent.cancel({ kind: 'user' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the race between startup-idle completion and listener registration */
    if (signal.aborted) onAbort()
  }

  try {
    if (interrupted === undefined) agent.followup(message)
    await agent.whenIdle()
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    disposeListener()
  }

  await ctx.sessions.flush(agent.session)
  if (outputError !== undefined) throw outputError
  if (interrupted !== undefined) throw interrupted
  const usage = [...usageByStep.values()].reduce<TokenUsage | undefined>(addUsage, undefined)
  return {
    type: 'result',
    sessionId: agent.session.id,
    output,
    ...usage === undefined ? {} : { usage },
  }
}

function renderResult(outputFormat: OutputFormat, result: CliResult): string {
  return outputFormat === 'text' ? `${result.output}\n` : `${JSON.stringify(result)}\n`
}

/**
 * Race Loader boot with cancellation without abandoning a context that becomes
 * available after the caller has been released. Waiting for that late context
 * would recreate the signal hang, so its disposal and diagnostics run detached.
 */
async function bootInterruptibly(
  start: () => Promise<Context>,
  signal: AbortSignal | undefined,
  disposeLateContext: (ctx: Context) => Promise<void>,
  reportLateDisposalFailure: (error: unknown) => void,
): Promise<Context> {
  if (signal === undefined) return await start()
  if (signal.aborted) throw new CliInterruptedError(interruptionReason(signal))

  let onAbort!: () => void
  const interruptedBoot = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      reject(new CliInterruptedError(interruptionReason(signal)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes registration against a non-standard synchronously mutating signal */
    if (signal.aborted) onAbort()
  })
  const booting = Promise.resolve().then(start)
  try {
    return await Promise.race([booting, interruptedBoot])
  } catch (error: unknown) {
    // The awaited race permits the signal to change after the preflight check.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (signal.aborted) {
      void booting.then(
        async (lateContext) => {
          try {
            await disposeLateContext(lateContext)
          } catch (error: unknown) {
            reportLateDisposalFailure(error)
          }
        },
        () => {},
      )
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Execute one CLI invocation. Argument and boot failures never write stdout;
 * context disposal is awaited before return, and its failure does not replace
 * an earlier diagnostic.
 * @param args - arguments after the executable name.
 * @param runtime - optional injected process boundaries for tests and embedding.
 * @returns the ordinary process exit code; the thin bin overrides it for Unix signals.
 */
export async function executeCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  /* v8 ignore next -- default process sinks are exercised by the built-bin smoke */
  const writeStdout = runtime.writeStdout ?? (chunk => process.stdout.write(chunk))
  /* v8 ignore next -- default process sinks are exercised by the built-bin smoke */
  const writeStderr = runtime.writeStderr ?? (chunk => process.stderr.write(chunk))
  let command: CliCommand
  try {
    command = parseCliArgs(args)
  } catch (error: unknown) {
    writeStderr(`${CLI_NAME}: ${toError(error).message}\n${USAGE}`)
    return 1
  }
  if (command.kind === 'help') {
    writeStdout(USAGE)
    return 0
  }

  /* v8 ignore next -- default process cwd is exercised by the built-bin smoke */
  const cwd = runtime.cwd ?? process.cwd()
  /* v8 ignore next -- default env/boot boundaries are exercised by the Loader and built-bin smokes */
  const loadEnvironment = runtime.loadEnv ?? loadEnv
  /* v8 ignore next -- default env/boot boundaries are exercised by the Loader and built-bin smokes */
  const bootContext = runtime.boot ?? boot
  /* v8 ignore next -- default disposal is exercised by the built-bin smoke */
  const disposeContext = runtime.dispose ?? (target => target.fiber.dispose())
  let ctx: Context | undefined
  let exitCode = 1
  let diagnostic: string | undefined
  try {
    loadEnvironment(CLI_NAME, cwd, line => writeStderr(line))
    ctx = await bootInterruptibly(
      () => bootContext(CLI_NAME, resolveConfigPath(command.configPath, undefined, cwd)),
      runtime.signal,
      disposeContext,
      error => writeStderr(`${CLI_NAME}: dispose after interrupted boot failed: ${toError(error).message}\n`),
    )
    const result = await runOneShot(ctx, {
      task: command.task,
      ...runtime.signal === undefined ? {} : { signal: runtime.signal },
      ...command.outputFormat === 'stream-json'
        ? { onEvent: (sessionId: string, event: SessionEvent) => {
          writeStdout(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
        } }
        : {},
    })
    writeStdout(renderResult(command.outputFormat, result))
    exitCode = 0
  } catch (error: unknown) {
    diagnostic = `${CLI_NAME}: ${toError(error).message}\n`
  } finally {
    if (ctx !== undefined) {
      try {
        await disposeContext(ctx)
      } catch (error: unknown) {
        diagnostic = `${diagnostic ?? ''}${CLI_NAME}: dispose failed: ${toError(error).message}\n`
        exitCode = 1
      }
    }
  }
  if (diagnostic !== undefined) writeStderr(diagnostic)
  return exitCode
}
