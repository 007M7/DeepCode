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

/**
 * Category of a tool call, used by a UI to pick an icon / treatment. A neutral
 * vocabulary owned here (NOT an ACP type) so tools describe themselves without
 * depending on any client protocol; a UI bridge maps it to its own enum. The
 * member set mirrors the common ACP `ToolKind` values; `other` is the default.
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/**
 * How a tool wants ONE of its calls shown in a UI (an editor's tool-call card,
 * a CLI log line) BEFORE the result is known — the *pending* state. Provider-
 * neutral: a tool returns this from {@link ToolDefinition.presentCall} and a UI
 * plugin (e.g. the ACP bridge) maps it to its own wire shape. The tool owns its
 * own presentation — the UI must not special-case tool names.
 */
export interface ToolCallPresentation {
  /**
   * Human-readable, always-visible label describing what THIS call does (e.g.
   * the model-written one-line summary of a bash command). Keep it short — a UI
   * shows it as a card header / log line. Required: a presentation must have a
   * title (a UI falls back to the tool name only when `presentCall` is absent).
   */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /**
   * The salient input to surface in a detail/expanded view — e.g. the bash
   * COMMAND itself (as a string), so the title can stay a readable summary
   * while the exact command is still visible. Omit to show nothing; a string is
   * rendered as-is, an object as pretty JSON. NOT the full raw args object
   * unless that is genuinely what a reader wants.
   */
  rawInput?: unknown
}

/**
 * How a tool wants the COMPLETED call shown — the *result* state, after
 * `execute` returns. Lets the tool reformat its result for a UI distinctly from
 * the model-facing text it returned from `execute` (e.g. wrap command output in
 * a fenced ```console block for monospace rendering, which the model-facing
 * result must NOT carry). All fields optional: a UI keeps the pending-state
 * title and renders the raw result content for anything left unset.
 */
export interface ToolResultPresentation {
  /** Replacement title for the completed call (e.g. append an exit status). Omit to keep the pending-state title. */
  title?: string
  /**
   * UI-facing result content (harness {@link ContentBlock}s), reformatted from
   * the model-facing result. Omit to let the UI render the raw result content.
   * Stays in harness vocabulary; the UI maps these to its own content blocks.
   */
  content?: ContentBlock[]
}

/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]>
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived
   * from the call's `args` (parsed arguments, `unknown` — the tool validates/
   * narrows its own input). Returning `undefined` (or omitting the method) tells
   * a UI to fall back to a generic presentation (title = tool name, raw args as
   * input). Pure and side-effect-free: a UI may call it during live streaming
   * AND a session-log replay, so it must depend only on `args`.
   */
  presentCall?(args: unknown): ToolCallPresentation | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * `result` (`execute`'s content + whether it errored). Returning `undefined`
   * (or omitting the method) tells a UI to keep the pending title and render the
   * raw result content. Pure and side-effect-free for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultPresentation | undefined
}

/** The completed outcome handed to {@link ToolDefinition.presentResult}. */
export interface ToolResult {
  /** The model-facing content `execute` returned (or the error text on failure). */
  content: ContentBlock[]
  /** Whether the call failed. */
  isError: boolean
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
   * Return all registered tool schemas — exactly the model-facing fields
   * (`name`, `description`, `parameters`, and `strict` when set), as sent to the
   * model via the system-prompt assembly. Constructed EXPLICITLY rather than by
   * stripping known non-schema members: a `ToolDefinition` also carries
   * `execute` and the optional `presentCall`/`presentResult` UI callbacks, and
   * those (especially the functions) must never leak into a model request. An
   * allowlist can't drift when a new non-schema member is added to the
   * definition; a denylist (rest-destructure) would silently leak it.
   */
  schemas(): ToolSchema[] {
    return [...this.store.values()].map(({ name, description, parameters, strict }): ToolSchema => ({
      name,
      description,
      parameters,
      ...strict !== undefined ? { strict } : {},
    }))
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
