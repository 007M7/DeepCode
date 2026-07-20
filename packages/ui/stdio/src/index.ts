/**
 * The stdio app's readline UI: reads lines from stdin into `agent.send()` or
 * `steer()`, renders the durable event stream to stdout, buffers startup input
 * for one exact agent/session identity, and exits piped input only after
 * submitted work reaches idle.
 *
 * This package is the independently composable stdio front door. It establishes
 * the terminal channel and drives an agent created or resumed by app or
 * developer code.
 * @module @deepseek-ai/dsh-stdio
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  UserInteractionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionOption,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'

export const name = 'ui-stdio'
export const inject = ['agents', 'userInteraction']

/** Serializable plugin configuration (cordis-native, schemastery). */
export interface Config {
  /** Banner printed once on start, before the first `> ` prompt. */
  welcome?: string
  /** Exact shared agent/session identity stdin drives. Defaults to `'main'`. */
  sessionId?: string
}

export const Config: z<Config> = z.object({
  welcome: z.string().default('ready.'),
  sessionId: z.string().default('main'),
})

/**
 * Process-I/O seam — the side-effecting handles the plugin would otherwise
 * reach for as globals. Defaulted to the real `process` streams in
 * {@link apply}; injected by tests so the EOF, render, and disposal branches
 * are exercised without hijacking globals. Deliberately NOT part of the
 * serializable {@link Config} (streams/functions don't belong in YAML config).
 */
export interface StdioRuntime {
  /** Line source (default `process.stdin`). */
  input: Readable
  /** Render sink (default `process.stdout`). */
  output: Writable
  /** Process-exit hook (default `process.exit`); called once on stdin EOF. */
  exit: (code: number) => void
}

function isTTYPair(input: Readable, output: Writable): boolean {
  return Boolean((input as { isTTY?: boolean }).isTTY && (output as { isTTY?: boolean }).isTTY)
}

/** Render an arbitrary failure without allowing hostile coercion to escape the UI boundary. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

interface PendingQuestion {
  request: AskUserQuestionRequest
  questionIndex: number
  answers: AskUserQuestionAnswerItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
  onAbort: () => void
}

type OptionSelection =
  | { kind: 'selected'; options: AskUserQuestionOption[] }
  | { kind: 'custom' }
  | { kind: 'invalid' }

/**
 * The plugin body, parameterized over its I/O runtime. `apply` is the thin
 * production wrapper that binds the real `process` streams; tests call this
 * directly with fakes. Returns nothing — all registration is via `ctx.on`/
 * `ctx.effect`, so fiber disposal tears every listener and the readline
 * interface down.
 * @param ctx - the context supplying the `agents` service and the event feeds.
 * @param config - the plugin config; defaults are re-applied here for direct
 * callers that bypass Loader validation.
 * @param runtime - the process-I/O seam (line source, render sink, exit hook).
 */
