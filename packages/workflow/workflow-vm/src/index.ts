/**
 * The `node:vm` workflow engine: the first {@link WorkflowService}
 * implementation. Parses the Claude Code-format script (meta + body), runs the
 * body in a fresh in-process vm context with the workflow hooks injected, and
 * fans `agent()` calls out to `ctx.subagents`.
 *
 * Engine limitations, documented as the accepted cost of the in-process
 * mechanism (the interface/implementation seam exists precisely so a
 * worker-thread or isolated-vm engine can swap in if these ever matter):
 *
 * - vm is NOT a security boundary. Scripts are model-written — the same trust
 *   level as the model's bash access — and the realm-boundary materialization
 *   is correctness containment, not a sandbox.
 * - The vm `timeout` covers only the initial SYNCHRONOUS slice of the script;
 *   a pathological synchronous spin after the first await cannot be killed
 *   in-process. `dispose()` therefore waits a bounded grace and then ABANDONS
 *   a stuck script: its pending hook promises are already rejected and its
 *   settlement is contained (no unhandled rejection), but an abandoned
 *   synchronous spin would still occupy the event loop.
 *
 * Plugin export shape: a default-exported {@link WorkflowService} subclass
 * (the class-based service form, like `dsh-bash-local`).
 *
 * @module @deepseek-ai/dsh-workflow-vm
 */

import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import type { Context } from 'cordis'
import z from 'schemastery'
import WorkflowService, { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { extractMeta } from './meta.ts'
import { WorkflowExecution, type ExecutionLimits } from './runtime.ts'

export { extractMeta, type ExtractedScript } from './meta.ts'
export { materializeFromRealm, MaterializeError } from './realm.ts'
export { WorkflowExecution, type ExecutionLimits, type ExecutionObserver } from './runtime.ts'

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
  /** vm timeout for the script's initial synchronous slice AND the meta-literal evaluation (default 5000 ms). */
  syncTimeoutMs?: number
  /** How long `dispose()` waits for a cancelled script to settle before abandoning it (default 5000 ms). */
  disposeGraceMs?: number
}

type ResolvedConfig = Required<Config>

/**
 * The vm engine service. `start()` validates the script up front (meta +
 * body compile) and returns a {@link WorkflowRun} whose `result` never
 * rejects; the `workflow/*` events fire around the run per the seam contract.
 */
export class VmWorkflowEngine extends WorkflowService {
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
   * Parse and execute a workflow script. Throws {@link WorkflowError}
   * synchronously (`SCRIPT_PARSE`/`META_INVALID`) for a script that cannot
   * begin; once a run is returned, every failure resolves through
   * `result.stopReason` instead.
   * @param request - the script, its `args`, the parent agent, and an
   *   optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const { meta, body } = extractMeta(request.script, this.config.syncTimeoutMs)
    const id = WorkflowRunId(randomUUID())
    // The event payloads and the run handle get SEPARATE meta clones: a
    // listener mutating its snapshot must not corrupt the holder's view.
    const info: WorkflowRunInfo = { id, meta: structuredClone(meta) }
    const limits: ExecutionLimits = {
      provider: this.config.provider,
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents: this.config.maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const execution = new WorkflowExecution(
      this.ctx,
      meta,
      body,
      request.parent,
      request.args,
      request.signal,
      limits,
      {
        phase: (title) => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: (message) => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: (agent) => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: (agent) => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
    )

    this.emitWorkflowEvent('workflow/start', info)
    const result: Promise<WorkflowResult> = execution.drive()
    // `workflow/end` fires as the (never-rejecting) result settles, with the
    // outcome DATA only — the value stays with the run's holder.
    void result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })

    let disposed: Promise<void> | undefined
    return {
      id,
      meta: structuredClone(meta),
      result,
      cancel(reason?: string): void {
        execution.cancel(reason)
      },
      dispose: (): Promise<void> => {
        // Idempotent: cancel, then wait min(settle, grace). `result` never
        // rejects, so the race needs no rejection handling; an unsettled
        // script past the grace is abandoned per the module contract.
        disposed ??= (async () => {
          execution.cancel('workflow disposed')
          await Promise.race([result, sleep(this.config.disposeGraceMs)])
        })()
        return disposed
      },
    }
  }
}

/** A plain timer sleep (the dispose grace); unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

export default VmWorkflowEngine
