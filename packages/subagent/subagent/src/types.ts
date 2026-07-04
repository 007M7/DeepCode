/**
 * Subagent seam vocabulary: the request/result/capability types a
 * {@link SubagentProvider} consumes and produces. No runtime code — types
 * only, per the package convention.
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentId, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SchemaSpec } from '@deepseek-ai/dsh-tools'

/**
 * Which START-TIME features a provider supports. Checked by the service
 * BEFORE delegating to {@link SubagentProvider.start}: a request that needs a
 * capability the chosen provider lacks is rejected with a typed error rather
 * than accepted-then-ignored (the "fail loud, no silent degradation" rule).
 *
 * Start-time features live here (a static descriptor) because they must be
 * checked before a run exists. RUNTIME features (steering, resume) are instead
 * modeled as OPTIONAL METHODS on {@link SubagentRun}: the method's presence IS
 * the capability, and TS narrowing is the discovery mechanism — a consumer
 * cannot call an absent method without narrowing first.
 */
export interface SubagentCapabilities {
  /** Honor {@link SubagentStartRequest.outputSchema} (structured final output). */
  outputSchema: boolean
  /** Enforce {@link SubagentStartRequest.maxDepth} (recursion cap). */
  depthLimit: boolean
  /** Enforce {@link SubagentStartRequest.toolFilter} (child tool scoping). */
  toolFilter: boolean
}

/**
 * What a caller asks for when starting a subagent. The tool layer builds this
 * from the model's `{ description, prompt }` plus its own config; the service
 * validates {@link SubagentCapabilities} against the named provider, then
 * passes it to {@link SubagentProvider.start}.
 */
export interface SubagentStartRequest {
  /** The task/prompt for the child agent (a user message in the child session). */
  prompt: ContentBlock[]
  /**
   * The spawning ("parent") agent — the one whose tool call started this
   * subagent. REQUIRED: in-process backends read `parent.session.header` for
   * the working directory, the `parentSession` lineage to stamp on the child,
   * and the parent's delegation depth. Out-of-process backends (ACP) ignore it.
   */
  parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * A provider that honors it aborts the child when the signal fires; the
   * consumer also bridges it to {@link SubagentRun.cancel} explicitly.
   */
  signal?: AbortSignal
  /** Per-child agent options (model, system prompt). */
  agentOptions?: AgentOptions
  /**
   * Optional structured-output schema. When set AND the provider's
   * {@link SubagentCapabilities.outputSchema} is `true`, the child's final
   * answer is shaped to this schema and surfaced as {@link SubagentResult.structured}.
   * Requesting it against a provider that lacks the capability is rejected at start.
   */
  outputSchema?: SchemaSpec
  /**
   * Optional recursion cap (max delegation depth below this child). Requires
   * {@link SubagentCapabilities.depthLimit}; rejected at start otherwise.
   */
  maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise.
   */
  toolFilter?: { allow?: string[]; deny?: string[] }
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
  /** The run was cancelled (parent signal, explicit `cancel()`, or peer cancel). */
  aborted: 'aborted'
  /** The child failed (model error, transport error). */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
export interface SubagentResult {
  /** The child's final assistant output (the last assistant message's content). */
  output: ContentBlock[]
  /**
   * The structured result, present IFF the request carried an `outputSchema`
   * AND the provider honored it. Shape is validated against the request schema
   * by the provider; `unknown` here because the seam is schema-agnostic.
   */
  structured?: unknown
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  stopReason: SubagentStopReason
}

/**
 * A live subagent run: a handle the consumer holds while a child executes.
 * Returned by {@link SubagentProvider.start} (via the service). The consumer
 * awaits {@link result}, may {@link cancel} mid-flight, and MUST {@link dispose}
 * on every path to reach child quiescence (no leaked idle child / session).
 *
 * {@link sendMessage} and {@link resume} are OPTIONAL: a provider that supports
 * the runtime capability defines the method; one that doesn't omits it. The
 * presence of the method IS the capability — narrow before calling.
 */
export interface SubagentRun {
  /** The child agent's id (use `ctx.agents.get(id)` to reach the live child). */
  readonly id: AgentId
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects only on an infrastructure fault the seam
   * cannot represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /** Request cancellation of the in-flight run; {@link result} settles `aborted`. */
  cancel(reason?: string): void
  /**
   * Reach child quiescence and release the run's resources (in-process: dispose
   * the owned agent handle and remove its session; ACP: kill the subprocess).
   * Idempotent; awaits the child actually stopping, not merely requesting it.
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
  resume?(content: ContentBlock[]): SubagentRun
}

/**
 * A subagent backend: one transport for running a child agent (in-process
 * spawn/fork, ACP to another process, …). Implementations register under a
 * unique name via {@link SubagentService.registerProvider}; multiple providers
 * coexist in one context (unlike the single-implementation bash seam).
 */
export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Start a child run. The service has already validated that every requested
   * start-time capability is supported, so an implementation may assume e.g.
   * `request.maxDepth` is honorable when present.
   */
  start(request: SubagentStartRequest): SubagentRun
}
