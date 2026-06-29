/**
 * Minimal stdio UI plugin: reads lines from stdin → `agent.send()`/`steer()`,
 * and renders the agent's stream chunks and tool activity to stdout. A UI is
 * "just a plugin" — it only consumes the `agent/*` event taxonomy and the
 * `agents` service, so the same plugin drives any example or product surface.
 *
 * Consolidates what were two near-identical copies under `examples/echo-agent`
 * and `examples/coding-agent` (the latter a superset). This package IS that
 * superset: dimmed chain-of-thought rendering plus the robust piped-stdin
 * EOF→idle exit handling, configured per consumer via {@link Config}.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default
 * export — the cordis Loader's `unwrapExports` does `exports.default ?? exports`,
 * so a stray default would collapse the module to the bare function and drop
 * the `inject` namespace (see docs/postmortem/0001). The keyless Loader-path
 * e2e smokes in `examples/{echo,coding}-agent` guard this end-to-end.
 *
 * @module @deepseek-ai/dsh-ui-stdio
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Context } from 'cordis'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
import {
  UserInteractionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionOption,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'

export const name = 'ui-stdio'
export const inject = ['agents', 'userInteraction']

/** Serializable plugin configuration (cordis-native, schemastery). */
export interface Config {
  /** Banner printed once on start, before the first `> ` prompt. */
  welcome?: string
  /** Id of the agent stdin drives (`send`/`steer`) and whose status gates the EOF exit; rendering is global. Defaults to `'main'`. */
  agent?: string
}

export const Config: z<Config> = z.object({
  welcome: z.string().default('ready.'),
  agent: z.string().default('main'),
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

function optionAnswer(option: AskUserQuestionOption): string {
  return option.value ?? option.label
}

function displayOptions(options: AskUserQuestionOption[] = []): AskUserQuestionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      if (left.option.recommended === right.option.recommended) return left.index - right.index
      return left.option.recommended ? -1 : 1
    })
    .map(({ option }) => option)
}

interface PendingQuestion {
  request: AskUserQuestionRequest
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
  onAbort: () => void
}

/**
 * The plugin body, parameterized over its I/O runtime. `apply` is the thin
 * production wrapper that binds the real `process` streams; tests call this
 * directly with fakes. Returns nothing — all registration is via `ctx.on`/
 * `ctx.effect`, so fiber disposal tears every listener and the readline
 * interface down.
 */
