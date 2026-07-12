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
import { assertSupportedOutputSchema, OutputSchemaError } from '@deepseek-ai/dsh-tools'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
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

/** Deep-frozen, observe-only identifying detail for a started subagent run. */
export interface SubagentRunInfo {
  /** The provider that started the run. */
  provider: string
  /** The child agent's id. */
  id: AgentId
}

/** Deep-frozen, observe-only outcome detail for a settled subagent run. */
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
   * every fixed field and capability flag is read once and validated before
   * registration, so malformed provider objects fail loud without entering the
   * registry. Later caller mutation cannot change lookup, capability validation,
   * consumer wording, dispatch, or HMR cleanup. The callback remains bound to
   * the original provider object, so provider-owned mutable state stays live.
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
    const name: unknown = provider.name
    const inputCapabilities: unknown = provider.capabilities
    const inheritsParentContext: unknown = provider.inheritsParentContext
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const inputStart: unknown = provider.start
    if (typeof name !== 'string') {
      throw new TypeError('subagent provider name must be a string')
    }
    if (inputCapabilities === null || typeof inputCapabilities !== 'object' || Array.isArray(inputCapabilities)) {
      throw new TypeError(`subagent provider "${name}" capabilities must be an object`)
    }
    const inputCapabilityFields = inputCapabilities as Record<keyof SubagentCapabilities, unknown>
    const outputSchema = inputCapabilityFields.outputSchema
    const depthLimit = inputCapabilityFields.depthLimit
    const toolFilter = inputCapabilityFields.toolFilter
    const persona = inputCapabilityFields.persona
    for (const [capability, value] of [
      ['outputSchema', outputSchema],
      ['depthLimit', depthLimit],
      ['toolFilter', toolFilter],
      ['persona', persona],
    ] as const) {
      if (typeof value !== 'boolean') {
        throw new TypeError(`subagent provider "${name}" capability "${capability}" must be a boolean`)
      }
    }
    if (typeof inheritsParentContext !== 'boolean') {
      throw new TypeError(`subagent provider "${name}" inheritsParentContext must be a boolean`)
    }
    if (typeof inputStart !== 'function') {
      throw new TypeError(`subagent provider "${name}" start must be a function`)
    }
    const capabilities: SubagentCapabilities = Object.freeze({
      outputSchema: outputSchema as boolean,
      depthLimit: depthLimit as boolean,
      toolFilter: toolFilter as boolean,
      persona: persona as boolean,
    })
    const snapshot: SubagentProvider = Object.freeze({
      name,
      capabilities,
      inheritsParentContext,
      start: Function.prototype.bind.call(inputStart, provider) as SubagentProvider['start'],
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
   * `NO_PROVIDER` if absent), reads the caller request once into a coherent
   * acceptance snapshot, validates every requested START-TIME capability
   * against {@link SubagentProvider.capabilities} (throws `UNSUPPORTED_CAPABILITY`
   * for the first unmet one — fail loud, before any child is created), then
   * validates the request's scalar values, materializes model-bound data in one
   * lossless-JSON traversal, and delegates the detached request to
   * {@link SubagentProvider.start}. The returned handle is a service-owned,
   * frozen wrapper: provider fields are captured once, methods stay bound to the
   * provider handle, and `result` resolves to one detached, deeply frozen value
   * shared by the caller and lifecycle telemetry. Once a provider returns a
   * callable disposer, malformed handle access/binding starts rollback before
   * the synchronous fault escapes; malformed terminal data rejects only after
   * that same memoized disposal reaches quiescence. Emits `subagent/start` /
   * `subagent/end` only after the run's readiness boundary fulfills. A provider
   * that fails before establishing a child emits neither event.
   * @param name - the provider to run on.
   * @param request - the child's prompt, capabilities, and options.
   * @returns the live run (its `result` resolves when the child settles).
   */
  start(name: string, request: SubagentStartRequest): SubagentRun {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    // Read every top-level field exactly once before capability checks or
    // detachment. A stateful accessor must not look absent to validation and then
    // appear in the provider request (or vice versa).
    const input = this.snapshotStartRequest(request)
    const parent = input.parent
    this.assertCapabilities(provider, input)
    if (input.maxDepth !== undefined && (
      !Number.isSafeInteger(input.maxDepth)
      || input.maxDepth < 0
      || Object.is(input.maxDepth, -0)
    )) {
      throw new TypeError('subagent maxDepth must be a non-negative safe integer')
    }
    if (input.persona !== undefined && typeof input.persona !== 'string') {
      throw new TypeError('subagent persona must be a string')
    }
    // Model/session-bound values are validated and detached in a single
    // recursive pass. A check followed by structuredClone would reread getters
    // and could erase an exotic prototype returned only to the clone.
    const prompt = snapshotJsonValue(input.prompt)
    if (prompt === undefined) {
      throw new TypeError('subagent prompt must be losslessly JSON-serializable')
    }
    const outputSchema = input.outputSchema === undefined
      ? undefined
      : snapshotJsonValue(input.outputSchema)
    if (input.outputSchema !== undefined && outputSchema === undefined) {
      throw new OutputSchemaError(['schema annotation must be JSON data; the complete schema must be losslessly JSON-serializable'])
    }
    if (outputSchema !== undefined) assertSupportedOutputSchema(outputSchema)
    const agentOptions = input.agentOptions === undefined
      ? undefined
      : snapshotJsonValue(input.agentOptions)
    if (input.agentOptions !== undefined && agentOptions === undefined) {
      throw new TypeError('subagent agent options must be losslessly JSON-serializable')
    }
    const toolFilter = input.toolFilter === undefined
      ? undefined
      : snapshotJsonValue(input.toolFilter)
    if (input.toolFilter !== undefined && toolFilter === undefined) {
      throw new TypeError('subagent tool filter must be losslessly JSON-serializable')
    }

    // Detach every data field before crossing into a provider. Parent/signal
    // are live identity capabilities and stay exact; the mutable request record
    // and its arrays/objects are never retained, so every backend (including an
    // async out-of-process one) observes the request accepted at start.
    const accepted: SubagentStartRequest = {
      prompt,
      parent,
      ...input.signal !== undefined ? { signal: input.signal } : {},
      ...agentOptions !== undefined ? { agentOptions } : {},
      ...outputSchema !== undefined ? { outputSchema } : {},
      ...input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {},
      ...toolFilter !== undefined ? { toolFilter } : {},
      ...input.persona !== undefined ? { persona: input.persona } : {},
    }
    const providerRun: unknown = provider.start(accepted)
    if (providerRun === null || (typeof providerRun !== 'object' && typeof providerRun !== 'function')) {
      throw new TypeError(`subagent provider "${name}" start must return a SubagentRun object`)
    }
    const acceptedRun = providerRun as SubagentRun
    // Acquire the one rollback capability BEFORE touching any other provider-run
    // field. Once start() returned a handle, the service owns an accepted live
    // attempt; a hostile later accessor or bind must not make that attempt
    // unreachable. The wrapper also memoizes provider disposal, so automatic
    // rollback and a racing caller join one quiescence transaction even if a
    // contract-violating provider forgot to make its own method idempotent.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const inputDispose = acceptedRun.dispose
    if (typeof inputDispose !== 'function') {
      throw new TypeError(`subagent provider "${name}" run dispose must be a function`)
    }
    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      if (disposal === undefined) {
        // Claim the shared transaction before invoking provider code: a raw
        // disposer can synchronously reenter this wrapper through a reference
        // retained by its caller, and both calls must join one provider call.
        const claimed = Promise.withResolvers<undefined>()
        disposal = claimed.promise
        try {
          // Invoke through the captured callable without reading its public
          // `bind`/`length`/`name` properties. Disposal is the recovery
          // capability itself; hostile function metadata must not prevent the
          // seam from exercising it when a later handle field is malformed.
          const returned: unknown = Reflect.apply(inputDispose, acceptedRun, [])
          // A raw disposer can reenter the service wrapper and directly return
          // that same shared promise. Awaiting it here would make the promise
          // depend on itself forever; reject the cyclic provider contract loud.
          if (returned === claimed.promise) {
            claimed.reject(new TypeError(`subagent provider "${name}" run dispose returned its own wrapper disposal promise`))
            return disposal
          }
          void Promise.resolve(returned).then(
            () => { claimed.resolve(undefined) },
            (error: unknown) => { claimed.reject(error) },
          )
        } catch (error: unknown) {
          claimed.reject(error instanceof Error
            ? error
            : new Error('subagent provider run dispose threw a non-Error value', { cause: error }))
        }
      }
      return disposal
    }
    // Provider-owned run objects can be accessor-backed too. Capture every
    // public field exactly once, bind methods to the provider's original handle,
    // and expose only this service-owned wrapper. The normalized result promise
    // is also the one lifecycle telemetry observes, so the caller and observers
    // cannot receive different values from stateful accessors.
    try {
      const id = acceptedRun.id
      if (typeof id !== 'string') {
        throw new TypeError(`subagent provider "${name}" run id must be a string`)
      }
      const started = acceptedRun.started
      if (!(started instanceof Promise)) {
        throw new TypeError(`subagent provider "${name}" run started must be a Promise`)
      }
      // Observe each accepted provider promise before reading the next hostile
      // field. A later accessor/validation failure prevents a wrapper from being
      // returned, but must not leave an already-rejected provider promise
      // unhandled while rollback proceeds.
      void started.catch(() => undefined)
      const providerResult = acceptedRun.result
      if (!(providerResult instanceof Promise)) {
        throw new TypeError(`subagent provider "${name}" run result must be a Promise`)
      }
      void providerResult.catch(() => undefined)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const inputCancel = acceptedRun.cancel
      if (typeof inputCancel !== 'function') {
        throw new TypeError(`subagent provider "${name}" run cancel must be a function`)
      }
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const inputSendMessage = acceptedRun.sendMessage
      if (inputSendMessage !== undefined && typeof inputSendMessage !== 'function') {
        throw new TypeError(`subagent provider "${name}" run sendMessage must be a function when provided`)
      }
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const inputResume = acceptedRun.resume
      if (inputResume !== undefined && typeof inputResume !== 'function') {
        throw new TypeError(`subagent provider "${name}" run resume must be a function when provided`)
      }
      const cancel = Function.prototype.bind.call(inputCancel, acceptedRun) as SubagentRun['cancel']
      const sendMessage = inputSendMessage === undefined
        ? undefined
        : Function.prototype.bind.call(inputSendMessage, acceptedRun) as NonNullable<SubagentRun['sendMessage']>
      const resume = inputResume === undefined
        ? undefined
        : Function.prototype.bind.call(inputResume, acceptedRun) as NonNullable<SubagentRun['resume']>
      const result = providerResult.then(async (value) => {
        try {
          return this.snapshotRunResult(value)
        } catch (error: unknown) {
          // A malformed terminal value is an infrastructure contract fault. The
          // result rejects only after the accepted provider attempt has reached
          // quiescence, so a caller cannot lose the only cleanup handle by merely
          // observing the normalization failure.
          await this.rollbackProviderRun(name, dispose)
          throw error
        }
      })
      const run: SubagentRun = Object.freeze({
        id,
        started,
        result,
        cancel,
        dispose,
        ...sendMessage === undefined
          ? {}
          : { sendMessage },
        ...resume === undefined
          ? {}
          : { resume },
      })

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
      void result.then(
        (value) => {
          deliverEnd({
            provider: name,
            id,
            stopReason: value.stopReason,
            lastAssistantMessage: value.output,
          })
        },
        () => { deliverEnd({ provider: name, id, stopReason: 'error' }) },
      )

      // Readiness is the publication boundary owned by the provider. For
      // in-process runs, fulfillment means the agent registry already contains
      // `run.id`; for ACP it means the remote session exists. Emit start with
      // per-listener containment, then flush an outcome that settled unusually
      // early. A readiness rejection is handled here and deliberately emits no
      // false start/end pair; the result path above remains independently handled.
      void started.then(
        () => {
          readiness = 'started'
          this.emitLifecycle('subagent/start', { provider: name, id }, parent)
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
    } catch (error: unknown) {
      // start() has already transferred a live attempt to the seam. Begin
      // rollback synchronously before surfacing the malformed-handle failure;
      // the contained cleanup promise prevents either a resource leak or an
      // unhandled rejection even though this API cannot synchronously await it.
      void this.rollbackProviderRun(name, dispose)
      throw error
    }
  }

  /** Dispose one malformed provider attempt without letting cleanup mask the contract fault. */
  private async rollbackProviderRun(providerName: string, dispose: () => Promise<void>): Promise<void> {
    try {
      await dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`subagent provider "${providerName}" malformed run rollback failed: ${renderThrown(error)}`)
    }
  }

  /** Normalize one provider result into the immutable seam value. */
  private snapshotRunResult(value: SubagentResult): SubagentResult {
    // Capture every provider-owned field once before validation. In particular,
    // lifecycle telemetry must not reread accessors after the caller receives
    // the result and observe a different terminal outcome.
    const output = value.output
    const structured = value.structured
    const stopReason = value.stopReason
    if (!Array.isArray(output)) {
      throw new TypeError('subagent result output must be an array')
    }
    if (typeof stopReason !== 'string') {
      throw new TypeError('subagent result stopReason must be a string')
    }
    const accepted: SubagentResult = {
      output,
      ...structured === undefined ? {} : { structured },
      stopReason,
    }
    const snapshot = snapshotJsonValue(accepted)
    if (snapshot === undefined) {
      throw new TypeError('subagent result must be losslessly JSON-serializable')
    }
    return deepFreeze(snapshot)
  }

  /** Read one coherent caller request into immutable data properties. */
  private snapshotStartRequest(request: SubagentStartRequest): Readonly<SubagentStartRequest> {
    const prompt = request.prompt
    const parent = request.parent
    const signal = request.signal
    const agentOptions = request.agentOptions
    const outputSchema = request.outputSchema
    const maxDepth = request.maxDepth
    const toolFilter = request.toolFilter
    const persona = request.persona
    return Object.freeze({
      prompt,
      parent,
      ...signal !== undefined ? { signal } : {},
      ...agentOptions !== undefined ? { agentOptions } : {},
      ...outputSchema !== undefined ? { outputSchema } : {},
      ...maxDepth !== undefined ? { maxDepth } : {},
      ...toolFilter !== undefined ? { toolFilter } : {},
      ...persona !== undefined ? { persona } : {},
    })
  }

  /**
   * Emit a `subagent/*` lifecycle event with PER-LISTENER containment: dispatch
   * each subscriber individually and log (never propagate) either a synchronous
   * throw or a returned-promise rejection, so one bad subscriber can neither
   * strand the already-live run, surface as an unhandled rejection on the
   * detached settle hook, NOR starve the listeners registered after it. Async
   * listeners remain concurrent fire-and-forget; dispatch does not await or
   * serialize them. A single try/catch around `ctx.emit` would not do the
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
    const acceptedInfo = typeof info === 'string' ? info : deepFreeze(info)
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, acceptedInfo]
      : [scopeTarget(this, parent), name, acceptedInfo]
    for (const callback of this.ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(acceptedInfo)
        // Plain emits remain fire-and-forget and every callback is still invoked
        // synchronously in this loop. Observe a returned promise independently so
        // an async listener rejection is contained without serializing listeners
        // or delaying provider/run lifecycle.
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
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

/** Render an arbitrary thrown value without allowing coercion to throw again. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

export default SubagentService
