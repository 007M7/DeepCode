/**
 * Code Mode `run_code` transport. Programs call the registry's agent-visible
 * tools through nested, sequential executions; each sub-dispatch is logged for
 * reconstruction, while only the outer curated result enters model history.
 * @module @deepseek-ai/dsh-tools/src/code-mode
 */

import { parse } from 'node:path'
import { inspect } from 'node:util'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CodeBindingFunction, CodeRunResult, CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool } from './schema.ts'
import type { ToolDefinition, ToolRegistry } from './index.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * One bridged sub-dispatch from a `run_code` program: the parent
     * `run_code` call id, the deterministic sub-call id
     * (`<parent>:code:<n>`), the tool `name` with its JSON-normalized
     * `arguments` — the exact value dispatched, normalized BEFORE dispatch,
     * so this append can never fail on payload shape — whether the sub-call
     * errored, and a bounded `resultSummary` of its model-facing text. Before
     * bounding, occurrences of a non-root session workspace path are
     * normalized to `.` so host-specific absolute path lengths cannot change
     * the summary.
     * Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter
     * model context; persistence and UIs get every call. Appended inside the
     * parent `run_code`'s execution (the bridge drains its queue before
     * returning), so the turn-enclosure invariant holds by construction.
     */
    'tool/code-dispatch': { parentCallId: CallId; subCallId: CallId; name: string; arguments: unknown; isError: boolean; resultSummary: string }
  }
}

/** The model-facing name of the Code Mode tool. */
export const RUN_CODE_NAME = 'run_code'

/** The `tools:sdk` section order: inside the 100–199 tool-guidance band, after per-tool guidance sections. */
export const SDK_SECTION_ORDER = 150

/**
 * Thrown by `run_code` when the program run itself failed — a program
 * exception, a budget expiry, an abort, or substrate death. Extends
 * {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
 * pipeline converts it into a structured `isError` result whose text carries
 * the failure kind plus the captured logs, so the model can self-correct.
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}

/**
 * Cap for a `tool/code-dispatch` event's `resultSummary`. A log-ergonomics
 * constant, not config: the full result already flows to the program; the
 * summary exists so log readers see what a sub-call returned at a glance.
 */
const SUMMARY_MAX_CHARS = 200

/** Bounded inspect for rendering a program's completion value into the model-facing text. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/** Join a result's text blocks; a non-text block becomes a placeholder (an MVP limitation, stated in the SDK instructions). */
function textOf(content: ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text': return block.text
        // ContentBlockMap is merge-extensible — future block kinds land here
        // deliberately (no assertNever on merge-extensible unions).
        default: return `[${block.type} content]`
      }
    })
    .join('\n')
}

/** Normalize workspace paths, then bound a sub-call's model-facing text for its durable log summary. */
function summarize(text: string, cwd: string | undefined): string {
  const stableText = cwd === undefined || cwd === parse(cwd).root
    ? text
    : text.replaceAll(cwd, '.')
  return stableText.length > SUMMARY_MAX_CHARS ? `${stableText.slice(0, SUMMARY_MAX_CHARS)}…` : stableText
}

/**
 * JSON-normalize one binding call's argument into TWO independent parses of the same canonical
 * text: `dispatched` goes to the tool, `logged` to the `tool/code-dispatch` event — identical
 * by construction (the runtime's structured-clone boundary is wider than JSON; the session log
 * accepts only JSON), and separate objects, so a tool mutating its args can neither desync the
 * log from what was dispatched nor re-poison the append.
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  if (value === undefined) {
    throw new Error('tool arguments must be JSON-serializable (call the tool with an arguments object, e.g. `{}`)')
  }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error: unknown) {
    throw new Error(`tool arguments must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`)
  }
  // JSON.stringify's lib type claims `string`, but a bare function or symbol
  // root really yields `undefined` at runtime — the guard is live.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (text === undefined) throw new Error('tool arguments must be JSON-serializable (got a value JSON cannot represent)')
  return { dispatched: JSON.parse(text) as unknown, logged: JSON.parse(text) as unknown }
}

/** Render the program's completion value for the model-facing result text (`''` when the program returned nothing). */
function renderValue(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : inspect(value, INSPECT_OPTIONS)
}

/** The run_code result's `meta` payload (JSON-serializable; `presentResult` narrows it back). */
interface RunCodeMeta {
  logs: CodeRunResult['logs']
}

/** Soft-narrow a result `meta` back to {@link RunCodeMeta} (replay may carry older shapes; presentation must not throw). */
function asRunCodeMeta(meta: unknown): RunCodeMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as Record<string, unknown>
  if (!Array.isArray(m.logs) || !m.logs.every(log => typeof log === 'string')) return undefined
  return m as unknown as RunCodeMeta
}

/**
 * Build the `run_code` {@link ToolDefinition}: one required `code` parameter,
 * executed through the dispatch bridge described above. The
 * registry reserves it as presentation infrastructure under non-native modes,
 * outside the filterable global/scoped capability layers.
 * @param registry - the owning registry (sub-calls go through its `execute`,
 *   bindings cover its registered tools).
 * @param requireRuntime - resolves `ctx.codeRuntime` or throws the loud
 *   misconfiguration error (shared with the registry's assembly-time checks).
 * @returns the registry-ready definition.
 */
