/**
 * Command parser and one-turn driver for `dsh-cli-demo`. The executable wrapper
 * owns process signals; this module owns output, durability, and cleanup.
 * @module @deepseek-ai/dsh-cli-demo/cli
 */

import { parseArgs } from 'node:util'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
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
  readonly success: boolean
  readonly sessionId: string
  readonly turn: number
  readonly result: string
  readonly reason: TurnEndReason
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
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
  const blocks = event.data.content.filter(block => block.type === 'text')
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
 * Run one message-triggered turn on the configured top-level agent, aggregate its
 * final text and model usage, wait for idle plus an explicit persistence flush,
 * and return its durable ending. Only the selected agent's task turn reaches
 * `onEvent`; startup injections and unrelated sessions are ignored. The context
 * must contain exactly one top-level agent. Signal abort cancels that agent; an
 * abort before the correlated task turn rejects. An observer throw cancels the
 * turn and is rethrown after the agent reaches idle and the session flushes.
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

  let targetTurn: number | undefined
  let reason: TurnEndReason | undefined
  let result = ''
  const usageByStep = new Map<string, TokenUsage>()
  let outputError: Error | undefined
  let resolveTurn!: () => void
  let rejectTurn!: (error: Error) => void
  let firstTurnEnded = false
  const turnEnded = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })

  const settleResolved = (): void => {
    if (firstTurnEnded) return
    firstTurnEnded = true
    resolveTurn()
  }
  const settleRejected = (error: Error): void => {
    // The once-registered abort listener is the only rejecter, and a settled
    // prompt makes targetTurn defined so onAbort skips rejection entirely;
    // kept for symmetry with settleResolved.
    /* v8 ignore next -- unreachable second settlement, see above */
    if (firstTurnEnded) return
    firstTurnEnded = true
    rejectTurn(error)
  }
  const observe = (sessionId: string, event: SessionEvent): void => {
    if (outputError !== undefined || options.onEvent === undefined) return
    try {
      options.onEvent(sessionId, event)
    } catch (error: unknown) {
      outputError = toError(error)
      agent.cancel({ kind: 'user' })
    }
  }

  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (targetTurn === undefined) {
      if (event.type !== 'turn/start' || event.data.trigger.kind !== 'message') return
      targetTurn = event.data.turn
    } else if (event.type === 'turn/start' && event.data.trigger.kind === 'retry'
      && reason?.kind === 'error') {
      targetTurn = event.data.turn
      reason = undefined
    }
    observe(session.id, event)
    if (event.type === 'assistant/chunk'
      && event.data.turn === targetTurn
      && event.data.chunk.type === 'usage') {
      usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.chunk.usage)
    }
    if (event.type === 'assistant/message' && event.data.turn === targetTurn) {
      result = assistantText(event) ?? result
      if (event.data.usage !== undefined) {
        usageByStep.set(`${event.data.turn}/${event.data.step}`, event.data.usage)
      }
    }
    if (event.type === 'turn/end' && event.data.turn === targetTurn) {
      reason = event.data.reason
      settleResolved()
    }
  })

  const signal = options.signal
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    onAbort = (): void => {
      agent.cancel({ kind: 'user' })
      if (targetTurn === undefined) settleRejected(new CliInterruptedError(interruptionReason(signal)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the race between startup-idle completion and listener registration */
    if (signal.aborted) onAbort()
  }

  try {
    /* v8 ignore next -- skips send only when cancellation wins the listener-registration race above */
    if (!firstTurnEnded) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      agent.followup({ content: [{ type: 'text', text: options.task }], source: { kind: 'user' } })
    }
    await turnEnded
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    await agent.whenIdle()
    disposeListener()
  }

  /* v8 ignore next 3 -- turnEnded resolves only from the matching branch that assigns both values */
  if (targetTurn === undefined || reason === undefined) {
    throw new Error('task ended without a correlated turn/end event')
  }
  await ctx.sessions.flush(agent.session)
  if (outputError !== undefined) throw outputError
  const usage = [...usageByStep.values()].reduce<TokenUsage | undefined>(addUsage, undefined)
  return {
    type: 'result',
    success: reason.kind === 'completed',
    sessionId: agent.session.id,
    turn: targetTurn,
    result,
    reason,
    ...usage === undefined ? {} : { usage },
  }
}

function renderResult(outputFormat: OutputFormat, result: CliResult): string {
  return outputFormat === 'text' ? `${result.result}\n` : `${JSON.stringify(result)}\n`
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
 * Render a non-completed turn reason for stderr.
 * @param reason - durable turn ending to describe.
 * @returns a concise diagnostic fragment.
 */
export function formatTurnFailure(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed': return 'completed'
    case 'aborted': return 'was aborted'
    case 'error': return `failed at step ${reason.step}: ${'failure' in reason ? reason.failure.message : reason.message}`
    case 'disposed': return 'was disposed'
    case 'max-tokens': return 'reached the model output-token limit'
    case 'interrupted': return 'was interrupted during persistence recovery'
    default: return `ended with ${JSON.stringify(reason)}`
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
    exitCode = result.success ? 0 : 1
    if (!result.success) diagnostic = `${CLI_NAME}: turn ${result.turn} ${formatTurnFailure(result.reason)}\n`
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
