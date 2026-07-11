/**
 * The workflow capability seam (`ctx.workflows`): an abstract service defining
 * WHAT a workflow engine does — execute a model-written orchestration script
 * that fans out subagents — without saying HOW. Implementations subclass
 * {@link WorkflowService} and register as the `workflows` service (one
 * implementation per context, cordis' standard duplicate-service behavior);
 * the implementation is `@deepseek-ai/dsh-workflow-workerthread`, which runs each
 * script in its own worker thread. Hardened engines (an isolated-vm or
 * separate-process sandbox) swap in without touching the model-facing tool
 * that consumes them (`@deepseek-ai/dsh-tool-workflow`).
 *
 * The `workflow/*` lifecycle events are OBSERVE-ONLY data snapshots: they
 * carry {@link WorkflowRunInfo} (id + meta), never the live {@link WorkflowRun}
 * — a listener must not gain `cancel`/`dispose`; control stays with the
 * `start()` caller holding the run. Every emit is per-listener contained (a
 * throwing subscriber is logged, never propagated) and every listener gets its
 * own payload clone (mutating it corrupts nothing), so one bad observer can
 * neither strand a live run, starve later listeners, nor poison another
 * listener's view.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import { Context, Service } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
} from './types.ts'

export { WorkflowRunId } from './types.ts'
export type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowAgentOutcome,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowResultInfo,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
  WorkflowStopReason,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    workflows: WorkflowService
  }

  interface Events {
    /**
     * A workflow run started — the script's meta block validated, the body
     * about to execute. Paired with {@link Events['workflow/end']}.
     * @param info - the run's identity snapshot (id + meta).
     * @mode emit
     */
    'workflow/start'(info: WorkflowRunInfo): void
    /**
     * The script entered a phase (a `phase(title)` call) — progress grouping
     * for observers; no execution semantics.
     * @param info - the run's identity snapshot.
     * @param title - the phase title, verbatim.
     * @mode emit
     */
    'workflow/phase'(info: WorkflowRunInfo, title: string): void
    /**
     * The script emitted a narration line (a `log(message)` call).
     * @param info - the run's identity snapshot.
     * @param message - the logged message, verbatim.
     * @mode emit
     */
    'workflow/log'(info: WorkflowRunInfo, message: string): void
    /**
     * One `agent()` call started a child run. Paired with
     * {@link Events['workflow/agent-end']} by `agent.seq`.
     * @param info - the run's identity snapshot.
     * @param agent - the call's sequence number, label, phase, and child id.
     * @mode emit
     */
    'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
    /**
     * One `agent()` call settled (clean result, child failure, or run
     * cancellation). Paired with {@link Events['workflow/agent-start']} by
     * `agent.seq`, exactly once per started call on every stop path — on an
     * engine termination path (a worker killed past its grace) the end is
     * engine-synthesized with outcome `'cancelled'`.
     * @param info - the run's identity snapshot.
     * @param agent - the call identity plus its outcome.
     * @mode emit
     */
    'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
    /**
     * A workflow run settled (any stop reason). Fired when
     * {@link WorkflowRun.result} resolves. Paired with
     * {@link Events['workflow/start']}.
     * @param info - the run's identity snapshot.
     * @param result - the outcome data (stop reason, error, agent count) —
     *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
     * @mode emit
     */
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
  }
}

/** The full set of `workflow/*` event names {@link WorkflowService.emitWorkflowEvent} dispatches. */
export type WorkflowEventName =
  | 'workflow/start'
  | 'workflow/phase'
  | 'workflow/log'
  | 'workflow/agent-start'
  | 'workflow/agent-end'
  | 'workflow/end'

/**
 * The workflow-seam error codes. Every one of these is FATAL when it reaches
 * a script (see {@link WorkflowError.fatal}): the combinators re-throw it
 * instead of dissolving it into an ordinary per-item `null`.
 *
 * - `SCRIPT_PARSE` — the script (or its meta statement) does not parse.
 * - `META_INVALID` — the meta block evaluated but fails the shape contract.
 * - `INVALID_ARGUMENT` — a hook was called with malformed arguments.
 * - `UNSUPPORTED_OPTION` — an `agent()` option this engine does not support
 *   (deferred: `effort`/`isolation`/`agentType`) or does not know.
 * - `UNSUPPORTED_SCHEMA` — an `agent()` schema outside the structured-output
 *   subset (see dsh-tools).
 * - `AGENT_CAP` / `ITEM_CAP` — the run/agent caps tripped.
 * - `AGENT_START` — the subagent seam refused to start a child.
 * - `AGENT_RESULT` — a child's `result` REJECTED: an infrastructure fault at
 *   the subagent seam, distinct from a child that failed and resolved (which
 *   is the per-item `null`, never an error).
 * - `RESULT_UNSERIALIZABLE` — a value crossing the script/host value boundary
 *   is not plain JSON data.
 * - `CANCELLED` — the run was cancelled; pending and future hooks reject
 *   with this (the script-kill mechanism).
 */
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'AGENT_CAP'
  | 'ITEM_CAP'
  | 'AGENT_START'
  | 'AGENT_RESULT'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED'