export function createStdioChat(ctx: Context, config: Config, runtime: StdioRuntime): void {
  // Default here too (not just via schemastery's `.default()`): this helper is
  // exported and called directly by tests / programmatic consumers that bypass
  // Loader validation, so it must be self-contained rather than trusting the
  // cast — `config.welcome as string` would otherwise be `undefined` on `{}`.
  const welcome = config.welcome ?? 'ready.'
  const agentId = AgentId(config.agent ?? 'main')
  const { input, output, exit } = runtime

  let inReasoning = false
  ctx.on('agent/stream-chunk', (_agent, _turn, _step, chunk) => {
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
  })

  ctx.on('agent/turn-start', (agent, turn) => {
    output.write(`\n[${agent.id} turn ${turn}] `)
  })

  ctx.on('agent/turn-end', () => {
    if (inReasoning) output.write('\x1B[0m')
    inReasoning = false
    output.write('\n> ')
  })

  ctx.on('agent/error', (agent, turn, step, error) => {
    if (inReasoning) output.write('\x1B[0m')
    inReasoning = false
    output.write(`\n[${agent.id} turn ${turn} step ${step} error] ${error.message}\n> `)
  })

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') {
      const { name: toolName, arguments: args } = event.data
      if (inReasoning) output.write('\x1B[0m')
      inReasoning = false
      output.write(`\n  [tool call] ${toolName}(${args})`)
    } else if (event.type === 'tool/result') {
      const { content } = event.data
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
      output.write(`\n  [tool result] ${text}\n  `)
    }
  })

  ctx.effect(() => {
    const reader = createInterface({ input, output, terminal: isTTYPair(input, output) })
    // Piped-input exit, once stdin reaches EOF:
    //  - If no line ever submitted work (empty stdin, blank-only lines), exit
    //    immediately — no turn will ever start, so there is nothing to wait
    //    for. (Gating on an observed 'running' here would hang forever.)
    //  - If work WAS submitted, exit the next time the agent settles to idle
    //    AFTER having run. Two subtleties this handles: the loop batches
    //    several queued messages into ONE turn (one idle), so we don't count
    //    sends; and agent.send() does NOT synchronously flip status to
    //    'running', so requiring an observed 'running' first (`sawRunning`)
    //    avoids exiting in the gap before the turn starts and dropping work.
    let stdinClosed = false
    let disposed = false
    let submittedWork = false
    let sawRunning = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    let activeQuestion: PendingQuestion | undefined
    const questionQueue: PendingQuestion[] = []

    const maybeExit = (): void => {
      if (disposed || !stdinClosed) return
      // No work submitted: nothing will ever run, exit straight away.
      // Work submitted: wait until a turn has run and the agent is idle.
      if (submittedWork) {
        if (!sawRunning) return
        const agent = ctx.agents.get(agentId)
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

    const disposeStatusListener = ctx.on('agent/status', (subject, status) => {
      if (subject.id !== agentId) return
      if (status === 'running') sawRunning = true
      if (status === 'idle') maybeExit()
    })

    const renderQuestion = (pending: PendingQuestion): void => {
      const { request } = pending
      output.write('\n')
      output.write(request.header ? `[${request.header}] ${request.question}\n` : `[question] ${request.question}\n`)
      displayOptions(request.options).forEach((option, index) => {
        output.write(`  ${index + 1}. ${option.label}${option.recommended ? ' (recommended)' : ''}\n`)
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
      if (pending.request.signal?.aborted) {
        pending.reject(new UserInteractionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
        startNextQuestion()
        return
      }
      activeQuestion = pending
      pending.request.signal?.addEventListener('abort', pending.onAbort, { once: true })
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

    const finishQuestion = (pending: PendingQuestion, answer: AskUserQuestionAnswer): void => {
      removeAbortListener(pending)
      activeQuestion = undefined
      pending.resolve(answer)
      output.write('\n')
      startNextQuestion()
    }

    const answerQuestion = (line: string): void => {
      const pending = activeQuestion as PendingQuestion

      const text = line.trim()
      const options = displayOptions(pending.request.options)
      const selectedIndex = /^\d+$/.test(text) ? Number(text) - 1 : -1
      const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
      if (selected !== undefined) {
        finishQuestion(pending, { answer: optionAnswer(selected), option: selected })
        return
      }

      const recommended = options.find(option => option.recommended)
      if (text === '' && recommended !== undefined) {
        finishQuestion(pending, { answer: optionAnswer(recommended), option: recommended })
        return
      }

      const allowCustom = options.length === 0 || (pending.request.allowCustom ?? true)
      if (allowCustom && text !== '') {
        finishQuestion(pending, { answer: text })
        return
      }

      output.write(options.length > 0
        ? 'Please enter one of the option numbers'
          + (allowCustom ? ' or a custom answer' : '')
          + '.\n> '
        : 'Please enter an answer.\n> ')
    }

    const disposeUserInteractionProvider = ctx.userInteraction.registerProvider({
      ask(request) {
        return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
          const pending: PendingQuestion = {
            request,
            resolve,
            reject,
            onAbort: () => {
              activeQuestion = undefined
              disposeQuestion(pending)
              startNextQuestion()
            },
          }
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
      const agent = ctx.agents.get(agentId)
      if (!agent) {
        ctx.logger.error('ui-stdio: agent "%s" is not running', agentId)
        return
      }
      submittedWork = true
      if (agent.status === 'running') {
        agent.steer([{ type: 'text', text }])
      } else {
        agent.send([{ type: 'text', text }])
      }
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
      reader.close()
    }
  }, 'ui-stdio')
}

/**
 * Cordis entry point. Binds the real `process` streams and delegates to
 * {@link createStdioChat}; the indirection keeps the side-effecting handles out
 * of the testable core, which is why the unit suite drives `createStdioChat`
 * directly. This thin wrapper is exercised end-to-end by the keyless
 * Loader-path e2e smoke in `examples/echo-agent` (the real product entry).
 */
/* v8 ignore start -- production stdio wiring; testable core is createStdioChat() (covered), exercised e2e by echo-agent keyless smoke */
export function apply(ctx: Context, config: Config): void {
  createStdioChat(ctx, config, {
    input: process.stdin,
    output: process.stdout,
    exit: code => process.exit(code),
  })
}
/* v8 ignore stop */