export function createRunCodeTool(registry: ToolRegistry, requireRuntime: () => CodeRuntime): ToolDefinition {
  return defineTool({
    name: RUN_CODE_NAME,
    description:
      'Execute a TypeScript program against the available tools. Write the BODY of an '
      + 'async function (erasable syntax only; top-level `await` and `return` work) and '
      + 'call tools as `await tools.name(args)` per the declarations in the system prompt. '
      + 'Only what you print or return comes back — curate it.',
    parameters: {
      code: { type: 'string', required: true, description: 'The program: the body of an async TypeScript function.' },
    },
    async execute(args, exec) {
      const runtime = requireRuntime()

      // The run-scoped abort: follows the outer signal in, and fires when the
      // run settles for ANY reason, so an in-flight sub-dispatch is aborted
      // (its executor kills on this signal) instead of orphaned, and
      // queued-unstarted dispatches are abandoned.
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(exec.signal?.reason) }
      if (exec.signal?.aborted) onOuterAbort()
      exec.signal?.addEventListener('abort', onOuterAbort, { once: true })

      let dispatches = 0
      // The per-run serialization queue: every binding call chains onto the tail, so even
      // `Promise.all` executes the underlying tool calls one at a time in submission order (the
      // tool contract carries no concurrency-safety metadata yet).
      let queue: Promise<void> = Promise.resolve()
      const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const turn = queue.then(() => {
          if (runController.signal.aborted) {
            throw new Error(`run_code run is over (${String(runController.signal.reason)}); tool call abandoned`)
          }
          return task()
        })
        queue = turn.then(() => undefined, () => undefined)
        return turn
      }

      // Read through a call, not a bare property: the abort state genuinely
      // changes across awaits, and a direct `.aborted` re-check after one
      // would be narrowed away by control flow analysis.
      const runOver = (): boolean => runController.signal.aborted

      const binding = (name: string): CodeBindingFunction => async (rawArgs: unknown): Promise<unknown> => {
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
        }
        const normalized = jsonNormalizeArgs(rawArgs)
        const outcome = await enqueue(async () => {
          const n = ++dispatches
          const subCallId = CallId(`${String(exec.callId)}:code:${n}`)
          const result = await registry.execute({
            callId: subCallId,
            name,
            arguments: normalized.dispatched,
            ...exec.agent ? { agent: exec.agent } : {},
            parent: exec.token,
            signal: runController.signal,
          })
          for (const context of result.additionalContexts ?? []) {
            exec.deferContext(context)
          }
          const text = textOf(result.content)
          exec.agent?.session.append('tool/code-dispatch', {
            parentCallId: exec.callId,
            subCallId,
            name,
            // The SIBLING parse of the dispatched value: byte-identical JSON,
            // but a separate object — a tool mutating its args cannot desync
            // this record from what it actually received.
            arguments: normalized.logged,
            isError: result.isError,
            resultSummary: summarize(text, exec.agent.session.header.cwd),
          })
          return { text, isError: result.isError }
        })
        // A budget expiry or outer cancel that lands while this call was in
        // flight already aborted the dispatch; stop the program now rather
        // than hand it a result from a run that is over.
        if (runOver()) {
          throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`)
        }
        // A failed tool call REJECTS — real code signals failure by throwing,
        // so try/catch and Promise.all short-circuiting behave as models
        // expect (the error text is the tool's model-facing result text).
        if (outcome.isError) throw new Error(outcome.text)
        return outcome.text
      }

      // Null-prototype + defineProperty, mirroring the worker-side namespace
      // build: a registered tool named `__proto__` must become an ordinary
      // own key (a plain-object assignment would hit the prototype setter,
      // silently dropping the binding), and the runtime host resolves
      // binding names as own properties only.
      const functions: Record<string, CodeBindingFunction> = Object.create(null) as Record<string, CodeBindingFunction>
      // Enumerate the CALLING AGENT's visible set (scoped tools join,
      // restricted globals vanish) — the same view the SDK section declared,
      // so a program can bind exactly what its prompt promised; sub-dispatch
      // re-resolves per call through the same view (exec.agent threads down).
      for (const schema of registry.schemas(exec.agent)) {
        if (schema.name === RUN_CODE_NAME) continue
        Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(schema.name) })
      }

      try {
        let result: CodeRunResult
        try {
          result = await runtime.run({
            program: args.code,
            bindings: [{ global: 'tools', functions }],
            signal: runController.signal,
          })
        } finally {
          // Abort sub-dispatches and drain the folded queue before closing the turn.
          // Binding failures remain observable through their individual promises.
          runController.abort('run_code settled')
          await queue
        }

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
          throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`)
        }
        const rendered = renderValue(result.value)
        const parts = [result.logs.join('\n'), rendered].filter(part => part.length > 0)
        const meta: RunCodeMeta = { logs: result.logs }
        return {
          content: [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }],
          meta,
        }
      } finally {
        exec.signal?.removeEventListener('abort', onOuterAbort)
      }
    },
    // ACP execute cards use the program as their visible title.
    presentCall: args => ({
      card: 'generic',
      title: args.code,
      kind: 'execute',
      rawInput: args.code,
    }),
    // Title omitted on the result: an update replaces only the fields it
    // carries, so the pending card's program title persists through
    // completion; the captured output rides as body content.
    presentResult: (_args, result) => {
      const meta = asRunCodeMeta(result.meta)
      if (!meta) return undefined
      const output = meta.logs.join('\n')
      return {
        card: 'generic',
        ...output.length > 0 ? { content: [{ type: 'text' as const, text: output }] } : {},
      }
    },
  })
}
