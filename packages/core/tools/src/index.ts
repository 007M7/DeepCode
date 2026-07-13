/**
 * Tool registry and execution pipeline. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through `tools/pre-execute` (the extensible allow/deny gate) → monotonic
 * registered guards → `tools/execute` (an around-dispatch wrapper for
 * timeout/retry/metrics plugins) → `tools/post-execute` (inspect/replace the
 * result, attach context) → the observe-only `tools/result` notification.
 *
 * The registry also owns HOW its tools are presented to the model — its
 * `mode` config: `'native'` (every tool as a wire function definition,
 * today's behavior and the default), `'code'` (the registry's canonical wire
 * contribution is one tool, `run_code`, plus a generated TypeScript SDK prompt section), or
 * `'both'`. See `code-mode.ts` (the tool + dispatch bridge) and
 * `ts-types.ts` (the SDK codegen); design in the Code Mode RFC.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) keys the carrier by `exec.agent`: a
     * listener registered through `agent.ctx` fires only for that agent's
     * calls, while a plain plugin listener fires for every call (including
     * agent-less ones, which dispatch subject-less).
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
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
     * set or replace the one mutable field, `exec.signal` (e.g. with a per-call
     * deadline), BEFORE `next()`, restore/delete it afterward, and inspect the result AFTER. Call identity
     * (`token`, `callId`, `name`, `arguments`, `agent`, and `parent`) is immutable throughout the
     * pipeline so a wrapper cannot change which tool and scope the pipeline
     * accepted. (Cordis `next()` ignores passed arguments and re-invokes
     * downstream with the shared payload, so a wrapper changes `exec.signal` in
     * place rather than passing a new object to `next()`.)
     * Multiple listeners compose by registration order — an outer one wraps the
     * inner ones plus dispatch.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed by
     * `exec.agent` — a listener registered through `agent.ctx` wraps only that
     * agent's calls; a plain plugin listener wraps every call (including
     * agent-less ones, which dispatch subject-less).
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed by
     * `exec.agent` — a listener registered through `agent.ctx` fires only for
     * that agent's calls; a plain plugin listener fires for every call
     * (including agent-less ones, which dispatch subject-less).
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * Synchronous notification of the authoritative FINAL tool outcome, after the
     * complete pre/execute/post pipeline, final lossless-JSON validation, and
     * outer error normalization.
     * Unlike the three waterfalls, this seam cannot transform the result: each
     * listener receives the now-frozen execution object and a deep-frozen result
     * snapshot; listener failures are contained and logged, and
     * {@link ToolRegistry.execute} still returns the outcome.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by
     * `exec.agent`, using the same carrier as the pipeline.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRegistry>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
    /**
     * A tool was registered or unregistered, or a scoped restriction changed
     * (the available tool set changed — possibly for one scope only). An
     * UNFILTERED registry-subject notification, deliberately not scope-filtered
     * dispatch: a global change concerns every agent's next assembly, so a
     * scoped listener subscribing here sees every change, not just its own
     * scope's.
     * @mode emit
     */
    'tools/change'(): void
  }
}

// TODO(review): revisit these shapes when concurrency metadata becomes useful
// (for example, a read-only hint that would permit safe parallel execution).

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

declare const toolExecutionTokenBrand: unique symbol

/**
 * Opaque identity for one trip through the tool pipeline. Nested
 * transports carry the enclosing execution's token instead of its live object,
 * so observe-only result listeners can correlate calls without gaining a
 * mutation path into an outer around-dispatch wrapper.
 */
export type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }

/**
 * Caller-supplied description of one tool call. {@link ToolRegistry.execute}
 * adds the registry-owned token to form a pipeline {@link ToolExecution};
 * callers do not choose that token.
 */
export interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Opaque token of the enclosing transport execution, when one exists. Code
   * Mode sets this on SDK sub-dispatches so commit-style observers can wait for
   * the outer `run_code` outcome without receiving its live mutable execution.
   */
  readonly parent?: ToolExecutionToken
  signal?: AbortSignal
}

