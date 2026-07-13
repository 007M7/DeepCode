/**
 * The stdio app's readline UI: reads lines from stdin into `agent.send()` or
 * `steer()`, renders the durable event stream to stdout, and exits piped input
 * only after submitted work reaches idle.
 * @module @deepseek-ai/dsh-stdio-agent/stdio-chat
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Context } from 'cordis'
import z from 'schemastery'
import { AgentId } from '@deepseek-ai/dsh-agent'
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
  // TODO(fixed-stdio-agent): this app-internal plugin is mounted only for the
  // precreated `main` agent; remove configurability and its config-only test.
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
 * Register stdio chat against an injectable I/O runtime.
 * @param ctx - agent and event context.
 * @param config - plugin config, defaulted for direct callers.
 * @param runtime - line source, render sink, and exit hook.
 */
export function createStdioChat(ctx: Context, config: Config, runtime: StdioRuntime): void {
  // Default here too (not just via schemastery's `.default()`): this helper is
  // exported and called directly by tests / programmatic consumers that bypass
  // Loader validation, so it must be self-contained rather than trusting the
  // cast — `config.welcome as string` would otherwise be `undefined` on `{}`.
  const welcome = config.welcome ?? 'ready.'
  const agentId = AgentId(config.agent ?? 'main')
  const { input, output, exit } = runtime

  // Session ids need not equal agent ids. Seed existing agents before listening
  // so a pre-created or HMR-surviving agent still gets its short render label.
  const labelBySession = new Map<string, string>()
  for (const agent of ctx.agents.list()) labelBySession.set(agent.session.header.id, agent.id)
  ctx.on('agent/created', (agent) => { labelBySession.set(agent.session.header.id, agent.id) })
  ctx.on('agent/disposed', (agent) => { labelBySession.delete(agent.session.header.id) })

  // Render the canonical append order from session/event so reasoning state is
  // deterministic across chunks and boundaries; there are no agent/* mirrors.
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
      const label = labelBySession.get(session.header.id) ?? session.header.id
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
    const reader = createInterface({ input, output, terminal: isTTYPair(input, output) })
    // On piped EOF, exit immediately if no work was submitted. Otherwise wait
    // for a real running state followed by idle: sends do not synchronously mark
    // running, and several queued lines may share one turn.
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
      // Let final output flush; track the timer so re-entry coalesces and HMR
      // disposal can cancel it before it exits the replacement process.
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
