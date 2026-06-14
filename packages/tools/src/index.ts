/**
 * Tool registry and execution waterfall. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through the `tools/execute` waterfall for sandbox, permission, and hook
 * plugins to wrap or veto.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export {
  defineTool,
  schemaSpecToJsonSchema,
  validateArgs,
  ToolArgsError,
  type SchemaSpec,
  type SchemaProp,
  type SchemaType,
  type InferArgs,
  type DefineToolOptions,
  type JsonSchemaObject,
} from './schema.ts'

declare module 'cordis' {
  interface Context {
    tools: ToolRegistry
  }

  interface Events {
    /**
     * Waterfall around every tool execution — the single seam where sandbox,
     * permission, hook, and plan-mode plugins wrap or veto a call. Listeners
     * receive `(exec, next)`: call `next()` to proceed (possibly around your
     * own logic), or return a ToolExecutionResult without calling `next()`
     * to short-circuit (veto).
     */
    'tools/execute'(this: ToolRegistry, exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /** A tool was registered or unregistered. */
    'tools/change'(): void
  }
}

// TODO(review): revisit these shapes when the first real tools and
// sandbox/permission plugins land (e.g. a concurrency-safety hint for
// parallel execution — Claude Code partitions read-only tools; phase 1
// executes sequentially).

/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]>
}

/** One pending tool call, as it flows through the execution waterfall. */
export interface ToolExecution {
  callId: CallId
  name: string
  /** Parsed JSON arguments (unknown — tools validate their own input). */
  arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  agent?: Agent
  signal?: AbortSignal
}

/** Structured error metadata for a failed tool call (alongside the model-facing text). */
export interface ToolErrorInfo {
  name: string
  code: string
}

/**
 * Thrown (internally) when the model requests a tool that isn't registered.
 * Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
 * failure is as routable as a tool-thrown one — retry/sandbox/replay code can
 * distinguish it from a tool body's own error.
 */
export class ToolNotFoundError extends HarnessError {
  constructor(public readonly toolName: string) {
    super(`unknown tool "${toolName}"`, 'UNKNOWN_TOOL')
    this.name = 'ToolNotFoundError'
  }
}

/** The outcome of one tool call. */
export interface ToolExecutionResult {
  callId: CallId
  content: ContentBlock[]
  isError: boolean
  /**
   * Set when the call failed with a {@link HarnessError}: machine-routable
   * `{ name, code }` for retry/sandbox plugins and replay. The model-facing
   * text in `content` is always present; this is extra structure for code.
   */
  error?: ToolErrorInfo
}

/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null
    && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
}

/**
 * Tool registry (`ctx.tools`): tool plugins register definitions; the agent
 * loop executes calls through the `tools/execute` waterfall. The registry
 * contributes its schemas into the system-prompt assembly.
 */
export class ToolRegistry extends Service {
  static inject = ['systemPrompt']

  private store = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(() => this.schemas())
  }

  /**
   * Register a tool. Throws if a tool with the same name is already
   * registered. The tool's schema (minus the `execute` function) is
   * automatically contributed to the system-prompt assembly. Disposed
   * with the calling fiber. Emits `tools/change` on register/unregister.
   */
  register(definition: ToolDefinition): () => void {
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      if (this.store.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered`)
      }
      this.store.set(definition.name, definition)
      // Yield the rollback BEFORE emitting `tools/change`: a generator effect
      // collects each yielded disposer before the next step runs, so a throwing
      // `tools/change` listener removes the tool instead of leaking it (a leak
      // would wedge the duplicate-name check until restart). The duplicate
      // throw above fires before any mutation — it leaks nothing.
      yield () => {
        this.store.delete(definition.name)
        this.ctx.emit('tools/change')
      }
      this.ctx.emit('tools/change')
    }.bind(this), 'tools.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  get(name: string): ToolDefinition | undefined {
    return this.store.get(name)
  }

  /**
   * Return all registered tool schemas, stripped of their `execute` functions.
   * These are exactly what gets sent to the model via the system-prompt
   * assembly.
   */
  schemas(): ToolSchema[] {
    // Rest-destructure to drop `execute`; the unused binding is the idiom.
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unused-vars
    return [...this.store.values()].map(({ execute, ...schema }) => schema)
  }

  /**
   * Execute one tool call through the `tools/execute` waterfall. If the tool
   * is not registered, the result is an `isError` carrying a `UNKNOWN_TOOL`
   * structured error. If the tool throws, the error is caught and returned as
   * an `isError` result so the loop never sees an uncaught exception; a thrown
   * {@link HarnessError} surfaces its `{ name, code }` on the result.
   */
  execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    return this.ctx.waterfall(this, 'tools/execute', exec, async (): Promise<ToolExecutionResult> => {
      try {
        const tool = this.store.get(exec.name)
        // Unknown tool routes through the same catch as a tool-thrown error, so
        // both failure classes get structured `{ name, code }` from one path.
        if (!tool) throw new ToolNotFoundError(exec.name)
        const content = await tool.execute(exec.arguments, exec)
        return { callId: exec.callId, content, isError: false }
      } catch (error: unknown) {
        const info = errorInfo(error)
        return {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
          isError: true,
          ...info ? { error: info } : {},
        }
      }
    })
  }
}

export default ToolRegistry
