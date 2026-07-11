/**
 * Tool registry and execution pipeline. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through `tools/pre-execute` (the allow/deny gate) → `tools/execute` (an
 * around-dispatch wrapper for timeout/retry/metrics plugins) → `tools/post-execute`
 * (inspect/replace the result, attach context) for sandbox, permission, and hook
 * plugins to gate or transform a call.
 *
 * The registry also owns HOW its tools are presented to the model — its
 * `mode` config: `'native'` (every tool as a wire function definition,
 * today's behavior and the default), `'code'` (the wire carries exactly one
 * tool, `run_code`, plus a generated TypeScript SDK prompt section), or
 * `'both'`. See `code-mode.ts` (the tool + dispatch bridge) and
 * `ts-types.ts` (the SDK codegen); design in the Code Mode RFC.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime — see `serviceAsk`.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolCallView, ToolResultView } from './presentation.ts'
import { createRunCodeTool, RUN_CODE_NAME, SDK_SECTION_ORDER } from './code-mode.ts'
import { renderToolsSdk } from './ts-types.ts'

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

export {
  assertSupportedOutputSchema,
  validateStructuredValue,
  OutputSchemaError,
  type StructuredOutputSchema,
  type StructuredSchemaNode,
  type StructuredSchemaType,
  type StructuredScalar,
} from './json-schema.ts'

export { CodeRunFailedError, RUN_CODE_NAME } from './code-mode.ts'
export { jsonSchemaToTs, renderToolsSdk } from './ts-types.ts'

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
     * {@link PreToolDecision}); `ask` is serviced by the `ctx.approval` seam
     * when one is mounted, and degrades to deny otherwise.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: ToolRegistry, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Around-dispatch waterfall wrapping the registry's core tool dispatch,
     * between the `tools/pre-execute` gate and the `tools/post-execute` seam. A
     * listener receives `(exec, next)`: call `next()` to delegate to dispatch
     * (returning its {@link ToolExecutionResult}, optionally wrapped), or return a
     * replacement result without calling `next()` to short-circuit dispatch. The
     * base `next()` IS the dispatch-with-normalization thunk — a thrown tool (or
     * unknown tool) is already normalized to an `isError` result by the time a
     * listener's `await next()` returns, so a wrapper never sees a raw throw from
     * the tool body. This is the seam a timeout/retry/metrics plugin wraps: it can
     * mutate `exec` (e.g. replace `exec.signal` with a per-call deadline) BEFORE
     * `next()` and inspect the result AFTER. (Cordis `next()` ignores any passed
     * arguments and re-invokes downstream with the shared payload, so a wrapper
     * mutates `exec` in place rather than passing a new object to `next()`.)
     * Multiple listeners compose by registration order — an outer one wraps the
     * inner ones plus dispatch.
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: ToolRegistry, exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * Waterfall AFTER a tool runs — where hook plugins inspect the result and
     * accept it (optionally REPLACING the model-facing content, and/or attaching
     * `additionalContext` for the next request) or block it with corrective
     * `feedback` (Claude Code's `PostToolUse`). Listeners receive
     * `(exec, result, next)`: call `next()` to delegate to the default (accept
     * unchanged), or return a {@link PostToolDecision} to override. Core tool
     * dispatch runs earlier as the base `next()` of the `tools/execute`
     * waterfall, all inside `execute`'s outer try/catch (and the tool body keeps
     * its own inner try/catch, so a thrown tool still reaches `post-execute` as an
     * `isError` result).
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
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
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
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
 * - `ask` is the permission-prompt intent: serviced as a one-shot decision by
 *   the `ctx.approval` seam when one is mounted (`allowed-once` proceeds to
 *   dispatch; every other outcome denies), degrading to `deny` when none is.
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

/** How the registry presents its tools to the model (see {@link Config.mode}). */
export type ToolPresentationMode = 'native' | 'code' | 'both'

