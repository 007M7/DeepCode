/**
 * Tool registry and execution waterfall. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through the `tools/execute` waterfall for sandbox, permission, and hook
 * plugins to wrap or veto.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export {
  defineTool,
  schemaSpecToJsonSchema,
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
  callId: string
  name: string
  /** Parsed JSON arguments (unknown — tools validate their own input). */
  arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  agent?: Agent
  signal?: AbortSignal
}

/** The outcome of one tool call. */
export interface ToolExecutionResult {
  callId: string
  content: ContentBlock[]
  isError: boolean
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
    const dispose = this.ctx.effect(() => {
      if (this.store.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered`)
      }
      this.store.set(definition.name, definition)
      this.ctx.emit('tools/change')
      return () => {
        this.store.delete(definition.name)
        this.ctx.emit('tools/change')
      }
    }, 'tools.register()')
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
   * is not registered, returns an `isError` result immediately (no waterfall).
   * If the tool throws, the error is caught and returned as an `isError` result
   * so the loop never sees an uncaught exception from a tool.
   */
  execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    return this.ctx.waterfall(this, 'tools/execute', exec, async (): Promise<ToolExecutionResult> => {
      const tool = this.store.get(exec.name)
      if (!tool) {
        return {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: unknown tool "${exec.name}"` }],
          isError: true,
        }
      }
      try {
        const content = await tool.execute(exec.arguments, exec)
        return { callId: exec.callId, content, isError: false }
      } catch (error: unknown) {
        return {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
          isError: true,
        }
      }
    })
  }
}

export default ToolRegistry
