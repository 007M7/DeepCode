/**
 * Tool registry and execution pipeline. Plugins register tools; the registry
 * feeds schemas into the system prompt, and `execute()` dispatches each call
 * through `tools/pre-execute` (the allow/deny gate) → `tools/execute` (an
 * around-dispatch wrapper for timeout/retry/metrics plugins) → `tools/post-execute`
 * (inspect/replace the result, attach context) for sandbox, permission, and hook
 * plugins to gate or transform a call.
 *
 * @module @deepseek-ai/dsh-tools
 */

import { Context, Service } from 'cordis'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
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

export {
  assertSupportedOutputSchema,
  validateStructuredValue,
  OutputSchemaError,
  type StructuredOutputSchema,
  type StructuredSchemaNode,
  type StructuredSchemaType,
  type StructuredScalar,
} from './json-schema.ts'

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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed by
     * `exec.agent` — a listener registered through `agent.ctx` fires only for
     * that agent's calls; a plain plugin listener fires for every call
     * (including agent-less ones, which dispatch subject-less).
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
     * mutate `exec` (e.g. replace `exec.signal` with a per-call deadline) BEFORE
     * `next()` and inspect the result AFTER. (Cordis `next()` ignores any passed
     * arguments and re-invokes downstream with the shared payload, so a wrapper
     * mutates `exec` in place rather than passing a new object to `next()`.)
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
    'tools/post-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
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
 * A per-scope restriction over the GLOBAL tool surface, registered via
 * {@link ToolRegistry.restrict}. `allow` keeps only the listed global tools;
 * `deny` removes the listed ones; both present = allow first, then deny.
 * Restrictions never touch scoped registrations — a tool registered through
 * the same scope is an explicit grant that bypasses them (which is what keeps
 * e.g. a structured-output capture tool alive under an allow-list). Multiple
 * restrictions on one scope compose by intersection: every one must admit.
 */
export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  allow?: string[]
  /** Global tool names removed from visibility. */
  deny?: string[]
}

/**
 * Tool registry (`ctx.tools`): tool plugins register definitions; the agent
 * loop executes calls through the `tools/pre-execute` → `tools/execute` →
 * `tools/post-execute` pipeline. The registry contributes its schemas into the
 * system-prompt assembly.
 *
 * Two registration layers (`@deepseek-ai/dsh-scope`): a registration through a
 * plain plugin context is GLOBAL (visible to every agent); one through a
 * scoped context (`agent.ctx`) is filed in that scope's layer — visible to
 * that agent alone, disposed with the scope, and SHADOWING a global tool of
 * the same name for that agent (most-specific-wins; within one layer a
 * duplicate name still throws). {@link restrict} masks the global layer per
 * scope. One visibility function ({@link visible}) feeds prompt assembly,
 * {@link get}, and {@link execute}, so what the model is shown, what a
 * presenter renders, and what dispatches can never disagree.
 */
export class ToolRegistry extends Service {
  static inject = ['systemPrompt']

