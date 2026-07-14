/**
 * Subagent seam vocabulary: the request/result/capability types a
 * {@link SubagentProvider} consumes and produces. No runtime code — types
 * only, per the package convention.
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StructuredOutputSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These static flags cover features needed before a run exists; runtime
 * capabilities such as steering and resume are optional {@link SubagentRun} methods whose presence
 * is the capability.
 */
export interface SubagentCapabilities {
  /** Honor {@link SubagentStartRequest.outputSchema} (structured final output). */
  readonly outputSchema: boolean
  /** Enforce {@link SubagentStartRequest.maxDepth} (recursion cap). */
  readonly depthLimit: boolean
  /** Enforce {@link SubagentStartRequest.toolFilter} (child tool scoping). */
  readonly toolFilter: boolean
  /** Honor {@link SubagentStartRequest.persona} (a per-child persona). */
  readonly persona: boolean
}

/**
 * What a caller asks for when starting a subagent. The tool layer builds this
 * from the model's `{ description, prompt }` plus its own config; the service
 * validates {@link SubagentCapabilities} against the named provider, then
 * passes it to {@link SubagentProvider.start}.
 */
export interface SubagentStartRequest {
  /** The task/prompt for the child agent (a user message in the child session). */
  readonly prompt: ContentBlock[]
  /**
   * The spawning ("parent") agent — the one whose tool call started this
   * subagent. REQUIRED: in-process backends read `parent.session.header` for
   * the working directory, the `parentSession` lineage to stamp on the child,
   * and the parent's delegation depth. Out-of-process backends (ACP) ignore it.
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
  /** Per-child agent options (model and plugin-defined extension fields). */
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertSupportedOutputSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: StructuredOutputSchema
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
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** The run was cancelled by its request signal or by disposal. */
  aborted: 'aborted'
  /** The child failed (model error, transport error). */
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
  /** Parent-scoped run id. Local runs use the published child session id; remote providers mint an id unique in the parent namespace. */
  readonly id: SessionId
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects only on an infrastructure fault the seam
   * cannot represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release the run's
   * resources (in-process: dispose the owned agent and remove its session;
   * ACP: kill and reap the subprocess). Idempotent.
   */
  dispose(): Promise<void>
  /**
   * OPTIONAL (steering capability): send additional content to the running
   * child between steps. Present only on providers that support live steering.
   */
  sendMessage?(content: ContentBlock[]): void
  /**
   * OPTIONAL (resume capability): send a follow-up task to a settled child,
   * continuing its session, and return a fresh run for the continuation.
   */
  resume?(content: ContentBlock[]): Promise<SubagentRun>
}

/**
 * A subagent backend: one transport for running a child agent (in-process
 * spawn/fork, ACP to another process, …). Implementations register under a
 * unique name via {@link SubagentService.registerProvider}; multiple providers
 * coexist in one context (unlike the single-implementation bash seam). The
 * Providers are trusted same-process implementations; callers treat their
 * descriptors and returned values as borrowed immutable data.
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
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
