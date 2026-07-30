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
 * Public operations express caller intent: `start` returns one ready owned
 * one-shot run, `startContinuable` establishes a durable continuable child, and
 * `followup` delivers later content without exposing whether the child is
 * resident. Continuable children never become a {@link SubagentRun}: the
 * continuation manager holds their `AgentHandle` directly and orders every turn
 * through the child's own inbox, so providers contribute only the detached
 * creation spec and see no handle, turn, or teardown.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from './types.ts'
import { SubagentRunId } from './types.ts'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import SubagentContinuationManager from './continuation.ts'
import type {
  ActivationObserver,
  ActivationState,
  ContinuableStart,
  ContinuableStartSpec,
  SubagentAuthority,
  SubagentFollowupOptions,
} from './continuation.ts'

export * from './out-of-process.ts'
export { SubagentRunId } from './types.ts'
export type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type { SubagentDescriptorData, SubagentDescriptorInput } from './descriptor.ts'
export { seedDescriptorTurn } from './descriptor-seed.ts'
export { SubagentError } from './error.ts'
export { settleRun } from './run-settlement.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  applyChildComposition,
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition } from './child-agent.ts'
export type {
  ActivationObserver,
  ActivationState,
  ContinuableStart,
  ContinuableStartSpec,
  CoordinatorMessageSource,
  SubagentAuthority,
  SubagentFollowupOptions,
} from './continuation.ts'

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
  /** Unique identity shared with the paired terminal event. */
  readonly runId: SubagentRunId
  /** The provider that established the run. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
}

/** Observe-only outcome detail for a settled subagent run. */
export interface SubagentRunEndInfo {
  /** Unique identity shared with the paired start event. */
  readonly runId: SubagentRunId
  /** The provider that ran it. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
  /** The terminal stop reason. */
  readonly stopReason: SubagentResult['stopReason']
  /** The child's final assistant output, absent on infrastructure rejection. */
  readonly lastAssistantMessage?: ContentBlock[]
}

