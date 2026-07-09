/**
 * The host half of one worker-engine run: spawn the Worker, bridge its child
 * RPC onto `ctx.subagents`, fan its observer messages into the engine's
 * events, and own cancellation, the settle-within-grace guarantee, and child
 * cleanup. The worker's lifetime IS the run's lifetime: `dispose()` always
 * ends with `worker.terminate()`, so no thread outlives its run.
 *
 * The run's `result` promise settles exactly once, from whichever of these
 * lands first: the worker's `result` message (a host-side cancellation in
 * flight overrides a non-cancelled report — the seam-visible result had not
 * settled when cancellation was requested), an unexpected worker death
 * (`error`/`messageerror`/premature `exit` → `stopReason: 'error'`, or
 * `'cancelled'` when a cancel was in flight), or the post-cancel grace timer
 * (a script that never settles is force-settled `cancelled` and its worker
 * terminated — the real kill an in-process engine could not perform).
 *
 * Children live in a host-side registry (callId → run): the worker drives
 * their disposal by RPC on the graceful path, `dispose()` host-drives every
 * registered child's disposal immediately (a wedged worker can relay no
 * dispose RPC, and child teardown must overlap the grace, not start after
 * it), and the registry is what lets the host abort and dispose every
 * survivor when the worker dies or is terminated mid-flight. The three
 * paths share ONE disposal per child (memoized by callId; the seam's
 * dispose() is idempotent anyway, the memo keeps the bookkeeping and the
 * containment warn single). Lifecycle pairing is host-guaranteed the same
 * way: every forwarded `agent-start` lives in a ledger, and a start the
 * dead or terminated worker never paired is closed by a synthesized
 * `agent-end` (outcome `'cancelled'`) before the run settles. On a
 * termination path `agentsStarted` reports the
 * HOST-observed count (accepted `child-start` messages) — `agent()` calls
 * still queued worker-side for a concurrency slot are unknowable then; the
 * worker's own count rides the result message on every graceful path.
 *
 * @module @deepseek-ai/dsh-workflow-workerthread/host
 */

import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { renderThrown } from './realm.ts'
import type { ExecutionObserver } from './runtime.ts'
import { HostToWorkerType, WorkerToHostType } from './protocol.ts'
import type { HostToWorkerPayloads, WorkerToHostMessage } from './protocol.ts'
import type { ChildStartRequest, WorkerInit } from './types.ts'

/**
 * Resolve the worker entry and spawn options for the current runtime shape.
 * Unbuilt (tsx demos, vitest — `import.meta.url` points into `src/`), the
 * entry is the TypeScript sibling and the worker needs the tsx loader
 * registered explicitly: a worker thread inherits no transform pipeline from
 * vitest (vite transforms in-process, not via a node loader), and passing
 * execArgv explicitly also shields the worker from any loader flags the
 * parent was started with. Built (`lib/index.js`), the entry is the sibling
 * bundle the package tsdown config emits and no loader is needed (execArgv
 * pinned empty — hermetic, like the environment).
 *
 * Both shapes spawn with an EMPTY environment (`env: {}`): the documented vm
 * escape reaches `process`, and the harness's ambient credentials
 * (`DEEPSEEK_API_KEY` et al.) must not ride along — the same stance as
 * `dsh-code-runtime-worker`, stronger than the scrubbed env the
 * defensive-patterns rule requires for spawned commands (a shell needs PATH;
 * this worker needs nothing). Sole exception: the unbuilt shape forwards
 * `TSX_TSCONFIG_PATH` when the parent carries it (loader plumbing the paths
 * map depends on outside the repo cwd, not a secret). This closes the
 * AMBIENT channel only — an escapee still holds process-wide privileges
 * like fs access (the README's trust premise stands).
 * @param init - the run payload, passed as `workerData`.
 * @returns the entry URL and the Worker options to spawn it with.
 */
