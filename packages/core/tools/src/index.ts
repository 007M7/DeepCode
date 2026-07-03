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
     * own logic), or return a {@link ToolExecutionResult} without calling
     * `next()` to short-circuit (veto).
     * @mode waterfall
     */
    'tools/execute'(this: ToolRegistry, exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * A tool was registered or unregistered (the available tool set changed).
     * @mode emit
     */
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
 * A file location a tool reads or modifies, so a capable UI can "follow along" —
 * highlight or jump to the file (and line) as the tool runs. Provider-neutral;
 * a UI bridge maps it to its own affordance (the ACP bridge forwards it as
 * `tool_call.locations`). `path` is what the tool operated on (the model-facing
 * path); `line` is an optional 1-based line to focus (e.g. a read's offset).
 */
export interface FileLocation {
  path: string
  line?: number
}

/**
 * A single-file change a tool is about to make, for a UI that renders inline
 * diffs (an editor's diff card). Provider-neutral; the ACP bridge forwards it as
 * a `{ type: 'diff' }` tool-call content block. `oldText` is `null` for a
 * new-file create (nothing to diff against); an overwrite also uses `null`,
 * because a call-time presenter has no access to the file's prior content.
 */
export interface FileDiff {
  path: string
  /** Prior content, or `null` for a new file / an overwrite (no prior content available at call time). */
  oldText: string | null
  /** Content after the change. */
  newText: string
}

/**
 * How a tool wants ONE of its calls shown in a UI (an editor's tool-call card, a
 * CLI log line) BEFORE the result is known — the *pending* state. A `card`-tagged
 * discriminated union: a tool declares its render INTENT once and a UI bridge
 * switches on `card` to map it to the bridge's own wire shape. Provider-neutral —
 * the tool owns its presentation, so a UI never special-cases tool names.
 *
 * Returned by {@link ToolDefinition.presentCall}. See the render-intent-union
 * RFC (docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md).
 */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/**
 * The default card: a titled tool-call row with an optional category icon, a
 * salient raw input, extra content blocks, and follow-along file locations. Any
 * tool whose call is not a terminal or a diff uses this.
 */
export interface GenericCallView {
  card: 'generic'
  /**
   * Human-readable, always-visible label describing what THIS call does. Keep it
   * short — a UI shows it as a card header / log line.
   */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /**
   * The salient input to surface in a detail/expanded view (e.g. a background
   * task id). Omit to show nothing; a string renders as-is, an object as pretty
   * JSON. NOT the full raw args object unless that is genuinely what a reader wants.
   */
  rawInput?: unknown
  /**
   * UI-facing content blocks to show on the pending call alongside the title.
   * Omit to show none. A UI maps these to its own content blocks.
   */
  content?: ContentBlock[]
  /** Files this call reads/modifies, for editor follow-along. Omit for a call that touches no file. */
  locations?: FileLocation[]
}

/**
 * A call that IS a shell command running in a working directory: a capable UI
 * renders it as a terminal card (cwd-headed, with the command as the title and
 * live/afterward output from the {@link TerminalResultView}); an incapable UI
 * falls back to a generic card whose body is the fenced command output. Set by a
 * tool whose call is a foreground command (e.g. `bash`).
 */
export interface TerminalCallView {
  card: 'terminal'
  /** The command, shown as the terminal card's title / header line. */
  title: string
  /**
   * A human-readable one-line summary of what the command does, rendered ABOVE
   * the terminal card (the card itself has no description slot). Omit for none.
   */
  description?: string
  /**
   * Working directory the command runs in, shown as the terminal header. An
   * ABSOLUTE path is used as-is; a RELATIVE path is resolved by the UI bridge
   * against the session workspace (the pure presenter can't see the session cwd).
   * Omit entirely to let the bridge use the session workspace.
   */
  cwd?: string
}

/**
 * A call that creates or modifies files, rendered as an inline diff card by a
 * capable UI. Set by a tool whose call writes/edits a file (e.g. `write`,
 * `edit`). The diffs are derived from the call ARGUMENTS (a create's `oldText` is
 * `null`); the tool emits a separate {@link DiffResultView} after `execute` — the
 * applied change (an edit/overwrite hunk with context, or a whole-file diff for a
 * create).
 */
export interface DiffCallView {
  card: 'diff'
  /** Card header (e.g. `Write foo.txt`). */
  title: string
  /** One entry per file the call changes. */
  diffs: FileDiff[]
  /** Files this call modifies, for editor follow-along (usually the diffs' paths). */
  locations?: FileLocation[]
}

/**
 * How a tool wants the COMPLETED call shown — the *result* state, after `execute`
 * returns. A `card`-tagged union mirroring {@link ToolCallView}: a UI switches on
 * `card`. Lets the tool reformat its result for a UI distinctly from the
 * model-facing text it returned from `execute`. Returned by
 * {@link ToolDefinition.presentResult}; omitting the method keeps the pending
 * title and renders the raw result content.
 */
export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView

/**
 * The default completed card: an optional replacement title and reformatted
 * content. Omit a field to keep the pending title / render the raw result content.
 */
export interface GenericResultView {
  card: 'generic'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /**
   * UI-facing result content (harness {@link ContentBlock}s), reformatted from
   * the model-facing result. Omit to let the UI render the raw result content.
   */
  content?: ContentBlock[]
}

/**
 * The completed state of a {@link TerminalCallView}: the captured output and exit
 * status. A capable UI renders `output` in the terminal card and shows an
 * exit-status pill; an incapable UI gets a fenced ```console fallback the BRIDGE
 * derives from `output` (the tool does not double-encode it).
 */
export interface TerminalResultView {
  card: 'terminal'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** Captured command output (stdout+stderr as the tool chooses to combine them). */
  output?: string
  /**
   * Process exit code, when the run ended by exiting (not a signal). Lets a
   * capable UI show an exit-status pill. Omit when killed by a signal or unknown.
   */
  exitCode?: number
  /** Signal name that killed the process (e.g. `SIGTERM`). Mutually exclusive with `exitCode`. */
  signal?: string
}

/**
 * A completed file mutation rendered as an inline diff card, the *result-time*
 * analogue of {@link DiffCallView}. Set by a tool whose `execute` applied a file
 * change (e.g. `write`, `edit`): `diffs` are the change to show — typically the
 * APPLIED hunks computed from the before/after content (one entry per hunk, each
 * with surrounding context lines), so the editor shows the real change in place;
 * a tool with no before-image (e.g. a file create) may instead give a whole-file
 * diff (`oldText: null`). A `tool_call_update`'s content REPLACES the call's
 * content in an editor, so a mutation tool returns this even when it duplicates
 * the call-time snippet — otherwise the model-facing result text would replace
 * (clobber) the pending diff card.
 */
export interface DiffResultView {
  card: 'diff'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The change to show, in file order — applied contextual hunks, or a whole-file diff when there is no before-image. */
  diffs: FileDiff[]
}

/**
 * What a tool's `execute` returns. The bare {@link ContentBlock}`[]` form is the
 * common case (model-facing content only); the object form additionally attaches
 * a tool-private `meta` presentation payload that the registry threads onto the
 * `tool/result` session event and hands back to the tool's `presentResult`.
 * `meta` is opaque to the core (`unknown` — the tool owns and narrows its shape),
 * and MUST be JSON-serializable: it persists on the durable log (the session
 * enforces this at `append`), so replay reproduces the card.
 */
export type ToolExecuteReturn = ContentBlock[] | { content: ContentBlock[]; meta?: unknown }

/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ToolExecuteReturn>
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * `result` (`execute`'s content + whether it errored). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

/** The completed outcome handed to {@link ToolDefinition.presentResult}. */
export interface ToolResult {
  /** The model-facing content `execute` returned (or the error text on failure). */
  content: ContentBlock[]
  /** Whether the call failed. */
  isError: boolean
  /**
   * The tool-private presentation payload the tool attached from `execute` (via
   * the object return form), threaded verbatim from the `tool/result` event.
   * Opaque (`unknown`); the tool narrows it back to its own shape. Absent when
   * the tool attached none.
   */
  meta?: unknown
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
  /**
   * The tool-private presentation payload from a successful `execute` (the object
   * return form). Threaded onto the `tool/result` session event and back into
   * {@link ToolResult} for `presentResult`. Opaque (`unknown`); absent when the
   * tool attached none or the call failed.
   */
  meta?: unknown
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
      parameters: structuredClone(parameters),
      ...strict !== undefined ? { strict } : {},
    }))
  }

  /**
   * Execute one tool call through the `tools/execute` waterfall. If the tool is
   * not registered, the result is an `isError` carrying a `UNKNOWN_TOOL`
   * structured error. If the tool or a waterfall listener throws, the error is
   * caught and returned as an `isError` result so the loop records a failed tool
   * call instead of failing the whole turn; a thrown {@link HarnessError}
   * surfaces its `{ name, code }` on the result.
   */
  async execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    try {
      return await this.ctx.waterfall(this, 'tools/execute', exec, async (): Promise<ToolExecutionResult> => {
        try {
          const tool = this.store.get(exec.name)
          // Unknown tool routes through the same catch as a tool-thrown error, so
          // both failure classes get structured `{ name, code }` from one path.
          if (!tool) throw new ToolNotFoundError(exec.name)
          // Normalize the two `execute` return shapes: a bare ContentBlock[] (no
          // meta) or a { content, meta } object (a tool attaching a private
          // presentation payload). An array IS the content; the object carries it.
          const returned = await tool.execute(exec.arguments, exec)
          const content = Array.isArray(returned) ? returned : returned.content
          const meta = Array.isArray(returned) ? undefined : returned.meta
          return { callId: exec.callId, content, isError: false, ...meta !== undefined ? { meta } : {} }
        } catch (error: unknown) {
          return toolErrorResult(exec.callId, error)
        }
      })
    } catch (error: unknown) {
      return toolErrorResult(exec.callId, error)
    }
  }
}

function toolErrorResult(callId: ToolExecution['callId'], error: unknown): ToolExecutionResult {
  const info = errorInfo(error)
  return {
    callId,
    content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
    isError: true,
    ...info ? { error: info } : {},
  }
}

export default ToolRegistry
