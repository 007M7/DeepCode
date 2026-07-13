/**
 * The `node:worker_threads` workflow engine: the {@link WorkflowService}
 * implementation. Runs each script in its OWN worker thread (one run = one
 * worker, no pooling — a run is heavyweight, so thread spin-up is noise): the
 * body executes in a vm context INSIDE the worker with the workflow hooks
 * injected, and `agent()` calls bridge back to `ctx.subagents` over the
 * message port — child agents are I/O-bound LLM loops and stay on the host
 * event loop; the thread isolates the SCRIPT, the only part that can spin
 * synchronously.
 *
 * TRUST PREMISE: scripts are MODEL-WRITTEN — the same trust level as the
 * model's existing bash access — so this engine defends against BUGGY
 * scripts, never hostile ones. A worker thread is NOT a security boundary:
 * the vm context inside it is escapable by construction, and an escapee
 * holds the same process privileges as the host (Node's permission model is
 * process-wide); genuine sandboxing (isolated-vm, a separate process) is an
 * engine swap behind the seam. What the thread buys, concretely:
 *
 * - `start()` never blocks the host: the script's initial synchronous slice
 *   (and any later synchronous spin) occupies the WORKER's event loop, not
 *   the harness's.
 * - Termination is REAL: a script that outlives its post-cancel grace is
 *   `worker.terminate()`d — nothing of the script survives `dispose()`,
 *   where an in-process engine could only abandon the spin on its own loop.
 * - The value boundary is serialization by construction: everything crossing
 *   the thread is structured-clone data (and plain JSON before that, by the
 *   materialization walk in ./realm.ts).
 *
 * Engine-specific limitations: worker startup (~tens of ms) is paid per run;
 * on a termination path `agentsStarted` reports the host-observed child
 * count (calls still queued worker-side for a slot are unknowable — see
 * ./host.ts); and a worker that dies unexpectedly (an OOM, a script reaching
 * `process.exit` through the documented vm escape) settles the run
 * `stopReason: 'error'` with the exit diagnostics.
 *
 * Plugin export shape: a default-exported {@link WorkflowService} subclass
 * (the class-based service form, like `dsh-bash-local`).
 *
 * @module @deepseek-ai/dsh-workflow-workerthread
 */

import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import * as vm from 'node:vm'
import type { Context } from 'cordis'
import z from 'schemastery'
import WorkflowService, { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { WorkerRun } from './host.ts'
import { validateMeta } from './meta.ts'
import type { WorkerInit, WorkerLimits } from './types.ts'

export { validateMeta } from './meta.ts'
export { HostToWorkerType, WorkerToHostType } from './protocol.ts'
export type { HostToWorkerMessage, HostToWorkerPayloads, WorkerToHostMessage, WorkerToHostPayloads } from './protocol.ts'
export { materializeFromRealm, MaterializeError } from './realm.ts'
export { WorkflowExecution, type ExecutionObserver } from './runtime.ts'
export { requireParentPort, runWorkerSession } from './session.ts'
export type {
  ChildHandle,
  ChildPort,
  ChildResult,
  ChildStartRequest,
  WorkerInit,
  WorkerLimits,
} from './types.ts'

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** The `ctx.subagents` provider children run on (default `spawn`). */
  provider?: string
  /** Concurrent `agent()` ceiling; `0` (the default) auto-resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start — the runaway-loop backstop (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by a single `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** vm timeout for the script's initial synchronous slice, inside the worker (default 5000 ms). */
  syncTimeoutMs?: number
  /**
   * How long after a cancellation an unsettled script may keep running before
   * the run force-settles `cancelled` and its worker is TERMINATED (default
   * 5000 ms); also bounds `dispose()`.
   */
  disposeGraceMs?: number
}

type ResolvedConfig = Required<Config>

/** A body that still carries the Claude Code-style meta header (meta rides the seam as data here). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/

/**
 * Parse-check the body with the SAME wrapper the worker-side runtime
 * compiles, so `start()` keeps the seam's synchronous `SCRIPT_PARSE` throw
 * (the worker's own compile happens a thread away, after `start()` returned).
 * One redundant parse per run, bought deliberately for the contract. A body
 * opening with `export const meta` gets a pointed message instead of the
 * wrapper's bare SyntaxError — the model's likeliest authoring slip.
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE')
  }
  try {
    // Parse only — the script object is discarded, nothing executes.
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 })
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

/**
 * The worker-thread engine service. `start()` validates the script up front
 * (meta + a host-side body parse) and returns a {@link WorkflowRun} whose
 * `result` never rejects; the `workflow/*` events fire around the run per
 * the seam contract.
 */
export class WorkerWorkflowEngine extends WorkflowService {
  static inject = ['subagents']

  static Config: z<Config> = z.object({
    provider: z.string().default('spawn'),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1000),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5000),
    disposeGraceMs: z.natural().default(5000),
  })

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery (static Config) has already filled the defaulted fields;
    // the assertion records that resolution, not a hidden fallback.
    this.config = config as ResolvedConfig
  }

  /**
   * Validate and execute a workflow script in a fresh worker thread. Throws
   * {@link WorkflowError} synchronously (`META_INVALID` for a malformed meta
   * block, `SCRIPT_PARSE` for a body that does not compile) for a request
   * that cannot begin; once a run is returned, every failure resolves through
   * `result.stopReason` instead.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const id = WorkflowRunId(randomUUID())
    const info: WorkflowRunInfo = { id, meta }
    const limits: WorkerLimits = {
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents: this.config.maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...request.args !== undefined ? { args: request.args } : {},
      limits,
    }
    // Capture the dependency while this service call is still traced through
    // the start() holder. Cordis strips the engine-provider shadow when it
    // returns the SubagentService handle, so an already-returned run can keep
    // starting children after an engine HMR unload removes ctx.workflows.
    // Re-resolving `this.ctx.subagents` later from WorkerRun would instead walk
    // the now-inactive engine fiber and break the seam's holder-owned lifetime.
    const runCtx = this.ctx
    const subagents = runCtx.subagents
    const workerRun = new WorkerRun(
      runCtx,
      subagents,
      id,
      meta,
      request.parent,
      init,
      this.config.provider,
      this.config.disposeGraceMs,
      {
        phase: (title) => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: (message) => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: (agent) => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: (agent) => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
      request.signal,
    )

    this.emitWorkflowEvent('workflow/start', info)
    // `workflow/end` fires as the (never-rejecting) result settles, with the
    // outcome DATA only — the value stays with the run's holder.
    void workerRun.result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })

    return workerRun
  }
}

export default WorkerWorkflowEngine