/**
 * Typed error for workflow-seam failures. Extends {@link HarnessError}, so the
 * `code` is machine-routable taxonomy. `fatal` drives the combinator
 * discipline: `parallel()`/`pipeline()` re-throw a fatal error (a typo'd
 * option or a tripped cap must kill the script loudly), and reserve the
 * per-item `null` for child-run failures and ordinary in-stage script errors.
 * Every {@link WorkflowErrorCode} is fatal in this cut; the flag exists so the
 * distinction is explicit at every catch site rather than implied.
 */
export class WorkflowError extends HarnessError {
  /** Whether combinators must propagate this error instead of nulling the item. */
  readonly fatal: boolean

  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true
  }
}

/**
 * Whether combinators must re-throw `error` instead of mapping the item to `null`.
 * @param error - any thrown value; fatality is host `instanceof` (unforgeable from a script realm).
 * @returns true iff `error` is a {@link WorkflowError} whose `fatal` flag is set.
 */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}

/**
 * Abstract workflow execution service. Subclass, implement {@link start}, and
 * load the subclass as a plugin — it registers as `ctx.workflows` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link start} throws synchronously for a request that cannot begin (an
 *   unparseable script, an invalid meta block). Once it returns a
 *   {@link WorkflowRun}, `result` NEVER rejects — every failure resolves with
 *   `stopReason: 'error'` (or `'cancelled'`) — and once the run is cancelled,
 *   `result` SETTLES within the implementation's bounded grace even if the
 *   script itself never settles (a consumer awaiting `result` must never be
 *   wedged past a cancellation).
 * - The `workflow/*` events fire through {@link emitWorkflowEvent} (data
 *   snapshots, per-listener containment); `workflow/end` fires exactly once
 *   per started run, after `result` is settled or as it settles.
 * - `dispose()` reaches quiescence within a bounded grace: it cancels, waits
 *   for the script to settle AND its started children to finish disposing,
 *   and abandons whatever is left rather than hanging its caller (the engine
 *   documents what abandonment leaves behind).
 * - Runs are HOLDER-OWNED: the engine hands control (`cancel`/`dispose`) to
 *   the `start()` caller and does not track its live runs — disposing the
 *   engine's own fiber mid-run deliberately leaves those runs to their
 *   holders' teardown, so an engine reload cannot yank a run out from under
 *   the consumer awaiting it.
 */
export abstract class WorkflowService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflows')
  }

  /**
   * Parse and execute a workflow script.
   * @param request - the script, its `args`, the parent agent, and an
   *   optional cancel signal.
   * @returns the live run; its `result` resolves when the script settles.
   */
  abstract start(request: WorkflowStartRequest): WorkflowRun

  /**
   * Emit one `workflow/*` lifecycle event with PER-LISTENER containment and
   * PER-LISTENER payload snapshots: each subscriber is dispatched individually
   * with its OWN structural clone of the payload (the payloads are plain JSON
   * data by the seam contract), so a listener mutating what it received can
   * corrupt neither the engine's live state nor any other listener's or later
   * event's view; a thrown listener is logged (never propagated — the logging
   * itself is total, even for a thrown value whose own string coercion
   * throws), so one bad subscriber can neither fail the engine mid-run,
   * surface as an unhandled rejection on a detached settle hook, nor starve
   * the listeners registered after it (cordis `emit` halts on the first throw
   * — same guarantee as the subagent seam's lifecycle emits).
   * @param name - the `workflow/*` event to dispatch.
   * @param args - the event's payload, matching its declared signature.
   */
  protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        // The declared workflow/* signatures are all void-returning emits; the
        // dispatch callback applies the payload tuple.
        ;(callback as (...payload: unknown[]) => void)(...structuredClone(args))
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow: ${name} listener threw: ${renderListenerError(error)}`)
      }
    }
  }
}

/**
 * Total renderer for a listener-thrown value: the containment catch must never
 * itself throw, and `String(error)` does when the value's own `toString` /
 * `Symbol.toPrimitive` throws. Local rather than an engine package's renderer
 * — the seam sits below every engine and cannot import one.
 * @param error - any thrown value.
 * @returns `String(error)`, or a fixed label when even coercion throws.
 */
function renderListenerError(error: unknown): string {
  try {
    return String(error)
  } catch {
    // Only a throwing toString/Symbol.toPrimitive lands here; the fixed label
    // keeps the containment guarantee total.
    return '[unrenderable thrown value]'
  }
}

export default WorkflowService
