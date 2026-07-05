/**
 * Workflow seam vocabulary: the request/run/result types a workflow engine
 * consumes and produces, plus the payload shapes of the `workflow/*` events.
 * Types only (plus the id-brand factory), per the package convention.
 *
 * @module @deepseek-ai/dsh-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentId } from '@deepseek-ai/dsh-agent'

/** Identifies one workflow run. */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/** Brand a string as a {@link WorkflowRunId}. */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}

/**
 * One phase declared in a script's `meta.phases` (progress vocabulary only —
 * phases group agents in observers/UIs; they impose no execution structure).
 */
export interface WorkflowPhase {
  /** The phase title; `phase()` calls match against it by exact string. */
  title: string
  /** Optional one-line description of what the phase does. */
  detail?: string
  /** Optional model override this phase is expected to use (informational). */
  model?: string
}

/**
 * The script's `export const meta` block, validated by the engine before the
 * body runs. `name`/`description` are required; the rest is optional
 * annotation. Matches the Claude Code dynamic-workflows script format.
 */
export interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}

/**
 * What a caller asks for when starting a workflow run. `parent` is REQUIRED —
 * every `agent()` the script spawns is attributed to it (cwd, lineage, depth
 * flow through the subagent seam). `args` must be plain host-realm JSON data;
 * the engine exposes it to the script as the `args` global.
 */
export interface WorkflowStartRequest {
  /** The full script text: `export const meta = {...}` + a plain-JS body. */
  script: string
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted (the tool's `exec.signal`). */
  signal?: AbortSignal
}

/**
 * Why a run settled. CLOSED union (engine-owned, consumers may exhaust):
 * `completed` = the script ran to its final `return`; `cancelled` = the run
 * was cancelled (caller `cancel()`/signal); `error` = the script threw, a
 * fatal `WorkflowError` propagated, or the result failed materialization.
 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/**
 * The outcome of one run, resolved by {@link WorkflowRun.result}. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
export interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** How many `agent()` calls the run started (across its whole lifetime). */
  agentsStarted: number
}

/**
 * The handle the consumer holds while a script executes. The consumer awaits
 * `result`, may `cancel` mid-flight, and MUST `dispose` on every path.
 * `result` does NOT reject — a script failure resolves with `stopReason:
 * 'error'` — so the consumer maps a non-`completed` reason to an `isError`
 * result. `dispose()` cancels, then waits a bounded grace for the script to
 * settle before abandoning it (the engine documents the abandonment
 * semantics); it never hangs on a stuck script.
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block (available before the body runs). */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run: children abort, pending hooks reject, the script dies at its next await. */
  cancel(reason?: string): void
  /** Cancel + bounded-grace settle; safe to call on every path (idempotent). */
  dispose(): Promise<void>
}

/** Identifying detail for a run, carried by every `workflow/*` event (a data snapshot, never the live run). */
export interface WorkflowRunInfo {
  /** The run's id. */
  id: WorkflowRunId
  /** The run's validated meta block. */
  meta: WorkflowMeta
}

/** One `agent()` call's identity within a run (the `workflow/agent-start` payload). */
export interface WorkflowAgentInfo {
  /** 1-based sequence number of this `agent()` call within the run. */
  seq: number
  /** The display label (the `label` option, or a prompt snippet). */
  label: string
  /** The phase this agent belongs to (the `phase` option, else the current `phase()` title). */
  phase?: string
  /** The child agent's id on the subagent seam. */
  childId: AgentId
}

/** How one `agent()` call settled: clean result, child failure (script sees `null`), or run cancellation. */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** One `agent()` call's settlement (the `workflow/agent-end` payload). */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  /** How the call settled. */
  outcome: WorkflowAgentOutcome
}

/**
 * A settled run's outcome as event data (the `workflow/end` payload): the
 * {@link WorkflowResult} minus `value` (a listener observing outcomes must not
 * receive a mutable alias of the caller's result value; a consumer that needs
 * the value holds the run and awaits `result`).
 */
export interface WorkflowResultInfo {
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** How many `agent()` calls the run started. */
  agentsStarted: number
}
