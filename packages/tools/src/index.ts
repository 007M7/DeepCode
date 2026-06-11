import { Context, Service } from 'cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

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

  /** Register a tool. Disposed with the calling fiber. */
  register(definition: ToolDefinition): () => void {
    return this.ctx.effect(() => {
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
  }

  get(name: string): ToolDefinition | undefined {
    return this.store.get(name)
  }

  /** Schemas of all registered tools (without the execute functions). */
  schemas(): ToolSchema[] {
    return [...this.store.values()].map(({ execute, ...schema }) => schema)
  }

  /** Execute one tool call through the `tools/execute` waterfall. */
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
      } catch (error: any) {
        return {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }],
          isError: true,
        }
      }
    })
  }
}

export default ToolRegistry
