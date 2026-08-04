/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Largest delay Node schedules without collapsing it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647n

/**
 * Bound final exit observation at twice a positive finite grace without
 * narrowing the public config to Node's single-timer integer range.
 */
function doubledGraceWindow(graceMs: number): {
  readonly signal: AbortSignal
  readonly cancel: () => void
} {
  const whole = Math.floor(graceMs)
  let remaining = BigInt(whole) * 2n
    + BigInt(Math.ceil((graceMs - whole) * 2))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    const chunk = remaining > MAX_TIMER_DELAY_MS
      ? MAX_TIMER_DELAY_MS
      : remaining
    remaining -= chunk
    timer = setTimeout(() => {
      timer = undefined
      if (remaining === 0n) {
        controller.abort()
      } else {
        arm()
      }
    }, Number(chunk))
  }
  arm()
  return {
    signal: controller.signal,
    cancel: () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}

type QueryFactory = (params: {
  prompt: string
  options: Options
}) => Query

/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace and final tree-exit bound. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Official query entrypoint; replaced only by package-local unit tests. */
  readonly query?: QueryFactory
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (
    message.subtype !== 'success'
    || message.is_error
    || message.result.trim().length === 0
  ) {
    const detail = message.subtype === 'success'
      ? 'success result was marked as an error or contained no answer'
      : message.errors.join('; ') || message.subtype
    throw new Error(`subagent-claude-code: Claude Code failed: ${detail}`)
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @param setOutput - captures the candidate result for error diagnostics.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
  setOutput: (output: ContentBlock[]) => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type !== 'result') continue
    answer = successfulResult(message)
    setOutput([{ type: 'text', text: answer }])
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 * @param graceMs - termination grace used to bound final exit observation.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
  graceMs: number,
): Promise<void> {
  const failures: Error[] = []
  let treeExited = child.pid <= 0
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    const exitWindow = doubledGraceWindow(graceMs)
    try {
      treeExited = await child.waitForExit(exitWindow.signal)
      if (!treeExited) {
        failures.push(new Error(
          'subagent-claude-code: Claude Code process tree did not exit within its dispose window',
        ))
      }
    } catch (error: unknown) {
      failures.push(thrown(error))
    } finally {
      exitWindow.cancel()
    }
  }
  if (treeExited) {
    try {
      await child.done
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  } else {
    // The bounded tree observation owns teardown completion. Keep a later
    // direct-child spawn failure observed without turning that bound into an
    // unbounded wait.
    void child.done.catch(() => {})
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - workspace, environment, process seam, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the real managed child synchronously from the SDK hook.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: ['AskUserQuestion'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - workspace, environment, process seam, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  try {
    query = (spec.query ?? officialQuery)({
      prompt,
      options: claudeQueryOptions(spec, controller, (captured) => {
        child = captured
      }),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child, spec.disposeGraceMs)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  let output: ContentBlock[] = []
  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery, (value) => {
      output = value
    }),
    collectOutput: () => output,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
      spec.disposeGraceMs,
    ),
  })
}