/** Named provider registry with one-shot runs and continuable-child operations. */
export class SubagentService extends Service {
  private providers = new Map<string, SubagentProvider>()
  private continuations: SubagentContinuationManager | undefined

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(childCtx, {
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
      })
      this.continuations = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
  }

  /**
   * Establish one durable continuable child and deliver its initial prompt.
   * Resolves when the child's inbox accepts that prompt, without waiting for the
   * turn to start or for the message to reach the Session log; any earlier
   * failure rejects with no ids and rolls back the child entirely.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and the accepted prompt's message id.
   * @throws when continuation services are unavailable or materialization fails.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    return this.requireContinuations().startContinuable(spec)
  }

  /**
   * Deliver one later message to a continuable child as its next FIFO turn. A
   * resident child's Agent inbox accepts it directly (waking a `waiting`
   * Activation), while an absent one is cold-resumed from its persisted
   * Session. The Agent inbox is the only queue, so parent and user messages
   * share one observable order.
   * @param authority - trusted parent or user authority for this delivery.
   * @param childId - durable child session id.
   * @param content - user-role content to deliver.
   * @param options - durable provenance and caller cancellation, which stops the
   *   operation only before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when continuation services are unavailable, authority is rejected,
   *   or the message was not admitted.
   */
  async followup(
    authority: SubagentAuthority,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().followup(authority, childId, content, options)
  }

  /**
   * Read one durable child's live residency state.
   * @param childId - durable child session id.
   * @returns its Activation state, or `undefined` when no Activation is live.
   * @throws when continuation services are unavailable.
   */
  activationState(childId: SessionId): ActivationState | undefined {
    return this.requireContinuations().activationState(childId)
  }

  /**
   * Close continuable admission synchronously, then dispose every live
   * Activation forest child-first. A host calls this before disposing top-level
   * agents so no descendant outlives the runtime that owns its teardown.
   * @returns once every live Activation released its `AgentHandle`.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainContinuable(): Promise<void> {
    const manager = this.continuations
    // Absent continuation services means nothing was ever materialized.
    if (manager === undefined) return
    await manager.drain()
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
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
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
    const provider = this.expectProvider(name)
    this.assertCapabilities(provider, request)
    assertSubagentMaxDepth(request.maxDepth)
    if (request.outputSchema !== undefined) assertObjectJsonSchema(request.outputSchema)
    return this.observeRun(name, request.parent, await provider.start(request))
  }

  /**
   * Resolve one provider's detached continuable-creation contribution. Method
   * presence on the provider IS the capability, so a provider without it is
   * rejected before the manager reserves any child resources.
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name)
    if (provider.prepareContinuable === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support continuable children `
        + '(no prepareContinuable capability)',
        'UNSUPPORTED_CAPABILITY',
      )
    }
    return provider.prepareContinuable(request)
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the optional Task-backed continuation runtime or fail loud. */
  private requireContinuations(): SubagentContinuationManager {
    if (this.continuations === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.continuations
  }

  /**
   * Emit the start/end lifecycle pair for one continuable Activation's
   * residency epoch. Observers see the same vocabulary as a one-shot run, so a
   * child's start and settlement remain observable without exposing whether the
   * manager materialized, woke, or cold-resumed it. Creation failure before
   * residency reports only the terminal edge.
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent | undefined,
  ): ActivationObserver {
    const identity = { runId: SubagentRunId(randomUUID()), provider, id: childId, local: true }
    let started = false
    let settled = false
    return {
      start: (): void => {
        started = true
        this.emitLifecycle('subagent/start', identity, parent)
      },
      settle: (child: Agent | undefined, failure: unknown): void => {
        // A failure before residency has no start edge to pair, and inventing
        // one would report a lifecycle the child never had.
        if (settled || !started) return
        settled = true
        const output = failure === undefined ? lastAssistantOutput(child) : undefined
        this.emitLifecycle('subagent/end', {
          ...identity,
          stopReason: failure === undefined ? 'completed' : 'error',
          ...output === undefined ? {} : { lastAssistantMessage: output },
        }, parent)
      },
    }
  }

  /** Emit the start/end lifecycle pair for one accepted run and return it. */
  private observeRun(name: string, parent: Agent, run: SubagentRun): SubagentRun {
    const runId = SubagentRunId(randomUUID())
    const lifecycleIdentity = {
      runId,
      provider: name,
      id: run.id,
      local: run.localAgent !== undefined,
    }
    // Attach the terminal observer before dispatching start. Promise reactions
    // still run after this synchronous start emission, preserving start → end.
    void run.result.then(
      (result) => {
        this.emitLifecycle('subagent/end', {
          ...lifecycleIdentity,
          stopReason: result.stopReason,
          lastAssistantMessage: result.output,
        }, parent)
      },
      () => {
        this.emitLifecycle('subagent/end', { ...lifecycleIdentity, stopReason: 'error' }, parent)
      },
    )
    this.emitLifecycle('subagent/start', lifecycleIdentity, parent)
    return run
  }

  /**
   * Emit lifecycle events with per-listener synchronous and asynchronous
   * exception containment. Payloads are borrowed immutable values.
   */
  private emitLifecycle(name: 'subagent/start', info: SubagentRunInfo, parent: Agent | undefined): void
  private emitLifecycle(name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent | undefined): void
  private emitLifecycle(name: 'subagent/provider-removed', info: string): void
  private emitLifecycle(
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent  ,
  ): void {
    // A user-resumed continuable child has no delegating parent to key the
    // carrier by, so its lifecycle reaches unscoped listeners globally.
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

/**
 * The child's last assistant message content, for one Activation's terminal
 * lifecycle edge. Absent when no assistant message reached the log.
 */
function lastAssistantOutput(child: Agent | undefined): ContentBlock[] | undefined {
  if (child === undefined) return undefined
  const message = child.session.events.findLast(
    (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
  )
  return message?.data.message.content
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