/** Plugin config: how the registered tools are presented to the model. */
export interface Config {
  /**
   * The presentation mode. `'native'` (the default) contributes every
   * registered tool as a wire function definition — byte-for-byte today's
   * behavior. `'code'` contributes exactly ONE wire tool, `run_code`, plus
   * the generated `tools:sdk` prompt section declaring every other tool as a
   * TypeScript API the program calls. `'both'` contributes every native
   * definition AND `run_code` + the SDK section. Non-native modes require a
   * loaded `ctx.codeRuntime` whose `language` is `'typescript'` — a missing
   * or mismatched runtime rejects every prompt assembly with an actionable
   * error (misconfiguration fails loud, before any model request). A
   * configured `systemPrompt.toolOrder` naming native tools likewise rejects
   * every assembly under `'code'` (those names are no longer contributed) —
   * a deployment switching modes updates its order config or drops it.
   */
  mode?: ToolPresentationMode
}

/**
 * Tool registry (`ctx.tools`): tool plugins register definitions; the agent
 * loop executes calls through the `tools/pre-execute` → `tools/execute` →
 * `tools/post-execute` pipeline. The registry contributes its schemas into the
 * system-prompt assembly — WHICH schemas is governed by its `mode` config
 * (see {@link Config.mode}); under a non-native mode it also registers the
 * `run_code` tool and the `tools:sdk` prompt section itself.
 */
