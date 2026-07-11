/**
 * Tool registry and execution pipeline. Plugins register tools; the registry feeds schemas
 * into the system prompt, and `execute()` dispatches each call through `tools/pre-execute`
 * (the extensible allow/deny gate) → monotonic registered guards → `tools/execute` (an
 * around-dispatch wrapper for timeout/retry/metrics plugins) → `tools/post-execute`
 * (inspect/replace the result, attach context) → the observe-only `tools/result` notification.
 * Scope-filtered dispatch: keyed to `exec.agent`; agent-less calls reach global listeners.
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
import { isJsonValue } from '@deepseek-ai/dsh-session'
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
     * Waterfall before a tool runs — the gate where sandbox, permission, and hook plugins
     * allow or deny a call (Claude Code's `PreToolUse`).
     *
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Around-dispatch waterfall wrapping the registry's core tool dispatch, between the
     * `tools/pre-execute` gate and the `tools/post-execute` seam.
     *
     * Scope-filtered dispatch: keyed to `exec.agent`; agent-less calls reach global listeners.
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * Waterfall after a tool runs — where hook plugins inspect the result and accept it
     * (optionally REPLACING the model-facing content, and/or attaching `additionalContext` for
     * the next request) or block it with corrective `feedback` (Claude Code's `PostToolUse`).
     *
     * Scope-filtered dispatch: keyed to `exec.agent`; agent-less calls reach global listeners.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * Awaited notification of the authoritative final tool outcome, after the complete
     * pre/execute/post pipeline, final lossless-JSON validation, and outer error
     * normalization.
     *
     * Scope-filtered dispatch: keyed to `exec.agent`; agent-less calls reach global listeners.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode parallel
     */
    'tools/result'(this: Scoped<ToolRegistry>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): Promise<void> | void
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

/** Tokens minted in this module; a cast or JavaScript object cannot forge membership. */
const executionTokens = new WeakSet<object>()

/**
 * Opaque, immutable identity for one trip through the tool pipeline. Nested
 * transports carry the enclosing execution's token instead of its live object,
 * so observe-only result listeners can correlate calls without gaining a
 * mutation path into an outer around-dispatch wrapper.
 */
export interface ToolExecutionToken {
  readonly [toolExecutionTokenBrand]: true
}

/**
 * Caller-supplied description of one tool call. {@link ToolRegistry.execute}
 * snapshots this input into a pipeline-owned {@link ToolExecution}; callers do
 * not choose the execution token.
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
 * One pending tool call inside the registry pipeline. Call identity, the
 * registry-assigned {@link token}, and a lossless-JSON-validated, deep-frozen
 * clone of the parsed arguments are immutable from the first policy listener onward, while an
 * around-dispatch wrapper may set, replace, or remove only `signal`. The
 * registry freezes the complete object before `tools/result` observers run.
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

/** Pre-execution decision: dispatch, deny with a reason, or ask the approval seam. */
// TODO(pre-tool-input-rewrite): design logged argument rewriting before exposing it here.
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** Post-execution decision: accept optional replacement content or block with feedback. */
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
   * The presentation mode. `'native'` (the default) contributes every visible end capability
   * as a native wire function definition.
   */
  mode?: ToolPresentationMode
}

/**
 * A per-scope restriction over the global tool surface, registered via {@link
 * ToolRegistry.restrict}. `allow` keeps only the listed global tools; `deny` removes the
 * listed ones; both present = allow first, then deny.
 */
export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  allow?: string[]
  /** Global tool names removed from visibility. */
  deny?: string[]
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
 * Tool registry (`ctx.tools`): tool plugins register definitions; the agent loop executes
 * calls through the `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` →
 * `tools/result` pipeline.
 */
