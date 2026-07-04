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
import type { ToolCallView, ToolResultView } from './presentation.ts'

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

// The render-intent vocabulary a tool declares via `presentCall`/`presentResult`
// lives in its own UI-facing module; re-export it so `@deepseek-ai/dsh-tools`
// stays the single public surface for consumers (producers + the ACP bridge).
export type {
  ToolCallKind,
  FileLocation,
  FileDiff,
  ToolCallView,
  GenericCallView,
  TerminalCallView,
  DiffCallView,
  ToolResultView,
  GenericResultView,
  TerminalResultView,
  DiffResultView,
} from './presentation.ts'

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

/** One pending tool call, as it flows through the execution pipeline (`tools/pre-execute` → dispatch → `tools/post-execute`). */
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
  /**
   * The tool-private presentation payload from a successful `execute` (the object
   * return form). Threaded onto the `tool/result` session event and back into
   * {@link ToolResult} for `presentResult`. Opaque (`unknown`); absent when the
   * tool attached none or the call failed.
   */
  meta?: unknown
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
        // Normalize the two `execute` return shapes: a bare ContentBlock[] (no
        // meta) or a { content, meta } object (a tool attaching a private
        // presentation payload). An array IS the content; the object carries it.
        const returned = await tool.execute(exec.arguments, exec)
        const content = Array.isArray(returned) ? returned : returned.content
        const meta = Array.isArray(returned) ? undefined : returned.meta
        result = { callId: exec.callId, content, isError: false, ...meta !== undefined ? { meta } : {} }
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
    // call id is always the authoritative `exec.callId`. `content` is copied into
    // a fresh array so a listener's in-place `push`/`splice` on `result.content`
    // cannot leak into the returned content either (the elements are the same
    // references — the snapshot guards the array structure, not deep immutability).
    const dispatched = {
      callId: exec.callId,
      content: [...result.content],
      isError: result.isError,
      ...result.error ? { error: result.error } : {},
      ...result.meta !== undefined ? { meta: result.meta } : {},
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