export class ToolRegistry extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'code', 'both'] as const).default('native'),
  })

  private store = new Map<string, ToolDefinition>()
  private readonly mode: ToolPresentationMode

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.mode = config.mode ?? 'native'
    ctx.systemPrompt.tools(() => this.wireSchemas())
    if (this.mode !== 'native') {
      this.register(createRunCodeTool(this, () => this.requireCodeRuntime()))
      ctx.systemPrompt.section({
        name: 'tools:sdk',
        order: SDK_SECTION_ORDER,
        // A lazy thunk over the live store: regenerated at each assembly, in
        // lexicographic tool order, so an unchanged tool set renders
        // byte-identical text (prefix-cache-friendly) and a mid-session
        // registration surfaces exactly like a native-mode tool change.
        text: () => {
          this.requireCodeRuntime()
          return renderToolsSdk(this.schemas().filter(schema => schema.name !== RUN_CODE_NAME))
        },
      })
    }
  }

  /**
   * The registry's contribution to the wire tool list, per {@link Config.mode}.
   * Because `PromptAssembly.tools` is what the loop's request header
   * snapshots, the mode's collapse is logged and reconstructable for free.
   * Under a non-native mode this is also the loud misconfiguration gate: no
   * usable code runtime → every assembly rejects before any model request.
   */
  private wireSchemas(): ToolSchema[] {
    if (this.mode === 'native') return this.schemas()
    this.requireCodeRuntime()
    const all = this.schemas()
    return this.mode === 'code' ? all.filter(schema => schema.name === RUN_CODE_NAME) : all
  }

  /**
   * Resolve the code runtime or throw the actionable misconfiguration error.
   * Read at use time (assembly / run_code execution), NOT via static
   * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
   * behind it — hostage to a code runtime existing even under `mode:
   * 'native'` (the loop's optional-backend idiom, same as
   * `sessionPersistence`).
   */
  private requireCodeRuntime(): CodeRuntime {
    const runtime = this.ctx.get('codeRuntime')
    if (!runtime) {
      throw new Error(`dsh-tools: mode "${this.mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker) or set tools mode to "native"`)
    }
    if (runtime.language !== 'typescript') {
      throw new Error(`dsh-tools: mode "${this.mode}" generates a TypeScript SDK, but the loaded code runtime's language is "${runtime.language}"`)
    }
    return runtime
  }

  /**
   * Register a tool. Throws if a tool with the same name is already
   * registered. The tool's schema (minus the `execute` function) is
   * automatically contributed to the system-prompt assembly. Disposed
   * with the calling fiber. Emits `tools/change` on register/unregister.
   * @param definition - the tool's schema plus its execute (and optional
   *   presentation) functions.
   * @returns the disposer that unregisters the tool.
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

  /**
   * Look up a registered tool.
   * @param name - the tool name as registered.
   * @returns the definition, or undefined when no tool has that name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.store.get(name)
  }

  /**
   * Return all registered tool schemas — exactly the model-facing fields
   * (`name`, `description`, `parameters`), as sent to the model via the
   * system-prompt assembly. Constructed EXPLICITLY rather than by stripping
   * known non-schema members: a `ToolDefinition` also carries `execute` and the
   * optional `presentCall`/`presentResult` UI callbacks, and those (especially
   * the functions) must never leak into a model request. An allowlist can't
   * drift when a new non-schema member is added to the definition; a denylist
   * (rest-destructure) would silently leak it.
   * @returns one deep-cloned schema per registered tool, in registration order.
   */
  schemas(): ToolSchema[] {
    return [...this.store.values()].map(({ name, description, parameters }): ToolSchema => ({
      name,
      description,
      parameters: structuredClone(parameters),
    }))
  }

  /**
   * Execute one tool call through the `tools/pre-execute` → `tools/execute`
   * (around dispatch) → `tools/post-execute` pipeline. `pre-execute` is the gate
   * (allow/deny), `tools/execute` wraps core dispatch (a timeout/retry/metrics
   * seam), and `post-execute` is the inspect/transform seam; core dispatch sits
   * as the base `next()` of the `tools/execute` waterfall. The whole thing is
   * wrapped in one outer try/catch so a throwing listener (in any waterfall)
   * becomes an `isError` result instead of failing the turn; the tool body ALSO
   * keeps its own inner try/catch, so a thrown tool becomes an `isError` result
   * that `tools/execute` and `post-execute` listeners can still inspect. If the
   * tool is not registered, the result is an `isError` carrying a `UNKNOWN_TOOL`
   * structured error. A thrown {@link HarnessError} surfaces its `{ name, code }`
   * on the result.
   * @param exec - the call to run (name, parsed arguments, caller agent, signal).
   * @returns the final result after every waterfall; failures resolve as
   *   `isError` results, never rejections.
   */
  async execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    try {
      // --- Gate: tools/pre-execute. An `ask` resolves through the approval
      // seam (or degrades) to allow/deny before the shared deny path. ---
      const gate = await this.ctx.waterfall(
        this, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const decision = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : gate
      if (decision.kind !== 'allow') {
        const denied: ToolExecutionResult = {
          callId: exec.callId,
          content: [{ type: 'text', text: `Error: ${decision.reason}` }],
          isError: true,
        }
        return await this.postExecute(exec, denied)
      }

      // --- Around-dispatch: tools/execute. The base `next` is the dispatch-
      // with-normalization thunk — the tool body's own try/catch turns a throw
      // into an isError result so a wrapper (and post-execute) can inspect it;
      // an unknown tool routes through the same catch. A `tools/execute` listener
      // (e.g. a timeout plugin) wraps this thunk: it may mutate `exec` before
      // delegating and inspect the normalized result after. ---
      const result = await this.ctx.waterfall(
        this, 'tools/execute', exec,
        async (): Promise<ToolExecutionResult> => {
          try {
            const tool = this.store.get(exec.name)
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
        },
      )

      return await this.postExecute(exec, result)
    } catch (error: unknown) {
      // Outer backstop: a throwing pre/post-execute listener (or the waterfall
      // machinery) becomes an isError result, never a turn failure.
      return toolErrorResult(exec.callId, error)
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel.
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<Extract<PreToolDecision, { kind: 'allow' | 'deny' }>> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` }
    }
    if (exec.agent === undefined) {
      return { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      ...exec.signal !== undefined ? { signal: exec.signal } : {},
    })
    switch (outcome) {
      case 'allowed-once': return { kind: 'allow' }
      case 'rejected': return { kind: 'deny', reason: `the user rejected tool "${exec.name}"` }
      case 'cancelled': return { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` }
      case 'unavailable': return { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` }
      default: return assertNever(outcome, 'ApprovalOutcome')
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
