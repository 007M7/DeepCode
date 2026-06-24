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
 * @module @deepseek-ai/dsh-subagent
 */

import { Context, Service } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
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
     * A subagent run started — emitted after the provider is resolved and its
     * capabilities validated, as the child run begins. Paired with
     * {@link Events['subagent/end']}.
     * @mode emit
     */
    'subagent/start'(info: SubagentRunInfo): void
    /**
     * A subagent run settled — emitted when {@link SubagentRun.result}
     * resolves (any stop reason). Paired with {@link Events['subagent/start']}.
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
   * with the calling fiber (HMR-safe).
   */
  registerProvider(provider: SubagentProvider): () => void {
    const dispose = this.ctx.effect(function* (this: SubagentService) {
      if (this.providers.has(provider.name)) {
        throw new SubagentError(`a subagent provider named "${provider.name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(provider.name, provider)
      yield () => {
        this.providers.delete(provider.name)
      }
    }.bind(this), 'subagents.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /** Look up a registered provider by name (`undefined` if absent). */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** The names of all registered providers (insertion order). */
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
    // (the consumer still observes it via `run.result`). Per-listener
    // containment also keeps a thrown `subagent/end` listener from becoming an
    // unhandled rejection on this detached `.then`.
    void run.result.then(
      (result) => { this.emitLifecycle('subagent/end', { provider: name, id: run.id, stopReason: result.stopReason }) },
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
   */
  private emitLifecycle(
    name: 'subagent/start' | 'subagent/end',
    info: SubagentRunInfo | SubagentRunEndInfo,
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
