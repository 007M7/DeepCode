/**
 * The subagent seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start surface. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
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
 * Scope: the seam stays collection-agnostic — a run is started and its
 * `result` awaited, whether the consumer blocks on it (foreground) or
 * registers it as a `ctx.tasks` background task (the generic runtime owns
 * ids/polling/stop; this seam gains nothing task-shaped). Steering
 * ({@link SubagentRun.sendMessage}) is part of the contract but intentionally
 * unused.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { Context, Service } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertSupportedOutputSchema } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
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

/**
 * Reject a recursion cap that cannot represent an exact delegation depth.
 * @param maxDepth - the optional runtime value to validate.
 */
export function assertSubagentMaxDepth(maxDepth: unknown): void {
  if (maxDepth !== undefined && (
    typeof maxDepth !== 'number'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || Object.is(maxDepth, -0)
  )) {
    throw new TypeError('subagent maxDepth must be a non-negative safe integer')
  }
}

declare module 'cordis' {
  interface Context {
    subagents: SubagentService
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a ready child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the delegating parent, so a
     * parent-scoped listener observes only its own delegations. Paired with
     * `subagent/end`.
     * @param info - the provider and ready child identity.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentService>, info: SubagentRunInfo): void
    /**
     * A ready child settled. Scope-filtered dispatch uses the same delegating
     * parent carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - the run identity and terminal outcome.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentService>, info: SubagentRunEndInfo): void
  }
}

/** Observe-only identifying detail for a ready subagent run. */
export interface SubagentRunInfo {
  /** The provider that established the run. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
}

/** Observe-only outcome detail for a settled subagent run. */
export interface SubagentRunEndInfo {
  /** The provider that ran it. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** The terminal stop reason. */
  readonly stopReason: SubagentResult['stopReason']
  /** The child's final assistant output, absent on infrastructure rejection. */
  readonly lastAssistantMessage?: ContentBlock[]
}

/** Typed error for provider lookup, registration, and capability failures. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}

/** Named provider registry and capability-checked start surface. */
export class SubagentService extends Service {
  private providers = new Map<string, SubagentProvider>()

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: SubagentService) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Establish a ready child on the named provider. Capability and semantic
   * checks run before delegation. Provider ownership lasts until its promise
   * fulfills; a rejection therefore has no run for the caller to dispose and
   * emits no run lifecycle events.
   * @param name - the provider to use.
   * @param request - child prompt, parent, signal, and optional capabilities.
   * @returns the ready holder-owned run.
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    this.assertCapabilities(provider, request)
    assertSubagentMaxDepth(request.maxDepth)
    if (request.outputSchema !== undefined) assertSupportedOutputSchema(request.outputSchema)

    const parent = request.parent
    const run = await provider.start(request)
    // Attach the terminal observer before dispatching start. Promise reactions
    // still run after this synchronous start emission, preserving start → end.
    void run.result.then(
      (result) => {
        this.emitLifecycle('subagent/end', {
          provider: name,
          id: run.id,
          stopReason: result.stopReason,
          lastAssistantMessage: result.output,
        }, parent)
      },
      () => {
        this.emitLifecycle('subagent/end', { provider: name, id: run.id, stopReason: 'error' }, parent)
      },
    )
    this.emitLifecycle('subagent/start', { provider: name, id: run.id }, parent)
    return run
  }

  /**
   * Emit lifecycle events with per-listener synchronous and asynchronous
   * exception containment. Payloads are borrowed immutable values.
   */
  private emitLifecycle(name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  private emitLifecycle(name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  private emitLifecycle(name: 'subagent/provider-removed', info: string): void
  private emitLifecycle(
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [scopeTarget(this, parent), name, info]
    for (const callback of this.ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
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

/** Render any listener-thrown value without letting coercion escape containment. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

export default SubagentService
