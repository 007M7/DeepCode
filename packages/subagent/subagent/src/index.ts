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
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { assertSupportedOutputSchema } from '@deepseek-ai/dsh-tools'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentId } from '@deepseek-ai/dsh-agent'
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
     * @param provider - the registry's frozen acceptance snapshot of the provider.
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
     * A subagent run started — emitted only after {@link SubagentRun.started}
     * fulfills, when the provider has established a live child. For an
     * in-process provider, `ctx.agents.get(info.id)` is therefore guaranteed to
     * resolve during this notification. A readiness rejection emits neither
     * lifecycle event; every emitted start is paired with
     * {@link Events['subagent/end']}.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed
     * by the DELEGATING PARENT — a listener registered through the parent's
     * `agent.ctx` observes only its own delegations; a plain plugin listener
     * observes every run.
     * @param info - which provider started which child agent.
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentService>, info: SubagentRunInfo): void
    /**
     * A started subagent run settled — emitted when {@link SubagentRun.result}
     * resolves (any stop reason) or rejects (reported as `error`). Paired with
     * {@link Events['subagent/start']}; a run whose readiness rejected emits
     * neither event.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): the carrier is keyed
     * by the DELEGATING PARENT — a listener registered through the parent's
     * `agent.ctx` observes only its own delegations; a plain plugin listener
     * observes every run.
     * @param info - the run identity plus stop reason and final output.
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentService>, info: SubagentRunEndInfo): void
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
   * (`DUPLICATE_PROVIDER`) if the name is already taken. The registry snapshots
   * the name, static descriptors, and `start` callback identity at acceptance;
   * later caller mutation cannot change lookup, capability validation, consumer
   * wording, dispatch, or HMR cleanup. The callback remains bound to the
   * original provider object, so provider-owned mutable state stays live.
   * Effect-scoped: disposed with the calling fiber (HMR-safe). Emits
   * `subagent/provider-added` after the registration and
   * `subagent/provider-removed` on unregistration, so consumers can mirror
   * provider lifecycle instead of assuming load order.
   * @param provider - the provider; its `name` is the registry key.
   * @returns the disposer that unregisters the provider. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  registerProvider(provider: SubagentProvider): () => Promise<void> | void {
    // Snapshot the accepted registration contract before entering the effect.
    // Cleanup must never re-read caller-owned `provider.name`: an HMR host may
    // mutate or reuse the provider object before its old fiber unloads. Binding
    // preserves the provider method's receiver while making replacement of the
    // public callback field after registration inert.
    const capabilities: SubagentCapabilities = Object.freeze({
      outputSchema: provider.capabilities.outputSchema,
      depthLimit: provider.capabilities.depthLimit,
      toolFilter: provider.capabilities.toolFilter,
      persona: provider.capabilities.persona,
    })
    const snapshot: SubagentProvider = Object.freeze({
      name: provider.name,
      capabilities,
      inheritsParentContext: provider.inheritsParentContext,
      start: provider.start.bind(provider),
    })
    const dispose = this.ctx.effect(function* (this: SubagentService) {
      if (this.providers.has(snapshot.name)) {
        throw new SubagentError(`a subagent provider named "${snapshot.name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(snapshot.name, snapshot)
      // Yield the rollback BEFORE emitting `subagent/provider-added`: a
      // throwing added-listener then unregisters the provider (and announces
      // the removal) instead of leaking it into the registry. The removal
      // announcement itself is contained PER LISTENER ({@link emitLifecycle}):
      // it runs inside this disposer, where a propagating subscriber would
      // disrupt the backend fiber's teardown and starve later mirrors.
      yield () => {
        this.providers.delete(snapshot.name)
        this.emitLifecycle('subagent/provider-removed', snapshot.name)
      }
      this.ctx.emit('subagent/provider-added', snapshot)
    }.bind(this), 'subagents.registerProvider()')
    // The EXACT cordis effect disposer, not a wrapper: a composite (generator)
    // effect that owns a teardown ORDER must be able to yield THIS function —
    // cordis nests a disposer out of the fiber's concurrent sibling list by
    // exact function identity, so a wrapper would silently break the nesting
    // (the agents.register() lesson). Fire-and-forget callers may still
    // discard the (always-resolved) promise.
    return dispose
  }

  /**
   * Look up the registry's frozen provider snapshot by its accepted name
   * (`undefined` if absent).
   * @param name - the provider name accepted at registration.
   * @returns the frozen acceptance snapshot, or undefined when the name is unknown.
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
   * delegates to {@link SubagentProvider.start}, then emits `subagent/start` /
   * `subagent/end` only after the run's readiness boundary fulfills. A provider
   * that fails before establishing a child emits neither event.
   * @param name - the provider to run on.
   * @param request - the child's prompt, capabilities, and options.
   * @returns the live run (its `result` resolves when the child settles).
   */
  start(name: string, request: SubagentStartRequest): SubagentRun {
    // Parent is the lifecycle scope identity accepted at start. Never reread it
    // from the caller-owned request after the provider/result async boundary,
    // or start/end could be dispatched into different agent scopes.
    const parent = request.parent
    const provider = this.providers.get(name)
    if (!provider) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    this.assertCapabilities(provider, request)
    if (request.outputSchema !== undefined) assertSupportedOutputSchema(request.outputSchema)

    // Detach every data field before crossing into a provider. Parent/signal
    // are live identity capabilities and stay exact; the mutable request record
    // and its arrays/objects are never retained, so every backend (including an
    // async out-of-process one) observes the request accepted at start.
    const accepted: SubagentStartRequest = {
      prompt: structuredClone(request.prompt),
      parent,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.agentOptions !== undefined ? { agentOptions: structuredClone(request.agentOptions) } : {},
      ...request.outputSchema !== undefined ? { outputSchema: structuredClone(request.outputSchema) } : {},
      ...request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {},
      ...request.toolFilter !== undefined ? { toolFilter: structuredClone(request.toolFilter) } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
    }
    const run = provider.start(accepted)

    // Observe result settlement IMMEDIATELY, before waiting on readiness. A
    // provider may fail both promises in the same turn; deferring the rejection
    // handler until `started` fulfilled would leave `result` transiently
    // unhandled. The settled event is buffered until start has been announced,
    // preserving start → end order even for an already-settled scripted run.
    let readiness: 'pending' | 'started' | 'failed' = 'pending'
    let pendingEnd: SubagentRunEndInfo | undefined
    const deliverEnd = (info: SubagentRunEndInfo): void => {
      if (readiness === 'started') this.emitLifecycle('subagent/end', info, parent)
      else if (readiness === 'pending') pendingEnd = info
      // A pre-publication readiness failure has no lifecycle pair; result
      // remains observable by the run's consumer, but telemetry must not claim
      // that a child started.
    }
    void run.result.then(
      (result) => {
        // Snapshot before the caller's own `await run.result` continuation. Even
        // when readiness is still pending, buffering the clone rather than the
        // caller-owned result keeps the eventual observe-only event immutable
        // with respect to consumer mutation.
        let lastAssistantMessage: SubagentResult['output'] | undefined
        try {
          lastAssistantMessage = structuredClone(result.output)
        } catch (error: unknown) {
          this.ctx.logger.warn(`subagent: could not clone ${name} output for subagent/end: ${String(error)}`)
        }
        deliverEnd({
          provider: name,
          id: run.id,
          stopReason: result.stopReason,
          ...lastAssistantMessage !== undefined ? { lastAssistantMessage } : {},
        })
      },
      () => { deliverEnd({ provider: name, id: run.id, stopReason: 'error' }) },
    )

    // Readiness is the publication boundary owned by the provider. For
    // in-process runs, fulfillment means the agent registry already contains
    // `run.id`; for ACP it means the remote session exists. Emit start with
    // per-listener containment, then flush an outcome that settled unusually
    // early. A readiness rejection is handled here and deliberately emits no
    // false start/end pair; the result path above remains independently handled.
    void run.started.then(
      () => {
        readiness = 'started'
        this.emitLifecycle('subagent/start', { provider: name, id: run.id }, parent)
        if (pendingEnd !== undefined) {
          const info = pendingEnd
          pendingEnd = undefined
          this.emitLifecycle('subagent/end', info, parent)
        }
      },
      () => {
        readiness = 'failed'
        pendingEnd = undefined
      },
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
  private emitLifecycle(name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  private emitLifecycle(name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  private emitLifecycle(name: 'subagent/provider-removed', info: string): void
  private emitLifecycle(
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void {
    // Run lifecycle events dispatch in the DELEGATING PARENT's scope (a
    // parent-scoped listener observes only its own delegations); the
    // provider-removed registry notification stays unfiltered. The carrier is
    // args[0] of the dispatch call, exactly as cordis' own emit spells it.
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [scopeTarget(this, parent), name, info]
    for (const callback of this.ctx.events.dispatch('emit', dispatchArgs)) {
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

export default SubagentService