  private global = new Map<string, ToolDefinition>()
  private scoped = new Map<ScopeKey, Map<string, ToolDefinition>>()
  /** Snapshot-at-registration restriction filters, per scope (see {@link restrict}). */
  private restrictions = new Map<ScopeKey, ToolRestriction[]>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(context => ({
      schemas: this.schemas(context.scope),
      knownNames: this.knownNames(context.scope),
    }))
  }

  /**
   * Register a tool. The layer is decided by the CALLING context: a plain
   * plugin context registers globally; a scoped context (`agent.ctx`)
   * registers into that scope's layer — visible to that agent alone, disposed
   * with the scope, and shadowing a same-named global tool for that agent.
   * Throws if the SAME layer already has the name (cross-layer name twins are
   * the shadowing feature, not an error; the global-duplicate message names
   * `agent.ctx` as the per-agent alternative). The visible schema set flows
   * into prompt assembly automatically. Disposed with the calling fiber.
   * Emits `tools/change` on register/unregister.
   * @param definition - the tool's schema plus its execute (and optional
   *   presentation) functions.
   * @returns the disposer that unregisters the tool. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  register(definition: ToolDefinition): () => Promise<void> | void {
    const scope = scopeOf(this.ctx)
    const dispose = this.ctx.effect(function* (this: ToolRegistry) {
      const layer = scope === undefined ? this.global : this.layerFor(scope)
      if (layer.has(definition.name)) {
        throw new Error(scope === undefined
          ? `tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
          : `tool "${definition.name}" is already registered in this scope`)
      }
      layer.set(definition.name, definition)
      // Yield the rollback BEFORE emitting `tools/change`: a generator effect
      // collects each yielded disposer before the next step runs, so a throwing
      // `tools/change` listener removes the tool instead of leaking it (a leak
      // would wedge the duplicate-name check until restart). The duplicate
      // throw above fires before any mutation — it leaks nothing.
      yield () => {
        layer.delete(definition.name)
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
    // (the agents.register() lesson). Fire-and-forget callers may still
    // discard the (always-resolved) promise.
    return dispose
  }

  /**
   * Restrict the GLOBAL tool surface for the calling scope. Must be called
   * through a scoped context (`agent.ctx`) — restricting "everyone" is not a
   * thing (throw), and an empty filter (neither `allow` nor `deny`) is a no-op
   * that can only be a bug (throw — the materialized-empty-config trap).
   * Validates every listed name against the scope's CURRENT pre-restriction
   * name universe ({@link knownNames}) and throws on an unknown one (fail loud
   * beats a typo silently filtering nothing) — register restrictions after the
   * global tools they mask exist (the agent-creation `setup` window satisfies
   * this). The filter is SNAPSHOT at registration: later caller mutation of
   * the arrays changes nothing. Multiple restrictions compose by intersection.
   * Scoped registrations bypass restrictions (explicit grants win). Disposed
   * with the calling fiber (revocable independently); emits `tools/change`.
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
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Fire-and-forget callers may still
    // discard the (always-resolved) promise.
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
   * on a name conflict. No scope = the unrestricted global view.
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
    const shadowed = scope === undefined ? undefined : this.scoped.get(scope)?.get(name)
    if (shadowed) return shadowed
    if (!this.admits(scope, name)) return undefined
    return this.global.get(name)
  }

  /**
   * The model-facing schemas of everything `scope` can see — exactly the
   * fields (`name`, `description`, `parameters`) sent to the model via the
   * system-prompt assembly. Constructed EXPLICITLY rather than by stripping
   * known non-schema members: a `ToolDefinition` also carries `execute` and the
   * optional `presentCall`/`presentResult` UI callbacks, and those (especially
   * the functions) must never leak into a model request. An allowlist can't
   * drift when a new non-schema member is added to the definition; a denylist
   * (rest-destructure) would silently leak it.
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
   * The PRE-restriction name universe for `scope`: every global name plus the
   * scope's own layer, ignoring restrictions. This is the set configuration
   * (`toolOrder`, `restrict()` filters) validates against, so a typo fails
   * loud while a restricted-away tool remains a normal, non-erroneous absence.
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
   * Execute one tool call through the `tools/pre-execute` → `tools/execute`
   * (around dispatch) → `tools/post-execute` pipeline. `pre-execute` is the gate
   * (allow/deny), `tools/execute` wraps core dispatch (a timeout/retry/metrics
   * seam), and `post-execute` is the inspect/transform seam; core dispatch sits
   * as the base `next()` of the `tools/execute` waterfall. The whole thing is
   * wrapped in one outer try/catch so a throwing listener (in any waterfall)
   * becomes an `isError` result instead of failing the turn; the tool body ALSO
   * keeps its own inner try/catch, so a thrown tool becomes an `isError` result
   * that `tools/execute` and `post-execute` listeners can still inspect. If the
   * tool is not registered (or not visible to the calling agent — a
   * restricted-away global is exactly as absent as a nonexistent one), the
   * result is an `isError` carrying a `UNKNOWN_TOOL` structured error. A thrown
   * {@link HarnessError} surfaces its `{ name, code }` on the result.
   * @param exec - the call to run (name, parsed arguments, caller agent, signal).
   * @returns the final result after every waterfall; failures resolve as
   *   `isError` results, never rejections.
   */
  async execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    try {
      // --- Gate: tools/pre-execute. A deny (or an ask, which degrades to deny
      // until the permission system lands) skips dispatch entirely. The
      // carrier keys the dispatch by exec.agent, so an `agent.ctx` listener
      // gates only its own agent's calls (agent-less calls are subject-less).
      const carrier = scopeTarget(this, exec.agent)
      const decision = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
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

      // --- Around-dispatch: tools/execute. The base `next` is the dispatch-
      // with-normalization thunk — the tool body's own try/catch turns a throw
      // into an isError result so a wrapper (and post-execute) can inspect it;
      // an unknown tool routes through the same catch. A `tools/execute` listener
      // (e.g. a timeout plugin) wraps this thunk: it may mutate `exec` before
      // delegating and inspect the normalized result after. Dispatched with the
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
      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
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