function resolveWorkerSpawn(init: WorkerInit): { entry: URL; options: WorkerOptions } {
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/); the built-worker e2e exercises this shape for real */
  if (!import.meta.url.endsWith('.ts')) {
    return { entry: new URL('./worker.js', import.meta.url), options: { workerData: init, env: {}, execArgv: [] } }
  }
  // Lazy tsx resolution: only the unbuilt shape needs it, so the built
  // bundle never requires tsx to be installed. TSX_TSCONFIG_PATH is the one
  // variable forwarded through the scrub: tsx finds a tsconfig by searching
  // UP from the worker's cwd, and a parent running with its cwd outside the
  // repo (the ACP snapshot harness pins the tsconfig through this exact
  // variable) would otherwise lose the dsh-* paths map and resolve workspace
  // imports to unbuilt lib/ bundles. Loader plumbing, not a secret.
  return {
    entry: new URL('./worker.ts', import.meta.url),
    options: {
      workerData: init,
      env: process.env.TSX_TSCONFIG_PATH === undefined ? {} : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
      execArgv: ['--import', fileURLToPath(import.meta.resolve('tsx'))],
    },
  }
}

/**
 * One live worker-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the Worker, the child registry, and the result
 * settlement; `result` never rejects. `meta` is this handle's OWN clone
 * (event payloads carry separate clones), so a consumer mutating it corrupts
 * nothing.
 */
