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
 * Public operations express caller intent: `start` returns one ready owned run,
 * `startContinuable` starts a Task-backed durable child, and `followup` routes
 * later content without exposing whether the child is live. Provider resume
 * dispatch stays private because only the continuation manager holds the
 * resolved descriptor and authorization facts.
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentProviderResumeRequest,
  SubagentProviderStartRequest,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from './types.ts'
import { SubagentRunId } from './types.ts'
import { SubagentError } from './error.ts'
import SubagentContinuationManager from './continuation.ts'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentFollowupOptions,
  SubagentFollowupResult,
} from './continuation.ts'

export * from './out-of-process.ts'
export { SubagentRunId } from './types.ts'
export type {
  SubagentCapabilities,
  SubagentContinuation,
  SubagentProvider,
  SubagentProviderResumeRequest,
  SubagentProviderStartRequest,
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
export { SubagentError } from './error.ts'
export { settleRun } from './continuation.ts'
export type {
  ContinuableStart,
  ContinuableStartSpec,
  CoordinatorMessageSource,
  SubagentFollowupOptions,
  SubagentFollowupResult,
} from './continuation.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
    subagentDepth?: number
  }
}

/**
 * Read an agent's delegation depth, treating absence as top-level depth zero.
 * The persisted session header is authoritative and monotone: runtime
 * `AgentOptions.subagentDepth` may DEEPEN the count but can never lower it —
 * a resumed child arrives with fresh options, and counting it from zero would
 * let it delegate as if it were top-level.
 * @param agent - the agent whose header and options carry the depth.
 * @returns its non-negative safe-integer depth.
 * @throws if the runtime `AgentOptions.subagentDepth` is not a non-negative safe integer.
 */
export function delegationDepthOf(agent: Agent): number {
  const runtime = agent.options.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  // The header value was validated at the session boundary (creation and
  // persistence load both construct through the store).
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
}

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

/** Named provider registry with raw and Task-backed continuation operations. */
export class SubagentService extends Service {
  private providers = new Map<string, SubagentProvider>()
  private continuations: SubagentContinuationManager | undefined

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    ctx.inject(['tasks', 'agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(
        childCtx,
        (name, request) => this.startProvider(name, request),
        request => this.resumeProvider(request),
      )
      this.continuations = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
  }

  /**
   * Start one durable continuable child through a Task-backed initial
   * activation.
   * @param spec - provider, Task label, and delegation request.
   * @returns the stable child id and initial activation Task id.
   */
  startContinuable(spec: ContinuableStartSpec): ContinuableStart {
    return this.requireContinuations().startContinuable(spec)
  }

  /**
   * Follow up with a continuable child. A live child is steered and fulfillment
   * confirms request admission; an idle child immediately returns a fresh Task
   * whose descriptor lookup, authorization, and cold resume may later fail.
   * @param parent - live direct parent authorizing the operation.
   * @param childId - durable child session id.
   * @param content - user-role content to deliver.
   * @param options - durable attribution and caller cancellation; aborting a
   *   live-delivery wait cancels the shared activation and awaits quiescence.
   * @returns the existing steered Task or newly started Task.
   * @throws when continuation services are unavailable or live delivery is not admitted.
   */
  followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<SubagentFollowupResult> {
    return this.requireContinuations().followup(parent, childId, content, options)
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
  async start(name: string, request: SubagentStartRequest & { readonly continuation?: never }): Promise<SubagentRun> {
    return this.startProvider(name, request)
  }

  /** Validate and dispatch one ordinary or service-resolved provider start. */
  private async startProvider(
    name: string,
    request: SubagentProviderStartRequest,
  ): Promise<SubagentRun> {
    const provider = this.expectProvider(name)
    this.assertCapabilities(provider, request)
    assertSubagentMaxDepth(request.maxDepth)
    if (request.outputSchema !== undefined) assertObjectJsonSchema(request.outputSchema)
    if (request.continuation !== undefined && provider.resume === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support continuable children (no resume capability)`,
        'UNSUPPORTED_CAPABILITY',
      )
    }

    return this.observeRun(name, request.parent, await provider.start(request))
  }

  /** Dispatch one authorized provider resume and observe its run lifecycle. */
  private async resumeProvider(request: SubagentProviderResumeRequest): Promise<SubagentRun> {
    const name = request.descriptor.provider
    const provider = this.expectProvider(name)
    if (provider.resume === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support resuming persisted children (no resume capability)`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
    return this.observeRun(name, request.parent, await provider.resume(request))
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
        'continuable subagents require the tasks and agents services',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.continuations
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