export class ToolRegistry extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'code', 'both'] as const).default('native'),
  })

  private global = new Map<string, ToolDefinition>()
  private scoped = new Map<ScopeKey, Map<string, ToolDefinition>>()
  /** Snapshot-at-registration restriction filters, per scope (see {@link restrict}). */
  private restrictions = new Map<ScopeKey, ToolRestriction[]>()
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
    // `run_code` is presentation infrastructure, not an end capability.
    this.codeTransport = this.mode === 'native'
      ? undefined
      : deepFreeze(createRunCodeTool(this, () => this.requireCodeRuntime()))
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.mode !== 'native') {
      ctx.systemPrompt.section({
        name: 'tools:sdk',
        order: SDK_SECTION_ORDER,
        // Regenerate the scoped tool SDK on every assembly in stable lexical order.
        text: (context) => {
          this.requireCodeRuntime()
          return renderToolsSdk(this.schemas(context.scope).filter(schema => schema.name !== RUN_CODE_NAME))
        },
      })
      // These are presentation infrastructure, not optional end capabilities.
      ctx.systemPrompt.protect({ sections: ['tools:sdk'], tools: [RUN_CODE_NAME] })
    }
  }

  /**
   * The registry's contribution to the wire tool list, per {@link Config.mode}, as one SCOPE
   * sees it (scoped layer joins, shadowing and restrictions applied — {@link schemas}).
   */
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    if (this.mode === 'native') return { schemas: this.schemas(scope), knownNames: this.knownNames(scope) }
    this.requireCodeRuntime()
    const all = this.schemas(scope)
    if (this.mode === 'code') {
      return { schemas: all.filter(schema => schema.name === RUN_CODE_NAME), knownNames: [RUN_CODE_NAME] }
    }
    return { schemas: all, knownNames: [...this.knownNames(scope), RUN_CODE_NAME] }
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
   * Register a tool.
   *
   * @param definition - the tool's schema plus its execute (and optional
   *   presentation) functions.
   * @returns the disposer that unregisters the tool. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  register(definition: ToolDefinition): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    // A schema crosses the same model/log boundary as execution arguments.
    if (!isJsonValue(definition.parameters)) {
      throw new TypeError('tool parameters must be losslessly JSON-serializable')
    }
    const parameters = structuredClone(definition.parameters)
    if (!isJsonValue(parameters)) {
      throw new TypeError('tool parameters must be stable losslessly JSON-serializable data')
    }
    // Bind once so replacing a callback on the caller-owned definition after
    // registration cannot change dispatch, while preserving the historical
    // method receiver (`this === definition`) for callbacks that use it.
    const execute = definition.execute.bind(definition)
    const presentCall = definition.presentCall?.bind(definition)
    const presentResult = definition.presentResult?.bind(definition)
    const snapshot: ToolDefinition = deepFreeze({
      name: definition.name,
      description: definition.description,
      parameters,
      execute,
      ...definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {},
      ...presentCall !== undefined ? { presentCall } : {},
      ...presentResult !== undefined ? { presentResult } : {},
    })
    if (this.codeTransport !== undefined && snapshot.name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`)
    }
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const layer = scope === undefined ? this.global : this.layerFor(scope)
      if (layer.has(snapshot.name)) {
        throw new Error(scope === undefined
          ? `tool "${snapshot.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
          : `tool "${snapshot.name}" is already registered in this scope`)
      }
      layer.set(snapshot.name, snapshot)
      // Yield the rollback before emitting `tools/change`: a generator effect collects each
      // yielded disposer before the next step runs, so a throwing `tools/change` listener
      // removes the tool instead of leaking it (a leak would wedge the duplicate-name check
      // until restart).
      yield () => {
        layer.delete(snapshot.name)
        // An emptied scope layer is dropped so a disposed scope leaves no
        // residue keyed by its (dead) key.
        if (scope !== undefined && layer.size === 0) this.scoped.delete(scope)
        this.ctx.emit('tools/change')
      }
      this.ctx.emit('tools/change')
    }.bind(this), 'tools.register()')
    // Return the exact Cordis disposer so generator effects preserve teardown nesting.
    return dispose
  }

  /**
   * Restrict the global tool surface for the calling scope.
   *
   * @param filter - global-surface mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the disposer that lifts this restriction. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  restrict(filter: ToolRestriction): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    if (filter.allow === undefined && filter.deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    // Snapshot BEFORE validation so what was checked is what is enforced.
    const snapshot: ToolRestriction = {
      ...filter.allow !== undefined ? { allow: [...filter.allow] } : {},
      ...filter.deny !== undefined ? { deny: [...filter.deny] } : {},
    }
    if (this.codeTransport !== undefined
      && [...snapshot.allow ?? [], ...snapshot.deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = new Set(this.knownNames(scope))
    const unknown = [...snapshot.allow ?? [], ...snapshot.deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known tools for this scope: ${[...known].sort().join(', ') || '(none)'}`)
    }
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const list = this.restrictions.get(scope) ?? []
      this.restrictions.set(scope, list)
      list.push(snapshot)
      yield () => {
        const index = list.indexOf(snapshot)
        /* v8 ignore next 3 -- defensive: the snapshot was pushed, so indexOf is guaranteed >= 0 */
        if (index >= 0) list.splice(index, 1)
        if (list.length === 0) this.restrictions.delete(scope)
        this.ctx.emit('tools/change')
      }
      this.ctx.emit('tools/change')
    }.bind(this), 'tools.restrict()')
    // Return the exact Cordis disposer so generator effects preserve teardown nesting.
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
  guard(guard: ToolGuard): () => Promise<void> | void {
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
    // Guards are policy, not another transform seam. The pipeline execution's
    // identity and arguments are already protected; freeze a detached view so
    // an untyped guard cannot replace the wrapper-mutable signal either.
    const view: Readonly<ToolExecution> = Object.freeze({ ...exec })
    for (const { guard } of this.globalGuards) {
      const reason = guard(view)
      if (reason !== undefined) return this.assertGuardReason(reason)
    }
    if (exec.agent !== undefined) {
      for (const { guard } of this.scopedGuards.get(exec.agent) ?? []) {
        const reason = guard(view)
        if (reason !== undefined) return this.assertGuardReason(reason)
      }
    }
    return undefined
  }

  /** Runtime boundary for JavaScript/casted guards: only strings can deny. */
  private assertGuardReason(reason: unknown): string {
    if (typeof reason !== 'string') {
      throw new TypeError(`tools.guard() must return a denial string or undefined, got ${typeof reason}`)
    }
    return reason
  }

  /** Whether every restriction registered for `scope` admits the global tool `name` (intersection semantics). */
  private admits(scope: ScopeKey | undefined, name: string): boolean {
    if (scope === undefined) return true
    const filters = this.restrictions.get(scope)
    if (!filters) return true
    return filters.every(filter =>
      (filter.allow === undefined || filter.allow.includes(name))
      && (filter.deny === undefined || !filter.deny.includes(name)))
  }

  /**
   * THE visibility function — one resolution feeding prompt assembly,
   * {@link get}, and {@link execute}: the global layer masked by the scope's
   * restrictions, unioned with the scope's own layer, scoped shadowing global
   * on a name conflict, then the non-native mode's reserved `run_code`
   * presentation transport. No scope = the unrestricted global view.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the visible definitions (scoped shadows applied), in per-layer
   *   registration order, global layer first.
   */
  visible(scope?: ScopeKey): ToolDefinition[] {
    const layer = scope === undefined ? undefined : this.scoped.get(scope)
    const result = new Map<string, ToolDefinition>()
    for (const [name, definition] of this.global) {
      if (this.admits(scope, name)) result.set(name, definition)
    }
    // Scoped layer second: same-name entries REPLACE (shadow) the global ones,
    // and grants bypass restrictions by construction (never filtered above).
    for (const [name, definition] of layer ?? []) result.set(name, definition)
    // Presentation infrastructure is resolved last and outside capability
    // filtering. Registration rejects this reserved name, so this set is an
    // invariant assertion as well as protection against future layer changes.
    if (this.codeTransport !== undefined) result.set(RUN_CODE_NAME, this.codeTransport)
    return [...result.values()]
  }

  /**
   * Look up a tool as one scope sees it ({@link visible} semantics: scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    if (name === RUN_CODE_NAME && this.codeTransport !== undefined) return this.codeTransport
    const shadowed = scope === undefined ? undefined : this.scoped.get(scope)?.get(name)
    if (shadowed) return shadowed
    if (!this.admits(scope, name)) return undefined
    return this.global.get(name)
  }

  /**
   * The model-facing schemas of everything `scope` can see — exactly the fields (`name`,
   * `description`, `parameters`) sent to the model via the system-prompt assembly.
   *
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return this.visible(scope).map(({ name, description, parameters }): ToolSchema => ({
      name,
      description,
      parameters: structuredClone(parameters),
    }))
  }

  /**
   * The PRE-restriction END-CAPABILITY name universe for `scope`: every global
   * name plus the scope's own layer, ignoring restrictions. This is the set
   * `restrict()` validates against, so a typo fails loud while a
   * restricted-away tool remains a normal, non-erroneous absence. Reserved
   * presentation transports are deliberately absent: `restrict()` rejects
   * naming one, while {@link wireSchemas} adds it to the separate `toolOrder`
   * validation universe when its presentation mode contributes it.
   * @param scope - the viewing scope (the agent); omitted = global names only.
   * @returns the known names, deduplicated.
   */
  knownNames(scope?: ScopeKey): string[] {
    const names = new Set(this.global.keys())
    if (scope !== undefined) {
      for (const name of this.scoped.get(scope)?.keys() ?? []) names.add(name)
    }
    return [...names]
  }

  /**
   * Execute one tool call through the `tools/pre-execute` → guards → `tools/execute` (around
   * dispatch) → `tools/post-execute` → `tools/result` pipeline. `pre-execute` is the
   * extensible gate (allow/deny/ask), `tools/execute` wraps core dispatch (a
   * timeout/retry/metrics seam), and `post-execute` is the inspect/transform seam; core
   * dispatch sits as the base `next()` of the `tools/execute` waterfall.
   *
   * @param exec - the single-use call input; its identity is snapshotted and
   *   protected before policy runs.
   * @returns the final result after every waterfall; failures resolve as
   *   `isError` results, never rejections.
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    let execution: ToolExecution
    try {
      execution = this.prepareExecution(exec)
    } catch (error: unknown) {
      // Contract-violating non-JSON or non-cloneable arguments cannot enter a pipeline whose
      // logged and executed forms must agree.
      execution = Object.freeze({
        token: createExecutionToken(),
        callId: exec.callId,
        name: exec.name,
        arguments: undefined,
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        ...isExecutionToken(exec.parent) ? { parent: exec.parent } : {},
        ...exec.signal !== undefined ? { signal: exec.signal } : {},
      })
      const result = toolErrorResult(execution.callId, error)
      await this.notifyResult(execution, result)
      return result
    }
    let result: ToolExecutionResult
    try {
      // Validate the authoritative final result, not merely the tool body's intermediate
      // return.
      result = this.snapshotExecutionResult(execution, await this.executePipeline(execution))
    } catch (error: unknown) {
      // Outer backstop: a throwing pre/post-execute listener, guard, or the
      // waterfall machinery becomes an isError result, never a turn failure.
      result = toolErrorResult(execution.callId, error)
    }
    await this.notifyResult(execution, result)
    return result
  }

  /** Snapshot one call into a shared pipeline object with immutable identity and mutable cancellation. */
  private prepareExecution(input: ToolExecutionInput): ToolExecution {
    if (input.parent !== undefined && !isExecutionToken(input.parent)) {
      throw new TypeError('tool execution parent must be a registry-minted opaque token')
    }
    if (!isJsonValue(input.arguments)) {
      throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
    }
    const args = structuredClone(input.arguments)
    if (!isJsonValue(args)) {
      throw new TypeError('tool execution arguments must be stable losslessly JSON-serializable data')
    }
    const execution: ToolExecution = {
      token: createExecutionToken(),
      callId: input.callId,
      name: input.name,
      arguments: deepFreeze(args),
      ...input.agent !== undefined ? { agent: input.agent } : {},
      ...input.parent !== undefined ? { parent: input.parent } : {},
      ...input.signal !== undefined ? { signal: input.signal } : {},
    }
    Object.defineProperties(execution, {
      token: { value: execution.token, enumerable: true, writable: false, configurable: false },
      callId: { value: execution.callId, enumerable: true, writable: false, configurable: false },
      name: { value: execution.name, enumerable: true, writable: false, configurable: false },
      arguments: { value: execution.arguments, enumerable: true, writable: false, configurable: false },
      agent: { value: input.agent, enumerable: true, writable: false, configurable: false },
      parent: { value: input.parent, enumerable: true, writable: false, configurable: false },
    })
    if (input.signal !== undefined) {
      Object.defineProperty(execution, 'signal', {
        value: input.signal,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return execution
  }

  /** Run the transformable pipeline; {@link execute} owns final normalization and notification. */
  private async executePipeline(exec: ToolExecution): Promise<ToolExecutionResult> {
    // --- Gate: tools/pre-execute.
    const carrier = scopeTarget(this, exec.agent)
    const gate = this.snapshotPreDecision(await this.ctx.waterfall(
      carrier, 'tools/pre-execute', exec,
      () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    ))
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

    // --- Around-dispatch: tools/execute.
    const result = this.snapshotExecutionResult(exec, await this.ctx.waterfall(
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
    ))

    return await this.postExecute(exec, result)
  }

  /** Validate and detach the extensible gate's decision before any grant can dispatch. */
  private snapshotPreDecision(value: unknown): PreToolDecision {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('tools/pre-execute must return a PreToolDecision object')
    }
    const decision = value as { kind?: unknown; reason?: unknown }
    const keys = Reflect.ownKeys(decision)
    const hasExactKeys = (...expected: string[]): boolean =>
      keys.length === expected.length && expected.every(key => Object.hasOwn(decision, key))
    switch (decision.kind) {
      case 'allow':
        if (!hasExactKeys('kind')) {
          throw new TypeError('tools/pre-execute allow decision must contain only kind')
        }
        return { kind: 'allow' }
      case 'deny': {
        const reason = decision.reason
        if (!hasExactKeys('kind', 'reason') || typeof reason !== 'string') {
          throw new TypeError('tools/pre-execute deny decision must contain only kind and a string reason')
        }
        return { kind: 'deny', reason }
      }
      case 'ask': {
        const reason = decision.reason
        if (!(hasExactKeys('kind') || hasExactKeys('kind', 'reason'))
          || (reason !== undefined && typeof reason !== 'string')) {
          throw new TypeError('tools/pre-execute ask decision must contain only kind and an optional string reason')
        }
        return { kind: 'ask', ...reason !== undefined ? { reason } : {} }
      }
      default:
        throw new TypeError('tools/pre-execute must return an allow, deny, or ask decision')
    }
  }

  /** Notify final-result observers without giving them a mutation/error channel into the outcome. */
  private async notifyResult(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    // The pipeline is over: freeze the remaining mutable signal slot so every
    // observer sees the SAME WeakMap-keyable execution without a mutation race.
    Object.freeze(exec)
    // postExecute clones every accepted result/decision before rebuilding the
    // outcome; all error paths construct plain data. The final result is thus
    // structurally cloneable before it reaches this observe-only boundary.
    const snapshot = deepFreeze(structuredClone(result))
    const callbacks = this.ctx.events.dispatch('parallel', [
      scopeTarget(this, exec.agent), 'tools/result', exec, snapshot,
    ])
    await Promise.all(callbacks.map(async (callback) => {
      try {
        await callback(exec, snapshot)
      } catch (error: unknown) {
        this.ctx.logger.warn(`tool "${exec.name}" (${exec.callId}): tools/result observer failed: ${errorMessage(error)}`)
      }
    }))
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam.
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
    // Snapshot the protected outcome before the waterfall.
    const dispatched = this.snapshotExecutionResult(exec, result)
    const decision = structuredClone(await this.ctx.waterfall(
      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    ))
    this.assertPostDecision(decision)
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

  /** Validate and detach an around-dispatch result before policy can observe or mutate it. */
  private snapshotExecutionResult(exec: ToolExecution, value: unknown): ToolExecutionResult {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('tools/execute must return a ToolExecutionResult object')
    }
    const result = value as Partial<ToolExecutionResult>
    if (!Array.isArray(result.content) || typeof result.isError !== 'boolean') {
      throw new TypeError('tools/execute must return a ToolExecutionResult with content[] and boolean isError')
    }
    if (result.callId !== exec.callId) {
      throw new TypeError(`tools/execute returned callId "${String(result.callId)}" for authoritative call "${exec.callId}"`)
    }
    const candidate = {
      callId: exec.callId,
      content: result.content,
      isError: result.isError,
      ...result.error !== undefined ? { error: result.error } : {},
      ...result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {},
      ...result.meta !== undefined ? { meta: result.meta } : {},
    }
    // Validate before cloning: structuredClone turns some forbidden exotic or class instances
    // into plain objects, which would hide a lossy JSON boundary violation.
    if (!isJsonValue(candidate)) {
      throw new TypeError('tools/execute must return a losslessly JSON-serializable ToolExecutionResult')
    }
    const snapshot = structuredClone(candidate)
    if (!isJsonValue(snapshot)) {
      throw new TypeError('tools/execute must return a stable losslessly JSON-serializable ToolExecutionResult')
    }
    return snapshot
  }

  /** Reject malformed JavaScript/casted post decisions at the public event boundary. */
  private assertPostDecision(value: unknown): asserts value is PostToolDecision {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('tools/post-execute must return a PostToolDecision object')
    }
    const decision = value as Partial<PostToolDecision>
    switch (decision.kind) {
      case 'accept':
        if (decision.content !== undefined && !Array.isArray(decision.content)) {
          throw new TypeError('tools/post-execute accept content must be an array')
        }
        return
      case 'block':
        if (!Array.isArray(decision.feedback)) {
          throw new TypeError('tools/post-execute block feedback must be an array')
        }
        return
      default:
        throw new TypeError('tools/post-execute must return an accept or block decision')
    }
  }
}

/** Mint a frozen, property-free correlation token whose identity is its value. */
function createExecutionToken(): ToolExecutionToken {
  const token = Object.freeze(Object.create(null)) as ToolExecutionToken
  executionTokens.add(token)
  return token
}

/** Runtime counterpart of the opaque token type, including `undefined` input. */
function isExecutionToken(value: unknown): value is ToolExecutionToken {
  return typeof value === 'object' && value !== null && executionTokens.has(value)
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