export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private readonly worker: Worker
  /** Set on `exit`: the thread is gone, so posting has nowhere to go. */
  private workerGone = false
  /** Accepted `child-start` messages — the terminate-path `agentsStarted` (see module doc). */
  private hostStarted = 0
  /** Live children by callId; an entry leaves ONLY after its dispose settles (quiescence = empty). */
  private readonly children = new Map<number, SubagentRun>()
  /** In-flight child disposals by callId — the memo that gives every path (worker RPC, dispose(), reap) ONE shared disposal per child. */
  private readonly childDisposals = new Map<number, Promise<void>>()
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    init: WorkerInit,
    private readonly provider: string,
    private readonly disposeGraceMs: number,
    private readonly observer: ExecutionObserver,
    signal: AbortSignal | undefined,
  ) {
    this.result = new Promise<WorkflowResult>((resolve) => { this.settleResolve = resolve })
    // workerData rides the structured clone: args are plain JSON by the seam
    // contract, so the clone is total and doubles as the caller-isolation
    // copy (a clone failure throws loud out of start()).
    const { entry, options } = resolveWorkerSpawn(init)
    this.worker = new Worker(entry, options)
    this.worker.on('message', (message: WorkerToHostMessage) => { this.onMessage(message) })
    this.worker.on('error', (error) => { this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`) })
    /* v8 ignore next -- messageerror: not constructible from the engine's own protocol (every payload is JSON data) */
    this.worker.on('messageerror', (error) => { this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`) })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${code})`)
    })
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else {
      signal?.addEventListener('abort', () => { this.cancel('workflow signal aborted') }, { once: true })
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), every host-side child is cancelled NOW on
   * BOTH seam channels — the shared request signal aborts and each registered
   * child's explicit `cancel()` is called (the seam leaves a provider free to
   * honor either, and a worker wedged in a synchronous spin could not relay
   * its own per-child cancel RPCs until far too late) — and the grace timer
   * arms: a run still unsettled `disposeGraceMs` later force-settles
   * `cancelled` and its worker is TERMINATED. Idempotent; the first reason
   * wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    // A settled run has nothing left to cancel: without this guard the
    // ordinary consumer path (await result, then dispose -> cancel) would arm
    // a grace timer nothing ever clears, pinning the run and its Worker
    // closure until the grace expires - a bounded leak per completed run.
    if (this.settled || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    this.controller.abort(this.cancelReason)
    // The explicit channel is driven host-side, not left to the worker: a
    // provider honoring only run.cancel() must not wait on a wedged worker's
    // ChildCancel relay (those later RPCs land as idempotent no-ops).
    for (const run of this.children.values()) run.cancel(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      // The worker may no longer speak (it is about to be terminated): pair
      // every stranded start before the run settles, so ends precede
      // workflow/end.
      this.endStrandedAgents()
      this.settleResult(this.cancelledResult(this.hostStarted))
      void this.worker.terminate()
    }, this.disposeGraceMs)
    // unref'd: an armed grace timer must never hold the process open.
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered
   * child's disposal IMMEDIATELY — a wedged worker can relay no dispose RPC,
   * and deferring child teardown to the post-terminate reap would spend the
   * whole grace waiting for a quiescence that cannot start, then return with
   * the disposals still in flight — so child disposal overlaps the same
   * grace the worker gets to settle (the worker's own dispose RPCs join the
   * shared per-child disposal). Waits (at most the grace) for the result and
   * child quiescence, then terminates the worker unconditionally — the
   * thread never outlives its run — and reaps whatever children remain
   * (their disposal is contained, not awaited past the grace, the same
   * abandonment the seam documents for a slow-disposing child). Idempotent;
   * safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      this.cancel('workflow disposed')
      for (const [callId, run] of [...this.children]) void this.disposeChild(callId, run)
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      await this.worker.terminate()
      this.reapChildren('workflow disposed')
    })()
    return this.disposed
  }

  /** Post one message to the worker (payload looked up from the tag's map entry), tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone) return
    try {
      this.worker.postMessage({ type, ...payload })
    } catch (error: unknown) {
      // Only a teardown race can land here (every engine message is JSON
      // data, so serialization cannot fail); there is nothing left to
      // deliver to — log and move on.
      /* v8 ignore next -- postMessage teardown race (a throw between exit and its event): not constructible in-process */
      this.ctx.logger.warn(`workflow-workerthread: postMessage failed: ${renderThrown(error)}`)
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case WorkerToHostType.Ready:
        this.post(HostToWorkerType.Go, {})
        break
      case WorkerToHostType.Phase:
        // Post-cancel narration is suppressed host-side: worker-side the
        // hooks throw once the cancel message is PROCESSED, but narration
        // already in flight (or emitted while the cancel crossed the
        // boundary) must not reach observers — nothing is emitted after
        // cancel() returns.
        if (this.cancelReason === undefined) this.observer.phase(message.title)
        break
      case WorkerToHostType.Log:
        if (this.cancelReason === undefined) this.observer.log(message.message)
        break
      case WorkerToHostType.AgentStart:
        this.liveAgents.set(message.info.seq, message.info)
        this.observer.agentStart(message.info)
        break
      case WorkerToHostType.AgentEnd:
        // NOT suppressed on cancel: cancelled children report their paired
        // agent-end with outcome 'cancelled'. The gate (with the termination
        // paths' synthesis) is what makes the one-pair-per-started-child
        // contract hold on every stop path.
        this.endAgent(message.info)
        break
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request)
        break
      case WorkerToHostType.ChildCancel:
        this.children.get(message.callId)?.cancel(message.reason)
        break
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId)
        break
      case WorkerToHostType.Result:
        this.onResult(message.result)
        break
      /* v8 ignore next 2 -- closed engine-owned union; the arm only makes adding a message type a compile error */
      default:
        assertNever(message, 'worker-to-host message')
    }
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    if (this.cancelReason !== undefined) {
      // The worker's start raced our cancel: refuse — a child must never
      // start on an already-aborted signal (a provider subscribing only to
      // future abort events would never observe it).
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: `workflow run cancelled: ${this.cancelReason}` })
      return
    }
    this.hostStarted += 1
    let run: SubagentRun
    try {
      run = this.ctx.subagents.start(this.provider, {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...request.schema !== undefined ? { outputSchema: request.schema } : {},
        ...request.model !== undefined ? { agentOptions: { model: request.model } } : {},
      })
    } catch (error: unknown) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: renderThrown(error) })
      return
    }
    this.children.set(callId, run)
    this.post(HostToWorkerType.ChildStarted, { callId, childId: run.id })
    run.result.then(
      (result) => {
        this.post(HostToWorkerType.ChildSettled, {
          callId,
          result: {
            output: result.output,
            ...result.structured !== undefined ? { structured: result.structured } : {},
            stopReason: result.stopReason,
          },
        })
      },
      (error: unknown) => { this.post(HostToWorkerType.ChildFailed, { callId, rendered: renderThrown(error) }) },
    )
  }

  private onChildDispose(callId: number): void {
    const run = this.children.get(callId)
    if (run === undefined) {
      // Already disposed host-side (a dispose() drive or a death reap beat
      // the RPC) — the ack is still owed (the worker-side wrapper awaits it).
      this.post(HostToWorkerType.ChildDisposed, { callId })
      return
    }
    // disposeChild never rejects (containment is inside), so the ack always follows.
    void this.disposeChild(callId, run).then(() => { this.post(HostToWorkerType.ChildDisposed, { callId }) })
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry
   * leaves when it settles. Memoized per callId: the worker's dispose RPC,
   * the dispose() host drive, and the reap can all land on the same child —
   * the child's `dispose()` runs once and every caller awaits that one
   * settlement. A rejection is contained (the subagent seam's dispose() is
   * not supposed to reject, but a backend that does anyway must not break
   * quiescence): logged, and the child still leaves the registry.
   * @param callId - the child's registry key.
   * @param run - the registered child (the caller looked it up).
   * @returns resolves when the disposal settled either way; never rejects.
   */
  private disposeChild(callId: number, run: SubagentRun): Promise<void> {
    let disposal = this.childDisposals.get(callId)
    if (disposal === undefined) {
      disposal = run.dispose().then(
        () => { this.finishChild(callId) },
        (error: unknown) => {
          this.ctx.logger.warn(`workflow-workerthread: child dispose failed: ${renderThrown(error)}`)
          this.finishChild(callId)
        },
      )
      this.childDisposals.set(callId, disposal)
    }
    return disposal
  }

  /** Drop a child from the registry (and its disposal memo), releasing quiescence waiters at zero. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.childDisposals.delete(callId)
    if (this.children.size === 0) {
      for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
    }
  }

  /** Resolves once the child registry is empty (every disposal settled). */
  private childQuiescence(): Promise<void> {
    if (this.children.size === 0) return Promise.resolve()
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.controller.abort(this.cancelReason ?? reason)
    for (const [callId, run] of [...this.children]) {
      run.cancel(this.cancelReason ?? reason)
      void this.disposeChild(callId, run)
    }
  }

  private onResult(result: WorkflowResult): void {
    // The worker's settle-reap already child-cancel()s every stray; this
    // abort fires the seam signal too, for providers that only honor the
    // request signal (both channels, on every path).
    if (this.cancelReason === undefined) this.controller.abort('workflow settled')
    if (this.cancelReason !== undefined && result.stopReason !== 'cancelled') {
      // The script settled while our cancel was crossing the thread boundary
      // — the seam-visible result had NOT settled when cancellation was
      // requested, so report cancelled (the vm drive()'s post-settle check,
      // relocated to the receiving side of the race).
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  /** An unexpected worker death (or the expected exit after termination). */
  private onWorkerDeath(message: string): void {
    // Whatever the worker left behind must not leak — abort + dispose it all.
    if (this.children.size > 0) this.reapChildren('workflow worker gone')
    // The thread is gone: no more worker-authored agent-ends can arrive —
    // pair every stranded start (a start that crossed between the grace
    // force-settle and this exit included) before the run settles.
    this.endStrandedAgents()
    // settleResult no-ops on an already-settled run (the expected exit after
    // a dispose's terminate lands here too).
    if (this.cancelReason !== undefined) {
      this.settleResult(this.cancelledResult(this.hostStarted))
      return
    }
    this.settleResult({ value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted })
  }

  /**
   * The single agent-end emission gate: forwards `end` iff its start is still
   * unpaired in the ledger, so every forwarded `workflow/agent-start` gets
   * EXACTLY one `workflow/agent-end` — the worker's own report where it can
   * speak, a host-synthesized one where it cannot ({@link endStrandedAgents}).
   * @param end - the settlement to emit (worker-reported or synthesized).
   */
  private endAgent(end: WorkflowAgentEndInfo): void {
    /* v8 ignore next -- a real end still in flight across the grace force-settle: not orderable in-process */
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /**
   * Synthesize the missing `agent-end` for every started-but-unpaired agent,
   * outcome `'cancelled'`: the reap cancels every child, and a real
   * settlement racing the force-settle loses to the cancellation — the same
   * first-wins override {@link onResult} applies to the run's own result.
   * Called where the worker can no longer speak (the grace force-settle,
   * worker death), BEFORE settleResult, so the paired ends reach observers
   * before `workflow/end`.
   */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    // cancel() is the only writer of cancelReason and every caller checks it
    // first; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    const reason = this.cancelReason ?? 'workflow cancelled'
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${reason}`, agentsStarted }
  }

  /** First settle wins; disarms the grace timer. */
  private settleResult(result: WorkflowResult): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

/** A plain timer sleep (the dispose grace); unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