export function createStdioChat(ctx: Context, config: Config, runtime: StdioRuntime): void {
  // Default here too (not just via schemastery's `.default()`): this helper is
  // exported and called directly by tests / programmatic consumers that bypass
  // Loader validation, so it must be self-contained rather than trusting the
  // cast — `config.welcome as string` would otherwise be `undefined` on `{}`.
  const welcome = config.welcome ?? 'ready.'
  const sessionId = SessionId(config.sessionId ?? 'main')
  const { input, output, exit } = runtime

  // Bind only to the exact identity this app passed to its config-created
  // agent. Session ids are opaque: neither a prefix nor registry order can
  // identify ownership. The root check rejects a child that somehow preempts
  // the configured id; later recreation under the same id supports loop HMR.
  const matchesConfiguredIdentity = (agent: Agent): boolean =>
    agent.id === sessionId && ctx.agents.roots().includes(agent)
  let target: Agent | undefined = ctx.agents.roots().find(agent => agent.id === sessionId)

  // Transcript rendering off the durable `session/event` feed — the assistant
  // token stream, turn/step boundaries, tool activity, and todos all come from
  // the one canonical stream (no agent/* mirrors). A single listener over the
  // append order keeps `inReasoning` transitions deterministic across chunk and
  // boundary events.
  let inReasoning = false
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/chunk') {
      const { chunk } = event.data
      if (chunk.type === 'reasoning-delta') {
        // Dim the chain-of-thought so the final answer stands out.
        if (!inReasoning) output.write('\x1B[2m')
        inReasoning = true
        output.write(chunk.text)
      } else if (chunk.type === 'text-delta') {
        if (inReasoning) output.write('\x1B[0m\n')
        inReasoning = false
        output.write(chunk.text)
      }
    } else if (event.type === 'turn/start') {
      const label = target?.session === session ? 'main' : session.id
      output.write(`\n[${label} turn ${event.data.turn}] `)
    } else if (event.type === 'turn/end') {
      if (inReasoning) output.write('\x1B[0m')
      inReasoning = false
      output.write('\n> ')
    } else if (event.type === 'tool/call') {
      const { name: toolName, arguments: args } = event.data
      if (inReasoning) output.write('\x1B[0m')
      inReasoning = false
      output.write(`\n  [tool call] ${toolName}(${args})`)
    } else if (event.type === 'tool/result') {
      // A surface replacement changes future model context; it is not another
      // execution. Keep the original full-fidelity terminal presentation and
      // suppress duplicate output during live delivery or log replay.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
      const { content } = event.data
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
      output.write(`\n  [tool result] ${text}\n  `)
    } else if (event.type === 'todo/write') {
      if (inReasoning) output.write('\x1B[0m')
      inReasoning = false
      const glyph = (status: string): string =>
        status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
      const lines = event.data.todos.map(todo => `    ${glyph(todo.status)} ${todo.content}`).join('\n')
      output.write(`\n  [todos]\n${lines}\n  `)
    }
  })

  ctx.effect(() => {
    // Piped-input exit, once stdin reaches EOF:
    //  - If no line ever submitted work (empty stdin, blank-only lines), exit
    //    immediately — no turn will ever start, so there is nothing to wait
    //    for. (Gating on an observed 'running' here would hang forever.)
    //  - If work WAS submitted, exit the next time the agent settles to idle
    //    AFTER having run. Later lines may steer the active turn, and consecutive
    //    queued turns can share one running interval, so we don't count inputs;
    //    agent.send() also does NOT synchronously flip status to
    //    'running', so requiring an observed 'running' first (`sawRunning`)
    //    avoids exiting in the gap before the turn starts and dropping work.
    let stdinClosed = false
    let disposed = false
    let submittedWork = false
    let sawRunning = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    let activeQuestion: PendingQuestion | undefined
    const questionQueue: PendingQuestion[] = []
    const queuedInput: string[] = []
    let targetReady = target !== undefined
    let hadReadyTarget = targetReady
    let failedStartup: { error: unknown } | undefined

    const submit = (agent: Agent, text: string): void => {
      submittedWork = true
      if (agent.status === 'running') {
        agent.steer([{ type: 'text', text }])
      } else {
        agent.send([{ type: 'text', text }])
      }
    }

    const disposeCreatedListener = ctx.on('agent/created', (agent) => {
      if (!matchesConfiguredIdentity(agent)) return
      target = agent
      targetReady = false
      failedStartup = undefined
    })
    const disposeSessionStartListener = ctx.on('agent/session-start', (agent) => {
      if (agent !== target) return
      targetReady = true
      hadReadyTarget = true
      for (const text of queuedInput.splice(0)) submit(agent, text)
    })
    const disposeDisposedListener = ctx.on('agent/disposed', (agent) => {
      if (target !== agent) return
      target = undefined
      targetReady = false
    })
    const reader = createInterface({ input, output, terminal: isTTYPair(input, output) })

    const maybeExit = (): void => {
      if (disposed || !stdinClosed) return
      // No work submitted: nothing will ever run, exit straight away.
      // Work submitted: wait until a turn has run and the agent is idle.
      if (submittedWork) {
        if (!sawRunning) return
        const agent = target
        if (agent && agent.status !== 'idle') return // a turn is still running
      }
      // Let any final output flush, then exit. The handle is tracked so the
      // disposer can cancel it — a dispose within the flush window must not let
      // the process exit out from under HMR. Re-entrant `maybeExit` calls (e.g.
      // repeated idle signals) coalesce onto the one pending timer.
      if (exitTimer !== undefined) {
        return // exit already scheduled — coalesce re-entrant calls
      }
      exitTimer = setTimeout(() => { exit(0) }, 200)
    }

    const disposeStartupFailedListener = ctx.on('agent-loop/config-start-failed', (failedSessionId, error) => {
      if (failedSessionId !== sessionId || targetReady) return
      failedStartup = { error }
      const dropped = queuedInput.length
      queuedInput.length = 0
      submittedWork = sawRunning
      if (dropped > 0) {
        ctx.logger.error(`ui-stdio: main agent failed to start; dropped queued stdin (${dropped} line(s)): ${renderThrown(error)}`)
      }
      maybeExit()
    })

    const disposeStatusListener = ctx.on('agent/status', (subject, status) => {
      if (subject !== target) return
      if (status === 'running') sawRunning = true
      if (status === 'idle') maybeExit()
    })

    const activeQuestionItem = (pending: PendingQuestion): AskUserQuestionItem =>
      pending.request.questions[pending.questionIndex] as AskUserQuestionItem

    const renderQuestion = (pending: PendingQuestion): void => {
      const question = activeQuestionItem(pending)
      const options = question.options ?? []
      output.write('\n')
      output.write(question.header ? `[${question.header}] ${question.question}\n` : `${question.question}\n`)
      options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${option.label}\n`)
        if (option.description) output.write(`     ${option.description}\n`)
      })
      output.write('> ')
    }

    const removeAbortListener = (pending: PendingQuestion): void => {
      pending.request.signal?.removeEventListener('abort', pending.onAbort)
    }

    const startNextQuestion = (): void => {
      if (activeQuestion !== undefined) return
      const pending = questionQueue.shift()
      if (pending === undefined) return
      // The queue never contains an aborted pending ask: the seam rejects an
      // already-aborted request synchronously, and queued asks attach their
      // abort listener before enqueueing.
      activeQuestion = pending
      renderQuestion(pending)
    }

    const disposeQuestion = (pending: PendingQuestion): void => {
      removeAbortListener(pending)
      pending.reject(new UserInteractionError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
    }

    const disposePendingQuestions = (): void => {
      if (activeQuestion !== undefined) {
        disposeQuestion(activeQuestion)
        activeQuestion = undefined
      }
      for (const pending of questionQueue.splice(0)) {
        disposeQuestion(pending)
      }
    }

    const finishQuestion = (pending: PendingQuestion): void => {
      activeQuestion = undefined
      removeAbortListener(pending)
      pending.resolve({ answers: pending.answers })
      output.write('\n')
      startNextQuestion()
    }

    const answerCurrentQuestion = (pending: PendingQuestion, answer: AskUserQuestionAnswerItem): void => {
      pending.answers.push(answer)
      pending.questionIndex += 1
      if (pending.questionIndex >= pending.request.questions.length) {
        finishQuestion(pending)
        return
      }
      renderQuestion(pending)
    }

    const selectedOptions = (text: string, options: AskUserQuestionOption[], multiSelect: boolean): OptionSelection => {
      if (text === '') return { kind: 'invalid' }
      if (!multiSelect) {
        if (!/^\d+$/.test(text)) return { kind: 'custom' }
        const selected = options[Number(text) - 1]
        return selected === undefined ? { kind: 'invalid' } : { kind: 'selected', options: [selected] }
      }
      const indices = text.split(/[,\s]+/).filter(Boolean)
      if (indices.length === 0) return { kind: 'invalid' }
      if (indices.some(part => !/^\d+$/.test(part))) return { kind: 'custom' }
      const uniqueIndices = [...new Set(indices)]
      const selected = uniqueIndices.map(part => options[Number(part) - 1])
      return selected.some(option => option === undefined)
        ? { kind: 'invalid' }
        : { kind: 'selected', options: selected as AskUserQuestionOption[] }
    }

    const answerQuestion = (line: string): void => {
      const pending = activeQuestion as PendingQuestion
      const question = activeQuestionItem(pending)

      const text = line.trim()
      const options = question.options ?? []
      const selection = options.length > 0
        ? selectedOptions(text, options, question.multiSelect ?? false)
        : { kind: text === '' ? 'invalid' : 'custom' } as OptionSelection
      if (selection.kind === 'selected') {
        answerCurrentQuestion(pending, { id: question.id, selected: selection.options.map(option => option.label) })
        return
      }

      if (selection.kind === 'custom' && text !== '') {
        answerCurrentQuestion(pending, { id: question.id, selected: [], custom: text })
        return
      }

      output.write(options.length > 0
        ? 'Please enter one of the option numbers'
          + (question.multiSelect ? ' (comma or space separated)' : '')
          + ' or a custom answer'
          + '.\n> '
        : 'Please enter an answer.\n> ')
    }

    const disposeUserInteractionProvider = ctx.userInteraction.registerProvider({
      ask(request) {
        if (disposed || stdinClosed) {
          return Promise.reject(
            new UserInteractionError('ask_user_question cannot be answered because stdin is closed', 'ASK_ABORTED'),
          )
        }
        return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
          const pending: PendingQuestion = {
            request,
            questionIndex: 0,
            answers: [],
            resolve,
            reject,
            onAbort: () => {
              if (activeQuestion === pending) {
                activeQuestion = undefined
                disposeQuestion(pending)
                startNextQuestion()
                return
              }
              // If it is not active, this listener can only fire while the ask
              // remains queued; settled asks remove the listener first.
              questionQueue.splice(questionQueue.indexOf(pending), 1)
              disposeQuestion(pending)
            },
          }
          request.signal?.addEventListener('abort', pending.onAbort, { once: true })
          questionQueue.push(pending)
          startNextQuestion()
        })
      },
    })

    reader.on('line', (line) => {
      if (activeQuestion !== undefined) {
        answerQuestion(line)
        return
      }
      const text = line.trim()
      if (!text) return
      if (failedStartup !== undefined) {
        ctx.logger.error(`ui-stdio: main agent failed to start; dropped queued stdin (1 line(s)): ${renderThrown(failedStartup.error)}`)
        return
      }
      const agent = target
      if (agent === undefined || !targetReady) {
        // Initial exact-id restoration is asynchronous. Preserve input until
        // session-start, the first supported point for queueing agent work.
        // After a previously ready target disappears, a line in the HMR gap
        // still fails loud unless its exact replacement is already publishing.
        if (!hadReadyTarget || agent !== undefined) {
          submittedWork = true
          queuedInput.push(text)
          return
        }
        ctx.logger.error('ui-stdio: main agent is not running')
        return
      }
      submit(agent, text)
    })
    reader.on('close', () => {
      // Fires for BOTH stdin EOF and plugin disposal (reader.close() below);
      // `disposed` guards teardown so HMR/dispose never exits the process.
      stdinClosed = true
      if (!disposed) disposePendingQuestions()
      maybeExit()
    })
    output.write(`${welcome}\n> `)
    return () => {
      disposed = true
      if (exitTimer !== undefined) clearTimeout(exitTimer)
      disposePendingQuestions()
      disposeUserInteractionProvider()
      disposeStatusListener()
      disposeCreatedListener()
      disposeSessionStartListener()
      disposeDisposedListener()
      disposeStartupFailedListener()
      reader.close()
    }
  }, 'ui-stdio')
}

/**
 * Open the terminal channel for one exact identity. The chat registers before
 * that agent necessarily exists so it can buffer startup input and observe a
 * config-start failure instead of leaving piped stdin hanging.
 * @param ctx - the context supplying the agent registry and event stream.
 * @param config - presentation and target-agent configuration.
 * @param runtime - process-I/O seam.
 */
export function mountStdio(ctx: Context, config: Config, runtime: StdioRuntime): void {
  createStdioChat(ctx, config, runtime)
}

/**
 * Cordis entry point. Binds the real `process` streams and delegates to
 * {@link mountStdio}; the indirection keeps the side-effecting handles out
 * of the testable core, which is why the unit suite drives `createStdioChat`
 * directly. This thin wrapper is exercised end-to-end by the keyless
 * Loader-path e2e smoke in `examples/echo-agent` (the real product entry).
 */
/* v8 ignore start -- production stdio wiring; testable core is createStdioChat() (covered), exercised e2e by echo-agent keyless smoke */
export function apply(ctx: Context, config: Config): void {
  mountStdio(ctx, config, {
    input: process.stdin,
    output: process.stdout,
    exit: code => process.exit(code),
  })
}
/* v8 ignore stop */
