/**
 * The subagent seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating `start` surface. A subagent is an agent delegating
 * work to another agent; a {@link SubagentProvider} is one transport for
 * running that child (in-process spawn/fork, ACP to another process, and —
 * later — A2A, the Codex app-server, the Claude Code Agent SDK).
 *
 * Unlike the bash seam (one executor per context, second load throws), MULTIPLE
 * providers coexist here: each registers under a unique name and a caller picks
 * one by name. The shape mirrors the LLM adapter registry
 * (`LlmService.registerAdapter`), not the single-service bash executor.
 *
 * This package is the INTERFACE third of the capability seam. Implementations
 * (`@deepseek-ai/dsh-subagent-spawn`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * Scope (first cut): the consumer collects synchronously — it starts a run and
 * awaits {@link SubagentRun.result}. Steering ({@link SubagentRun.sendMessage})
 * is part of the contract but intentionally unused; background / poll / spill
 * semantics are deferred to a future redesign that unifies long-running-tool
 * handling across subagents and bash.
 *
 * The `subagent/start` / `subagent/end` lifecycle events carry an OBSERVE-ONLY
 * payload; `subagent/end` additionally carries the child's `lastAssistantMessage`
 * — see `docs/rfc/implemented/feature/2026-06-30-subagent-observe-enrich.md`.
 * FIXME(subagent-continuation): a control-flow `subagent/end` (an awaited
 * waterfall returning a stop/continue decision, like the other interception
 * seams) would require reshaping this emit into a waterfall, awaiting listeners
 * before settling, and a `resume` capability on the in-process provider — part
 * of the deferred background/steering redesign, NOT this observe-only cut.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { Context, Service } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentId } from '@deepseek-ai/dsh-agent'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from './types.ts'

export type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    subagents: SubagentService
  }

  interface Events {
    /**
     * A provider became resolvable in the {@link SubagentService} registry.
     * Consumers that derive state from a named provider (e.g. the model-facing
     * tool wording in `dsh-tool-subagent`) react HERE instead of assuming load
     * order — the cordis Loader starts sibling plugins concurrently, so
     * "listed earlier in cordis.yml" does not mean "registered earlier".
     * @param provider - the provider that just registered, live in the registry.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry (its plugin's fiber was disposed — an
     * unload or an HMR reload). Consumers holding provider-derived state drop
     * it here; a reload re-fires `subagent/provider-added` with the fresh
     * provider. Delivered with per-listener containment: a throwing
     * subscriber is logged, never starves later subscribers, and never
     * disrupts the provider's teardown.
     * @param name - the registry name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A subagent run started — emitted after the provider is resolved and its
     * capabilities validated, as the child run begins. Paired with
     * {@link Events['subagent/end']}.
     * @param info - which provider started which child agent.
     * @mode emit
     */
    'subagent/start'(info: SubagentRunInfo): void
    /**
     * A subagent run settled — emitted when {@link SubagentRun.result}
     * resolves (any stop reason). Paired with {@link Events['subagent/start']}.
     * @param info - the run identity plus stop reason and final output.
     * @mode emit
     */
    'subagent/end'(info: SubagentRunEndInfo): void
  }
}

/** Identifying detail for a started subagent run (the `subagent/start` payload). */
export interface SubagentRunInfo {
  /** The provider that started the run. */
  provider: string
  /** The child agent's id. */
  id: AgentId
}

/** Outcome detail for a settled subagent run (the `subagent/end` payload). */
export interface SubagentRunEndInfo {
  /** The provider that ran it. */
  provider: string
  /** The child agent's id. */
  id: AgentId
  /** The terminal stop reason. */
  stopReason: SubagentResult['stopReason']
  /**
   * The child's final assistant output ({@link SubagentResult.output}), carried
   * onto the end event so an observer sees WHAT the subagent produced without
   * holding the run. Absent when the run rejected at the infrastructure level
   * (no {@link SubagentResult} was produced — the seam only knows `stopReason:
   * 'error'`).
   */
  lastAssistantMessage?: ContentBlock[]
}

/**
 * Typed error for subagent-seam failures. Extends {@link HarnessError}, so the
 * `code` string (`DUPLICATE_PROVIDER`, `NO_PROVIDER`, `UNSUPPORTED_CAPABILITY`)
 * is shared, machine-routable taxonomy.
 */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}

/**
 * The `subagents` service: a registry of named {@link SubagentProvider}s and a
 * capability-checked {@link start} surface.
 */
