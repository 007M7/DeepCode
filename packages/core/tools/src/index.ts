/**
 * Tool registry and execution pipeline. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through `tools/pre-execute` (the allow/deny gate) → core dispatch →
 * `tools/post-execute` (inspect/replace the result, attach context) for
 * sandbox, permission, and hook plugins to gate or transform a call.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
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
     * Waterfall BEFORE a tool runs — the gate where sandbox, permission, and
     * hook plugins allow or deny a call (Claude Code's `PreToolUse`). Listeners
     * receive `(exec, next)`: call `next()` to delegate to the default (allow),
     * or return a {@link PreToolDecision} without calling `next()` to
     * short-circuit. A `deny` skips dispatch and yields an `isError` result; the
     * tool body never runs. Input rewrite is deliberately NOT offered here (see
     * {@link PreToolDecision}); `ask` degrades to deny until the permission
     * system lands (`FIXME(permissions)`).
     * @mode waterfall
     */
    'tools/pre-execute'(this: ToolRegistry, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Waterfall AFTER a tool runs — where hook plugins inspect the result and
     * accept it (optionally REPLACING the model-facing content, and/or attaching
     * `additionalContext` for the next request) or block it with corrective
     * `feedback` (Claude Code's `PostToolUse`). Listeners receive
     * `(exec, result, next)`: call `next()` to delegate to the default (accept
     * unchanged), or return a {@link PostToolDecision} to override. The core tool
     * dispatch sits between the two waterfalls as plain code, all inside
     * `execute`'s outer try/catch (and the tool body keeps its own inner
     * try/catch, so a thrown tool still reaches `post-execute` as an `isError`
     * result).
     * @mode waterfall
     */
    'tools/post-execute'(this: ToolRegistry, exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
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

// FIXME(tool-presentation): the ToolCallPresentation / ToolResultPresentation /
// ToolTerminal shapes need a rethink. They grew incrementally (title/kind/
// rawInput, then a `content` block, then a `terminal` sub-shape carrying cwd/
// output/exit) and the split of responsibility is now muddy: the call vs result
// terminal fields overlap, the bridge has to reconcile a `content` block AND a
// `terminal` block AND `rawInput` per call, and the "pending vs completed"
// boundary doesn't cleanly map to how editors actually render (terminal card,
// diff, generic card). Before more tools/UIs depend on this, redesign the type
// so a tool declares its render INTENT once (e.g. a tagged union over card
// kinds) rather than a bag of optional fields the bridge stitches together.
// Pin the design in an RFC and migrate dsh-tool-bash + the ACP bridge together.

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
  /**
   * UI-facing content to show on the PENDING call alongside the title/card —
   * harness {@link ContentBlock}s, in render order. A terminal tool uses this to
   * surface its human-readable `description` as a text block ABOVE the terminal
   * card (the card itself is requested via {@link terminal} and labelled by the
   * command in `title`), since the card has no description slot. Omit to show no
   * extra content. A UI maps these to its own content blocks and renders a
   * {@link terminal} block (if any) as a terminal card.
   */
  content?: ContentBlock[]
  /**
   * Ask a capable UI to render this call as a TERMINAL (a command running in a
   * working directory), not a generic tool card — set by a tool whose call IS a
   * shell command (e.g. `bash`). Provider-neutral; a UI bridge maps it to its
   * own terminal affordance and a UI that can't falls back to the normal card.
   * Pair with {@link ToolResultPresentation.terminal} for the output/exit.
   */
  terminal?: ToolTerminal
}

/**
 * A request to render a tool call as a terminal. The pending presentation
 * supplies the working directory; the result presentation (see
 * {@link ToolResultPresentation.terminal}) supplies the captured output and exit
 * status. Provider-neutral — no client-protocol types. A UI that supports
 * terminals shows a cwd-headed terminal card with the command, its output, and
 * an exit-status pill; a UI that does not ignores this and renders the ordinary
 * card/content.
 */
export interface ToolTerminal {
  /**
   * Working directory the command ran in, shown as the terminal header. An
   * ABSOLUTE path is used as-is; a RELATIVE path is resolved by the UI bridge
   * against the session workspace (the pure tool presenter can't see the
   * session cwd). Omit entirely to let the bridge use the session workspace.
   */
  cwd?: string
  /** Captured command output (stdout+stderr as the tool chooses to combine them). Result-state only. */
  output?: string
  /**
   * Process exit code, when the run ended by exiting (not a signal). Result-state
   * only; lets a capable UI show an exit-status pill on the terminal card. Omit
   * when the command was killed by a signal or the exit code is unknown.
   */
  exitCode?: number
  /**
   * Signal name that killed the process (e.g. `SIGTERM`), when it died by signal
   * rather than exiting. Result-state only; mutually exclusive with `exitCode`.
   */
  signal?: string
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
  /**
   * Terminal output/exit for a call the pending presentation marked as a
   * terminal (see {@link ToolCallPresentation.terminal}). A capable UI renders
   * `output` in the terminal card and shows the exit status; an incapable UI
   * uses `content` (the tool should supply a text fallback there too).
   */
  terminal?: ToolTerminal
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
  /**
   * Extra model-facing context a `tools/post-execute` listener attached for the
   * NEXT request (Claude Code's PostToolUse `additionalContext`). It is NOT part
   * of this call's `content` — `content`/`feedback` shape the tool RESULT, but
   * `additionalContext` is a SEPARATE `context/message`. A step can carry
   * multiple tool calls, so the loop BUFFERS every call's `additionalContext`
   * and appends them only AFTER all `tool/result`s for the step, keeping
   * tool-call/result adjacency intact. Carried on the result purely to ferry it
   * from `execute()` up to the loop's per-step buffer.
   */
  additionalContext?: HookContext
}

/**
 * The decision a `tools/pre-execute` listener returns for one pending call.
 * Maps onto Claude Code's `PreToolUse` `permissionDecision`.
 *
 * - `allow` proceeds to dispatch. (Input rewrite — changing `exec.arguments` —
 *   is deliberately NOT offered: `tool/call` and `assistant/message` are logged
 *   BEFORE execution and live consumers, e.g. the ACP bridge and `dsh-tool-bash`
 *   presentation, read the pre-execution arguments, so an execution-only rewrite
 *   would desync the UI from what RAN. That consistency redesign is its own
 *   `proposed` RFC; `TODO(pre-tool-input-rewrite)` anchors it at the call site.)
 * - `deny` skips dispatch; the loop records an `isError` result carrying `reason`.
 * - `ask` is the permission-prompt intent; until the permission system exists it
 *   degrades to `deny` (`FIXME(permissions)`).
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/**
 * The decision a `tools/post-execute` listener returns for one finished call.
 * Maps onto Claude Code's `PostToolUse` decision.
 *
 * - `accept` keeps the call successful; optional `content` REPLACES the
 *   model-facing result (clean: `tool/result` is logged AFTER `execute()`
 *   returns, so a replaced result is the single source of truth for both derived
 *   history and UI). Optional `additionalContext` rides to the next request.
 * - `block` turns the call into an `isError` result whose content is the
 *   corrective `feedback` (the model is told the call was rejected and why),
 *   optionally also attaching `additionalContext`.
 */
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContext?: HookContext }

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
 * loop executes calls through the `tools/pre-execute` → dispatch →
 * `tools/post-execute` pipeline. The registry contributes its schemas into the
 * system-prompt assembly.
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
   * Execute one tool call through the `tools/pre-execute` → dispatch →
   * `tools/post-execute` pipeline. The two waterfalls are the gate (allow/deny)
   * and the inspect/transform seam; core dispatch sits between them as plain
   * code. The whole thing is wrapped in one outer try/catch so a throwing
   * listener (in either waterfall) becomes an `isError` result instead of
   * failing the turn; the tool body ALSO keeps its own inner try/catch, so a
   * thrown tool becomes an `isError` result that `post-execute` listeners can
   * still inspect. If the tool is not registered, the result is an `isError`
   * carrying a `UNKNOWN_TOOL` structured error. A thrown {@link HarnessError}
   * surfaces its `{ name, code }` on the result.
   */
  async execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    try {
      // --- Gate: tools/pre-execute. A deny (or an ask, which degrades to deny
      // until the permission system lands) skips dispatch entirely. ---
      const decision = await this.ctx.waterfall(
        this, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      if (decision.kind !== 'allow') {
        // deny → isError. ask has no permission UI yet, so degrade to deny
        // (FIXME(permissions)): a forthcoming permission system turns `ask` into
        // a real prompt; today it is the conservative "not allowed".
        const reason = decision.kind === 'deny'
          ? decision.reason
          : decision.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
        const denied: ToolExecutionResult = {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: ${reason}` }],
          isError: true,
        }
        return await this.postExecute(exec, denied)
      }

      // --- Core dispatch (plain code between the waterfalls). The tool body's
      // own try/catch turns a throw into an isError result so post-execute can
      // inspect it; an unknown tool routes through the same catch. ---
      let result: ToolExecutionResult
      try {
        const tool = this.store.get(exec.name)
        if (!tool) throw new ToolNotFoundError(exec.name)
        const content = await tool.execute(exec.arguments, exec)
        result = { callId: exec.callId, content, isError: false }
      } catch (error: unknown) {
        result = toolErrorResult(exec.callId, error)
      }

      return await this.postExecute(exec, result)
    } catch (error: unknown) {
      // Outer backstop: a throwing pre/post-execute listener (or the waterfall
      // machinery) becomes an isError result, never a turn failure.
      return toolErrorResult(exec.callId, error)
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContext`,
   * which is ferried on the returned result for the loop's per-step buffer.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    // Snapshot the protected outcome BEFORE the waterfall. A listener receives
    // the same `result` reference, so a post-waterfall read of `result.callId`/
    // `.isError`/`.error` could carry a listener's mutation — violating the
    // authoritative-call-id requirement and the "preserve the dispatched
    // isError/error" contract. The decision is the ONLY sanctioned channel for a
    // listener to change the outcome (block, or accept-with-replacement); the
    // call id is always the authoritative `exec.callId`.
    const dispatched = {
      callId: exec.callId,
      content: result.content,
      isError: result.isError,
      ...result.error ? { error: result.error } : {},
    }
    const decision = await this.ctx.waterfall(
      this, 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const additionalContext = decision.additionalContext
    if (decision.kind === 'block') {
      return {
        callId: dispatched.callId,
        content: decision.feedback,
        isError: true,
        ...additionalContext ? { additionalContext } : {},
      }
    }
    // accept: replace content if supplied, preserve the dispatched isError/error.
    return {
      ...dispatched,
      ...decision.content ? { content: decision.content } : {},
      ...additionalContext ? { additionalContext } : {},
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
