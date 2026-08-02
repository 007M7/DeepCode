/**
 * Request, result, and capability contracts for {@link SubagentProvider}.
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SubagentDescriptorData } from './descriptor.ts'

/** Identifies one accepted subagent run across its lifecycle event pair. */
export type SubagentRunId = Branded<'SubagentRunId'>

/**
 * Brand a string as a {@link SubagentRunId}.
 * @param id - the raw run id.
 * @returns the same string, branded.
 */
export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}

/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These static flags cover features needed before a run exists; runtime
 * capabilities are optional methods whose presence is the capability — confirmed live steering
 * is {@link SubagentRun.steer} and persisted cold resume is {@link SubagentProvider.resume}. Each
 * flag corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit` to
 * `maxDepth`; the other names match.
 */
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/**
 * What a caller asks for when starting a subagent. The tool layer builds this
 * from the model's `{ description, prompt }` plus its own config; the service
 * validates {@link SubagentCapabilities} against the named provider and
 * resolves a {@link SubagentProviderStartRequest} for dispatch.
 */
export interface SubagentStartRequest {
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before publication, and cancels a published child when it fires
   * afterward.
   */
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}

/**
 * Provider-facing start request after the service resolves optional
 * continuation state. Ordinary callers use {@link SubagentStartRequest}; only
 * the Task-backed continuation path can attach a stable child identity and
 * durable descriptor.
 */
export interface SubagentProviderStartRequest extends SubagentStartRequest {
  /**
   * Continuable-child state resolved by `ctx.subagents` before provider dispatch.
   * The provider MUST publish exactly `sessionId` as the child identity
   * instead of allocating one internally, and MUST append the snapshotted,
   * model-hidden `subagent/descriptor` before the initial prompt is admitted.
   * Requires {@link SubagentProvider.resume} (the
   * continuation capability); the service rejects the request otherwise.
   */
  readonly continuation?: SubagentContinuation | undefined
}

/**
 * The resolved continuable-child identity and durable composition record the
 * service attaches before provider dispatch.
 */
export interface SubagentContinuation {
  /** Service-allocated stable child session id, published verbatim. */
  readonly sessionId: SessionId
  /** Snapshotted descriptor persisted in the child log for cold resume. */
  readonly descriptor: SubagentDescriptorData
}

/**
 * Provider-facing request for reconstructing a persisted continuable child.
 * The continuation manager loads the child log, folds and authorizes its
 * descriptor, then privately dispatches this resolved request to
 * {@link SubagentProvider.resume}. The provider reconstructs the declared
 * composition under the live parent's scope and drives one turn with `prompt`.
 */
export interface SubagentProviderResumeRequest {
  /** The persisted child session id to resume. */
  readonly sessionId: SessionId
  /** The follow-up message that starts the resumed activation's turn. */
  readonly prompt: ContentBlock[]
  /** Attribution retained when the follow-up becomes the resumed turn's user-role message. */
  readonly source: MessageSource
  /**
   * The live parent agent — the direct parent recorded in the persisted child
   * header. In-process backends reconstruct the child under this agent's
   * currently loaded scope.
   */
  readonly parent: Agent
  /**
   * Activation-owned cancellation signal, created before descriptor lookup.
   * Same pre/post-publication contract as {@link SubagentStartRequest.signal}:
   * an abort before publication rejects after rollback quiescence, and an
   * abort afterward cancels the published child turn.
   */
  readonly signal: AbortSignal
  /** The folded durable descriptor whose composition the provider reconstructs. */
  readonly descriptor: SubagentDescriptorData
}

/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

/** The union over {@link SubagentStopReasonMap} — widens automatically as backends merge in variants. */
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
export interface SubagentResult {
  /** The child's final assistant output (the last assistant message's content). */
  readonly output: ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. Shape is validated against the request schema by the
   * provider; `unknown` here because the seam is schema-agnostic.
   */
  readonly structured?: unknown
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}

/**
 * Child handle returned only after readiness. Consumers await {@link result} and must always
 * {@link dispose} to cancel remaining work and reach quiescence. Optional methods are runtime
 * capability discovery; narrow their presence before calling.
 */
export interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. For a continuable activation, a completed result
   * also means the provider confirmed the activation's final state durable.
   * Rejects on an infrastructure fault the seam cannot represent as a stop
   * reason, including a failed required durability checkpoint.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
  /**
   * OPTIONAL (confirmed live-steering capability): submit additional content
   * to the active child and fulfill only after a committed request snapshot
   * admits it. Rejects when terminal policy, cancellation, disposal, or a lost
   * settlement race prevents admission; it never falls through to a queued
   * untracked turn or cold resume. A run represents one disposable activation,
   * so resuming a settled child goes through {@link SubagentProvider.resume}.
   * `source` is retained on the admitted steering message without changing its
   * user role in model history.
   */
  steer?(content: ContentBlock[], source: MessageSource): Promise<void>
}

/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data.
 */
export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Establish a child and return its handle only after publication. The
   * service has already validated that every requested start-time capability
   * is supported, so an implementation may assume e.g. `request.maxDepth` is
   * honorable when present. If setup fails or `request.signal` aborts before
   * fulfillment, the provider owns and cleans all partial resources before this
   * promise rejects. Ownership transfers to the caller only on fulfillment.
   */
  start(request: SubagentProviderStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuation capability): reconstruct a persisted continuable
   * child from its own transcript and declared descriptor, drive one
   * follow-up turn, and return a fresh run. Method presence is the capability
   * — the service rejects continuable starts and cold-resume dispatch on
   * providers without it. Same publication contract as {@link start}: if
   * reconstruction fails or `request.signal` aborts before fulfillment, the
   * provider rolls its creation transaction back to quiescence before
   * rejecting; after fulfillment the same signal cancels the published run.
   */
  resume?(request: SubagentProviderResumeRequest): Promise<SubagentRun>
}