export class SubagentService extends Service {
  private providers = new Map<string, SubagentProvider>()

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  /**
   * Register a provider under its `provider.name`. Throws {@link SubagentError}
   * (`DUPLICATE_PROVIDER`) if the name is already taken. Effect-scoped: disposed
   * with the calling fiber (HMR-safe). Emits `subagent/provider-added` after
   * the registration and `subagent/provider-removed` on unregistration, so
   * consumers can mirror provider lifecycle instead of assuming load order.
   * @param provider - the provider; its `name` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const dispose = this.ctx.effect(function* (this: SubagentService) {
      if (this.providers.has(provider.name)) {
        throw new SubagentError(`a subagent provider named "${provider.name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(provider.name, provider)
      // Yield the rollback BEFORE emitting `subagent/provider-added`: a
      // throwing added-listener then unregisters the provider (and announces
      // the removal) instead of leaking it into the registry. The removal
      // announcement itself is contained PER LISTENER ({@link emitLifecycle}):
      // it runs inside this disposer, where a propagating subscriber would
      // disrupt the backend fiber's teardown and starve later mirrors.
      yield () => {
        this.providers.delete(provider.name)
        this.emitLifecycle('subagent/provider-removed', provider.name)
      }
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Look up a registered provider by name (`undefined` if absent).
   * @param name - the provider name as registered.
   * @returns the provider, or undefined when the name is unknown.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * The names of all registered providers (insertion order).
   * @returns the registered provider names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Start a subagent run on the named provider. Resolves the provider (throws
   * `NO_PROVIDER` if absent), validates every requested START-TIME capability
   * against {@link SubagentProvider.capabilities} (throws `UNSUPPORTED_CAPABILITY`
   * for the first unmet one — fail loud, before any child is created), then
   * delegates to {@link SubagentProvider.start} and emits `subagent/start` /
   * `subagent/end` around the run.
   * @param name - the provider to run on.
   * @param request - the child's prompt, capabilities, and options.
   * @returns the live run (its `result` resolves when the child settles).
   */
  start(name: string, request: SubagentStartRequest): SubagentRun {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    this.assertCapabilities(provider, request)

    const run = provider.start(request)
    // Emit `subagent/start` with PER-LISTENER containment (see {@link emitLifecycle}):
    // the run is already live, so neither a throwing subscriber escaping
    // `start()` (the caller would never receive the run to dispose it — a leaked
    // child) NOR one bad subscriber starving the listeners after it is
    // acceptable. `ctx.emit` halts the dispatch on the first throw, so a single
    // surrounding try/catch is not enough — each listener is invoked and
    // contained individually.
    this.emitLifecycle('subagent/start', { provider: name, id: run.id })
    // Emit `subagent/end` when the run settles. The result promise does not
    // reject on a child-level failure (it resolves with stopReason 'error'),
    // so a rejection here is an infrastructure fault — surface its stop reason
    // as 'error' for the telemetry event without swallowing the rejection
    // (the consumer still observes it via `run.result`). On the resolve path the
    // child's final output rides on the event (lastAssistantMessage); on the
    // reject path there is no SubagentResult, so only the stop reason is known.
    // Per-listener containment also keeps a thrown `subagent/end` listener from
    // becoming an unhandled rejection on this detached `.then`.
    void run.result.then(
      (result) => {
        // Deep-clone the output onto the event: this detached `.then` runs BEFORE
        // the caller's own `await run.result` continuation, so handing listeners
        // the SAME array reference the caller consumes would let a mutating
        // `subagent/end` listener corrupt the caller's SubagentResult.output —
        // breaking the observe-only contract. A snapshot makes the event a
        // read-only view, not a shared handle. The clone is wrapped: it runs
        // inside `onFulfilled`, OUTSIDE emitLifecycle's per-listener containment,
        // so an uncloneable value (a future non-serializable content-block type,
        // or a contract-violating result with no `output`) would otherwise become
        // an unhandled rejection on this detached `.then`. On clone failure, log
        // and emit the event WITHOUT lastAssistantMessage rather than dropping the
        // whole `subagent/end`.
        let lastAssistantMessage: SubagentResult['output'] | undefined
        try {
          lastAssistantMessage = structuredClone(result.output)
        } catch (error: unknown) {
          this.ctx.logger.warn(`subagent: could not clone ${name} output for subagent/end: ${String(error)}`)
        }
        this.emitLifecycle('subagent/end', { provider: name, id: run.id, stopReason: result.stopReason, ...lastAssistantMessage !== undefined ? { lastAssistantMessage } : {} })
      },
      () => { this.emitLifecycle('subagent/end', { provider: name, id: run.id, stopReason: 'error' }) },
    )
    return run
  }

  /**
   * Emit a `subagent/*` lifecycle event with PER-LISTENER containment: dispatch
   * each subscriber individually and log (never propagate) a thrown one, so one
   * bad subscriber can neither strand the already-live run, surface as an
   * unhandled rejection on the detached settle hook, NOR starve the listeners
   * registered after it. A single try/catch around `ctx.emit` would not do the
   * last part — cordis `emit` runs listeners in a `.map(cb => cb())` that halts
   * on the first throw — so this resolves the listener callbacks via
   * `ctx.events.dispatch` and contains each call, the same guarantee
   * `BashExecutor.notifyTaskDone` gives its own listener set.
   *
   * `subagent/provider-removed` routes through here too: it fires inside the
   * provider registration's DISPOSER, where a propagating listener would
   * disrupt the backend fiber's teardown (dispose must reach quiescence) and a
   * starved later listener would leave a mirror consumer (`dsh-tool-subagent`)
   * holding a tool for a provider that no longer exists. `subagent/provider-added`
   * deliberately does NOT: it fires at registration time, where a throwing
   * listener unwinds the yielded rollback — the same fail-loud register-time
   * semantics as the system-prompt registries.
   */
  private emitLifecycle(name: 'subagent/start', info: SubagentRunInfo): void
  private emitLifecycle(name: 'subagent/end', info: SubagentRunEndInfo): void
  private emitLifecycle(name: 'subagent/provider-removed', info: string): void
  private emitLifecycle(
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
  ): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, info])) {
      try {
        callback(info)
      } catch (error: unknown) {
        this.ctx.logger.warn(`subagent: ${name} listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Reject a request that needs a start-time capability the provider lacks.
   * Each optional request field maps to one {@link SubagentCapabilities} flag;
   * the first unmet one throws `UNSUPPORTED_CAPABILITY`.
   */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

export default SubagentService