/**
 * One pending tool call inside the registry pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity and the registry-assigned {@link token} are readonly. An
 * around-dispatch wrapper may set, replace, or remove `signal`. The registry
 * freezes the complete object before `tools/result` observers run.
 */
export interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
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
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    return String(error)
  } catch {
    // A hostile thrown value can trap `instanceof`, property access, or string
    // coercion. Error normalization is the outermost safety boundary, so its
    // fallback must itself be total.
    return '<unprintable thrown value>'
  }
}

/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

/** How the registry presents its tools to the model (see {@link Config.mode}). */
export type ToolPresentationMode = 'native' | 'code' | 'both'

/** Plugin config: how the registered tools are presented to the model. */
export interface Config {
  /**
   * The presentation mode. `'native'` (the default) contributes every
   * visible end capability as a native wire function definition. Under
   * `'code'` this registry contributes exactly ONE wire tool,
   * `run_code`, plus the generated `tools:sdk` prompt section declaring every other tool as a
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
 * A per-scope restriction over the GLOBAL tool surface, registered via
 * {@link ToolRegistry.restrict}. `allow` keeps only the listed global tools;
 * `deny` removes the listed ones; both present = allow first, then deny.
 * Restrictions never touch scoped registrations — a tool registered through
 * the same scope is merged after the global filter (which is what keeps e.g. a
 * structured-output capture tool alive under an allow-list). The readonly
 * filter values compile to private sets at registration, but resolution uses the live global registry:
 * a later global name passes a deny-only filter unless explicitly denied and
 * fails an allow-list unless explicitly allowed. The
 * reserved `run_code` presentation transport is likewise outside capability
 * filtering, and naming it explicitly is rejected. Multiple restrictions on
 * one scope compose by intersection: every one must admit.
 */
export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and transport insertion. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

/** One guard registration; the wrapper preserves independent duplicate registrations. */
interface ToolGuardRegistration {
  guard: ToolGuard
}

/**
 * Tool registry (`ctx.tools`): tool plugins register definitions; the agent
 * loop executes calls through the `tools/pre-execute` → guards →
 * `tools/execute` → `tools/post-execute` → `tools/result` pipeline. The
 * registry contributes its schemas into the system-prompt assembly — WHICH
 * schemas is governed by its `mode` config
 * (see {@link Config.mode}); under a non-native mode it also owns the reserved
 * `run_code` presentation transport and the `tools:sdk` prompt section.
 *
 * Two registration layers (`@deepseek-ai/dsh-scope`): a registration through a
 * plain plugin context is GLOBAL (visible to every agent); one through a
 * scoped context (`agent.ctx`) is filed in that scope's layer — visible to
 * that agent alone, disposed with the scope, and SHADOWING a global tool of
 * the same name for that agent (most-specific-wins; within one layer a
 * duplicate name still throws). {@link restrict} masks the global layer per
 * scope. One private visibility resolver feeds the registry's prompt
 * contribution, {@link get}, and {@link execute} — and, under a non-native
 * mode, the SDK section and `run_code`'s bindings — so those registry-owned
 * presentation and dispatch paths agree. An expert `system-prompt/assemble`
 * listener may deliberately replace the final wire composition and owns any
 * resulting divergence.
 */
export class ToolRegistry extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'code', 'both'] as const).default('native'),
  })

  private global = new Map<string, ToolDefinition>()
  private scoped = new Map<ScopeKey, Map<string, ToolDefinition>>()
  /** Compiled restriction filters, per scope (see {@link restrict}). */
  private restrictions = new Map<ScopeKey, CompiledToolRestriction[]>()
  /** Monotonic post-policy guards, split into global and per-agent layers. */
  private globalGuards = new Set<ToolGuardRegistration>()
  private scopedGuards = new Map<ScopeKey, Set<ToolGuardRegistration>>()
  private readonly mode: ToolPresentationMode
  /** Reserved presentation transport, kept outside the filterable registration layers. */
  private readonly codeTransport: ToolDefinition | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.mode = config.mode ?? 'native'
    // `run_code` is presentation infrastructure, not an end capability. It
    // therefore does not enter the global layer: per-agent restrictions must
    // not remove it, and a scoped registration must not shadow it. The
    // visibility resolver appends this reserved definition after resolving
    // the filterable global/scoped capability layers.
    this.codeTransport = this.mode === 'native'
      ? undefined
      : createRunCodeTool(this, () => this.requireCodeRuntime())
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.mode !== 'native') {
      ctx.systemPrompt.section({
        name: 'tools:sdk',
        order: SDK_SECTION_ORDER,
        // A lazy thunk over the live registry, per assembly CONTEXT:
        // regenerated at each assembly over the CALLING SCOPE's visible set
        // (scoped tools join, restricted globals vanish — the SDK declares
        // exactly what that agent's programs can call), in lexicographic
        // tool order, so an unchanged tool set renders byte-identical text
        // (prefix-cache-friendly) and a mid-session registration surfaces
        // exactly like a native-mode tool change.
        text: (context) => {
          this.requireCodeRuntime()
          return renderToolsSdk(this.schemas(context.scope).filter(schema => schema.name !== RUN_CODE_NAME))
        },
      })
    }
  }

  /**
   * The registry's contribution to the wire tool list, per {@link Config.mode},
   * as ONE SCOPE sees it (scoped layer joins, shadowing and restrictions
   * applied — {@link schemas}). Because `PromptAssembly.tools` is what the
   * loop's request header snapshots, the mode's collapse is logged and
   * reconstructable for free. Under a non-native mode this is also the loud
   * misconfiguration gate: no usable code runtime → every assembly rejects
   * before any model request.
   *
   * The `knownNames` universe distinguishes the two ways a tool can be off
   * the wire: a per-scope RESTRICTION is runtime state, so `knownNames` stays
   * pre-restriction and a restricted-away tool in `toolOrder` is a normal
   * absence — while the MODE collapse is deployment config, so under
   * `mode: 'code'` the universe is `[run_code]` and a `toolOrder` naming a
   * native tool is dead configuration that fails every assembly loud. Under
   * `mode: 'both'`, the provider adds the reserved transport to the
   * capability-only known-name universe for `toolOrder` validation.
   */
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    const view = this.view(scope)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    if (this.mode === 'native') {
      return { schemas, knownNames: [...view.knownNames] }
    }
    this.requireCodeRuntime()
    if (this.mode === 'code') {
      return {
        schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
        knownNames: [RUN_CODE_NAME],
      }
    }
    return { schemas, knownNames: [...view.knownNames, RUN_CODE_NAME] }
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
   * Register a tool. The layer is decided by the CALLING context: a plain
   * plugin context registers globally; a scoped context (`agent.ctx`)
   * registers into that scope's layer — visible to that agent alone, disposed
   * with the scope, and shadowing a same-named global tool for that agent.
   * Throws if the SAME layer already has the name (cross-layer name twins are
   * the shadowing feature, not an error; the global-duplicate message names
   * `agent.ctx` as the per-agent alternative), or if a non-native mode reserves
   * the `run_code` name for its presentation transport. The visible schema set
   * flows into prompt assembly automatically. Definitions are trusted typed
   * same-process contributions; JSON materialization happens when the schema or
   * result reaches its model/log boundary. Emits `tools/change` on
   * register/unregister.
   * @param definition - the tool's schema plus its execute (and optional
   *   presentation) functions.
   * @returns the disposer that unregisters the tool. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  register(definition: ToolDefinition): () => void {
    const scope = scopeOf(this.ctx)
    const name = definition.name
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    if (this.codeTransport !== undefined && name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`)
    }
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const layer = scope === undefined ? this.global : this.layerFor(scope)
      if (layer.has(name)) {
        throw new Error(scope === undefined
          ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
          : `tool "${name}" is already registered in this scope`)
      }
      layer.set(name, definition)
      // Yield the rollback BEFORE emitting `tools/change`: a generator effect
      // collects each yielded disposer before the next step runs, so a throwing
      // `tools/change` listener removes the tool instead of leaking it (a leak
      // would wedge the duplicate-name check until restart). The duplicate
      // throw above fires before any mutation — it leaks nothing.
      yield () => {
        layer.delete(name)
        // An emptied scope layer is dropped so a disposed scope leaves no
        // residue keyed by its (dead) key.
        if (scope !== undefined && layer.size === 0) this.scoped.delete(scope)
        this.ctx.emit('tools/change')
      }
      this.ctx.emit('tools/change')
    }.bind(this), 'tools.register()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Cleanup is synchronous because this
    // registration installs only synchronous state and notifications.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Restrict the GLOBAL tool surface for the calling scope. Must be called
   * through a scoped context (`agent.ctx`) — restricting "everyone" is not a
   * thing (throw), and an empty filter (neither `allow` nor `deny`) is a no-op
   * that can only be a bug (throw — the materialized-empty-config trap).
   * Validates every listed name against the CURRENT global end-capability
   * universe and throws on an unknown or scope-local name (fail loud
   * beats a typo silently filtering nothing) — register restrictions after the
   * global tools they mask exist (the agent-creation `setup` window satisfies
   * this). A non-native mode's reserved `run_code` presentation transport is
   * not a filterable capability; naming it explicitly throws, while omitting
   * it from an allow-list cannot remove it. The readonly arrays are compiled to
   * private sets at registration. Resolution still uses the live global registry, so a later
   * global name passes a deny-only filter unless named and fails an allow-list
   * unless named. Multiple restrictions compose by intersection. Scoped
   * registrations are merged after restrictions and therefore remain visible.
   * Disposed with the calling fiber (revocable independently); emits
   * `tools/change`.
   * @param filter - global-surface mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the disposer that lifts this restriction. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if (this.codeTransport !== undefined
      && [...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const list = this.restrictions.get(scope) ?? []
      this.restrictions.set(scope, list)
      list.push(compiled)
      yield () => {
        const index = list.indexOf(compiled)
        /* v8 ignore next 3 -- defensive: the compiled restriction was pushed, so indexOf is guaranteed >= 0 */
        if (index >= 0) list.splice(index, 1)
        if (list.length === 0) this.restrictions.delete(scope)
        this.ctx.emit('tools/change')
      }
      this.ctx.emit('tools/change')
    }.bind(this), 'tools.restrict()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Cleanup is synchronous because this
    // registration installs only synchronous state and notifications.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
    const scope = scopeOf(this.ctx)
    const registration = { guard }
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const layer = scope === undefined ? this.globalGuards : this.guardLayerFor(scope)
      layer.add(registration)
      yield () => {
        layer.delete(registration)
        if (scope !== undefined && layer.size === 0) this.scopedGuards.delete(scope)
      }
    }.bind(this), 'tools.guard()')
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** The (created-on-demand) scoped layer for `scope`. */
  private layerFor(scope: ScopeKey): Map<string, ToolDefinition> {
    let layer = this.scoped.get(scope)
    if (!layer) {
      layer = new Map()
      this.scoped.set(scope, layer)
    }
    return layer
  }

  /** Get or create the guard layer for one agent scope. */
  private guardLayerFor(scope: ScopeKey): Set<ToolGuardRegistration> {
    let layer = this.scopedGuards.get(scope)
    if (layer === undefined) {
      layer = new Set()
      this.scopedGuards.set(scope, layer)
    }
    return layer
  }

  /** First monotonic denial from the global then matching scoped guard layers. */
  private guardReason(exec: ToolExecution): string | undefined {
    for (const { guard } of this.globalGuards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    if (exec.agent !== undefined) {
      for (const { guard } of this.scopedGuards.get(exec.agent) ?? []) {
        const reason = guard(exec)
        if (reason !== undefined) return reason
      }
    }
    return undefined
  }

  /** Whether every restriction registered for `scope` admits the global tool `name` (intersection semantics). */
  private admits(scope: ScopeKey | undefined, name: string): boolean {
    if (scope === undefined) return true
    const filters = this.restrictions.get(scope)
    if (!filters) return true
    return filters.every(filter =>
      (filter.allow === undefined || filter.allow.has(name))
      && (filter.deny === undefined || !filter.deny.has(name)))
  }

  /**
   * Resolve every registry fact one scope needs in one layer traversal. The
   * visible map applies global restrictions, scoped shadowing, and the reserved
   * presentation transport; the other sets retain the pre-restriction facts
   * needed by restriction and prompt-order validation.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    const layer = scope === undefined ? undefined : this.scoped.get(scope)
    const visible = new Map<string, ToolDefinition>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, definition] of this.global) {
      knownNames.add(name)
      restrictableNames.add(name)
      if (this.admits(scope, name)) visible.set(name, definition)
    }
    // Scoped layer second: same-name entries REPLACE (shadow) the global ones,
    // and scope-local registrations are never part of the global filter above.
    for (const [name, definition] of layer ?? []) {
      knownNames.add(name)
      visible.set(name, definition)
    }
    // Presentation infrastructure is resolved last and outside capability
    // filtering. Registration rejects this reserved name, so the insertion is
    // an invariant assertion as well as protection against future layer changes.
    if (this.codeTransport !== undefined) {
      visible.set(RUN_CODE_NAME, this.codeTransport)
    }
    return { visible, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.view(scope).visible.get(name)
  }

  /**
   * The model-facing schemas of everything `scope` can see — exactly the
   * fields (`name`, `description`, `parameters`) this registry contributes to
   * system-prompt assembly before its expert transformation waterfall.
   * Constructed EXPLICITLY rather than by stripping
   * known non-schema members: a `ToolDefinition` also carries `execute` and the
   * optional `presentCall`/`presentResult` UI callbacks, and those (especially
   * the functions) must never leak into a model request. An allowlist can't
   * drift when a new non-schema member is added to the definition; a denylist
   * (rest-destructure) would silently leak it.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
  }

  /** Project one definition onto the model-facing schema fields. */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters } = definition
    return {
      name,
      description,
      parameters: detachParameters ? structuredClone(parameters) : parameters,
    }
  }

  /**
   * Execute one tool call through the `tools/pre-execute` → guards →
   * `tools/execute` (around dispatch) → `tools/post-execute` → `tools/result`
   * pipeline. `pre-execute` is the extensible gate
   * (allow/deny/ask), `tools/execute` wraps core dispatch (a timeout/retry/metrics
   * seam), and `post-execute` is the inspect/transform seam; core dispatch sits
   * as the base `next()` of the `tools/execute` waterfall. The whole thing is
   * wrapped in one outer try/catch so a throwing listener (in any waterfall)
   * becomes an `isError` result instead of failing the turn; the tool body ALSO
   * keeps its own inner try/catch, so a thrown tool becomes an `isError` result
   * that `tools/execute` and `post-execute` listeners can still inspect. If the
   * tool is not registered (or not visible to the calling agent — a
   * restricted-away global is exactly as absent as a nonexistent one), the
   * result is an `isError` carrying a `UNKNOWN_TOOL` structured error. A thrown
   * {@link HarnessError} surfaces its `{ name, code }` on the result. Before
   * the final observe-only notification, the authoritative outcome is
   * materialized as a detached lossless-JSON snapshot; an invalid outcome is
   * normalized to an error.
   * @param exec - the typed same-process call input. The registry assigns its
   *   correlation token before policy begins.
   * @returns the materialized final result after every waterfall; listener and
   *   tool failures resolve as `isError` results rather than rejections.
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    const token = createExecutionToken()
    const callId = exec.callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    const base = {
      token,
      callId,
      name,
      ...agent !== undefined ? { agent } : {},
      ...parent !== undefined ? { parent } : {},
      ...signal !== undefined ? { signal } : {},
    }
    let execution: ToolExecution
    try {
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      execution = {
        ...base,
        arguments: deepFreeze(detached),
      }
    } catch (error: unknown) {
      execution = { ...base, arguments: undefined }
      const result = this.materializeFinalResult(toolErrorResult(callId, error))
      this.notifyResult(execution, result)
      return result
    }
    let result: ToolExecutionResult
    try {
      result = this.materializeFinalResult(await this.executePipeline(execution))
    } catch (error: unknown) {
      // Outer backstop: a throwing pre/post-execute listener, guard, or the
      // waterfall machinery becomes an isError result, never a turn failure.
      result = this.materializeFinalResult(toolErrorResult(execution.callId, error))
    }
    this.notifyResult(execution, result)
    return result
  }

  /** Run the transformable pipeline; {@link execute} owns final normalization and notification. */
  private async executePipeline(exec: ToolExecution): Promise<ToolExecutionResult> {
    // --- Gate: tools/pre-execute. An `ask` resolves through the optional
    // approval seam (or degrades to deny) before the monotonic guards run. The
    // carrier keys dispatch by exec.agent, so an `agent.ctx` listener gates only
    // its own agent's calls (agent-less calls are subject-less).
    const carrier = scopeTarget(this, exec.agent)
    const gate = await this.ctx.waterfall(
      carrier, 'tools/pre-execute', exec,
      () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    const decision = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : gate
    const denialReason = decision.kind === 'allow'
      ? this.guardReason(exec)
      : decision.reason
    if (denialReason !== undefined) {
      // Every non-grant, including a failed/unavailable approval request, takes
      // the same deny path and still reaches post-policy plus result observers.
      const denied: ToolExecutionResult = {
        callId: exec.callId,
        content: [{ type: 'text', text: `Error: ${denialReason}` }],
        isError: true,
      }
      return await this.postExecute(exec, denied)
    }

    // --- Around-dispatch: tools/execute. The base `next` is the dispatch-
    // with-normalization thunk — the tool body's own try/catch turns a throw
    // into an isError result so a wrapper (and post-execute) can inspect it;
    // an unknown tool routes through the same catch. A `tools/execute` listener
    // (e.g. a timeout plugin) wraps this thunk: it may replace `exec.signal`
    // before delegating and inspect the normalized result after. Dispatched with the
    // same carrier as the gate, so an `agent.ctx` wrapper wraps only its own
    // agent's calls. ---
    const result = await this.ctx.waterfall(
      carrier, 'tools/execute', exec,
      async (): Promise<ToolExecutionResult> => {
        try {
          // Resolve through the CALLER's visible view ({@link get}): a scoped
          // tool shadows its global name-twin for that agent, and a
          // restricted-away global tool is exactly as absent as a nonexistent
          // one — same UNKNOWN_TOOL result, no capability leak in the error.
          const tool = this.get(exec.name, exec.agent)
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
    if (result.callId !== exec.callId) {
      throw new TypeError(`tools/execute returned callId "${String(result.callId)}" for authoritative call "${exec.callId}"`)
    }

    return await this.postExecute(exec, result)
  }

  /** Notify final-result observers without giving them a mutation/error channel into the outcome. */
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // The pipeline is over: freeze the remaining mutable signal slot so every
    // observer sees the SAME WeakMap-keyable execution without a mutation race.
    Object.freeze(exec)
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this, exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        callback(exec, result)
      } catch (error: unknown) {
        this.ctx.logger.warn(`tool "${exec.name}" (${exec.callId}): tools/result observer failed: ${errorMessage(error)}`)
      }
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
    const decision = await this.ctx.waterfall(
      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const additionalContext = decision.additionalContext
    if (decision.kind === 'block') {
      return {
        callId: result.callId,
        content: decision.feedback,
        isError: true,
        ...additionalContext ? { additionalContext } : {},
      }
    }
    // Accept: replace content if supplied and preserve the dispatched outcome.
    return {
      ...result,
      ...decision.content ? { content: decision.content } : {},
      ...additionalContext ? { additionalContext } : {},
    }
  }

  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    const detached = snapshotJsonValue(result)
    if (detached === undefined) {
      throw new TypeError('tool result must be losslessly JSON-serializable')
    }
    return deepFreeze(detached)
  }
}

/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
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
