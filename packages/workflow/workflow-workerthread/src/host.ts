/**
 * The host half of one worker-engine run: spawn the Worker, bridge its child
 * RPC onto the holder-bound subagent service, fan its observer messages into
 * the engine's events, and own cancellation, the settle-within-grace
 * guarantee, and child cleanup. The worker's lifetime IS the run's lifetime:
 * `dispose()` always ends with `worker.terminate()`, so no thread outlives its
 * run.
 *
 * The run's `result` promise settles exactly once, from whichever of these
 * lands first: receipt of the worker's `result` message, an unexpected worker
 * death (`error`/`messageerror`/premature `exit` → `stopReason: 'error'`, or
 * `'cancelled'` when a cancel was in flight), or the post-cancel grace timer (a
 * script that never settles is force-settled `cancelled` and its worker
 * terminated — the real kill an in-process engine could not perform). At
 * `result` receipt the host snapshots whether caller/signal/dispose
 * cancellation is already in flight: an earlier cancellation overrides a
 * non-cancelled report; otherwise the report wins before settlement-only child
 * cleanup invokes arbitrary provider callbacks. Worker death uses the same
 * boundary: it claims `error` (or a previously requested `cancelled`) before
 * reaping children, so cleanup callbacks cannot rewrite the outcome. That
 * first signal also closes inbound message admission: Node may emit `error`,
 * then deliver queued messages, then emit `exit`, but those late messages may
 * neither create work nor narrate after settlement. If Result or grace already
 * owns the outcome, death preserves it while still cleaning resources; the
 * eventual exit performs a final disposal-only sweep without repeating child
 * cancellation.
 *
 * Children live in a host-side registry (callId → run) as soon as the provider
 * accepts them, so cancellation reaches even a pre-publication attempt. Both
 * explicit run cancellation and the shared request signal are driven when the
 * workflow is cancelled OR normally settles, so a fire-and-forget child cannot
 * survive merely by honoring only one channel. A per-call gate invokes each
 * explicit provider `cancel()` at most once even though host fanout and the
 * worker's later relay can both request it. The host observes `result`
 * immediately but acknowledges the child to the worker only after `started`
 * fulfills; readiness failure is a start error and the host disposes the
 * attempt because the worker never received a handle. The
 * worker drives disposal by RPC on the graceful path, `dispose()` host-drives
 * every registered child's disposal immediately (a wedged worker can relay no
 * dispose RPC, and child teardown must overlap the grace, not start after it),
 * and the registry lets the host abort and dispose every survivor when the
 * worker dies or is terminated mid-flight. The three
 * paths share ONE disposal per child (memoized by callId; the seam's
 * dispose() is idempotent anyway, the memo keeps the bookkeeping and the
 * containment warn single). Lifecycle pairing is host-guaranteed the same
 * way: every forwarded `agent-start` lives in a ledger, and a start the dead
 * or terminated worker never paired is closed exactly once by a synthesized
 * `agent-end` (outcome `'cancelled'`). When death or grace is the terminal
 * source, already-known pairs close before the run settles; cleanup after an
 * earlier Result can close a survivor afterward. On a termination path
 * `agentsStarted` reports the
 * HOST-observed count (accepted `child-start` messages) — `agent()` calls
 * still queued worker-side for a concurrency slot are unknowable then; the
 * worker's own count rides the result message on every graceful path.
 *
 * @module @deepseek-ai/dsh-workflow-workerthread/host
 */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { renderThrown } from './realm.ts'
import type { ExecutionObserver } from './runtime.ts'
import { HostToWorkerType, WorkerToHostType } from './protocol.ts'
import type { HostToWorkerPayloads, WorkerToHostMessage } from './protocol.ts'
import type { ChildResult, ChildStartRequest, WorkerInit } from './types.ts'

/**
 * Resolve the worker entry and spawn options for the current runtime shape.
 * Unbuilt (tsx demos, vitest — `import.meta.url` points into `src/`), the
 * entry is a JavaScript data-URL bootstrap. That bootstrap runs INSIDE the
 * user worker, registers tsx's ESM AND CommonJS transforms there, and only
 * then imports the TypeScript sibling. The whole mixed-module source graph
 * therefore receives TypeScript transformation and the tsconfig paths map in
 * the worker's own module-loader realm. A worker inherits no
 * transform pipeline from vitest (vite transforms in-process), and a parent
 * `--import tsx` registration is not a contract that user workers share on
 * every supported Node line. Built (`lib/index.js`), the entry is the sibling
 * bundle the package tsdown config emits and no loader is needed (`execArgv`
 * pinned empty in both shapes — hermetic, like the environment).
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
  // Resolve tsx lazily: only the unbuilt shape executes this arm, so a built
  // consumer never needs the dev-only loader installed. A JavaScript entry is
  // essential — it can install tsx's ESM and CommonJS hooks from INSIDE the
  // user worker before any TypeScript enters Node's native strip-only parser.
  // Both hooks are load-bearing because the source graph crosses both module
  // shapes on supported Node lines. TSX_TSCONFIG_PATH is
  // the one variable forwarded through the scrub: a parent running outside
  // the repo cwd (the ACP snapshot harness is the real case) pins the paths
  // map through it. Loader plumbing, not a secret.
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: process.env.TSX_TSCONFIG_PATH === undefined ? {} : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
      execArgv: [],
    },
  }
}

/**
 * One live worker-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the Worker, the child registry, and the result
 * settlement; `result` never rejects. `meta` is this handle's OWN clone
 * (event payloads carry separate clones), so a consumer mutating it corrupts
 * nothing. The holder-bound SubagentService handle is captured before the
 * engine returns this run, so unloading the engine removes only the ability to
 * start another workflow; this run can still start and clean up its children.
 */
export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  /** The first death signal closes worker-message admission and owns failure-time cleanup. */
  private workerDeathObserved = false
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
  /** callIds whose explicit provider cancel callback has already been invoked. */
  private readonly childCancellations = new Set<number>()
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentService,
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
    this.worker.on('error', (error) => { this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false) })
    /* v8 ignore next -- messageerror: not constructible from the engine's own protocol (every payload is JSON data) */
    this.worker.on('messageerror', (error) => { this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`, false) })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${code})`, true)
    })
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
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
    // A settled run has nothing left to cancel, and a terminal source claimed
    // before its cleanup callbacks must exclude cancellation reentered by one
    // of those callbacks. Without the settled guard the
    // ordinary consumer path (await result, then dispose -> cancel) would arm
    // a grace timer nothing ever clears, pinning the run and its Worker
    // closure until the grace expires - a bounded leak per completed run.
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    // The explicit channel is driven host-side, not left to the worker: a
    // provider honoring only run.cancel() must not wait on a wedged worker's
    // ChildCancel relay (the per-call cancellation gate makes those later
    // RPCs no-ops without imposing idempotence on the provider).
    this.cancelChildren(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      // Cancellation already owns the race through cancelReason; close the
      // terminal boundary explicitly before observer teardown callbacks.
      this.terminalClaimed = true
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
    if (this.disposed !== undefined) return this.disposed
    // Claim the public transaction BEFORE its body invokes child/provider
    // disposal. A raw provider callback can reenter handle.dispose(); it must
    // join this promise rather than start a second traversal.
    const claimed = Promise.withResolvers<undefined>()
    this.disposed = claimed.promise
    void (async () => {
      this.detachInputSignal()
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
    })().then(
      () => { claimed.resolve(undefined) },
      /* v8 ignore next -- result/quiescence never reject and Worker.terminate is the only external promise */
      (error: unknown) => { claimed.reject(error) },
    )
    return this.disposed
  }

  /** Post one message to the worker (payload looked up from the tag's map entry), tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone || this.workerDeathObserved) return
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
    // Node may emit `error`, then deliver an already-queued `message`, then
    // emit `exit`. The first death signal is the host's logical delivery
    // barrier: nothing arriving afterward may create a child, narrate after
    // workflow/end, or compete with the chosen outcome.
    if (this.workerDeathObserved) return
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
        {
          const run = this.children.get(message.callId)
          if (run !== undefined) this.cancelChild(message.callId, run, message.reason)
        }
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

  /** Why a child may no longer cross the provider readiness boundary. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` }
    }
    if (this.workerDeathObserved) {
      return { reason: 'workflow worker gone', rendered: 'workflow worker is no longer available' }
    }
    if (this.terminalClaimed) {
      return { reason: 'workflow settled', rendered: 'workflow run already settled' }
    }
    return undefined
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      // Refuse after a terminal boundary: a child must never start on an
      // already-aborted signal (a provider subscribing only to future abort
      // events would never observe it).
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered })
      return
    }
    this.hostStarted += 1
    let run: SubagentRun
    try {
      run = this.subagents.start(this.provider, {
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
    const childId = run.id

    // Observe settlement IMMEDIATELY, before readiness. A provider may reject
    // result and started in the same turn; delaying this handler would make the
    // result transiently unhandled. Buffer a forwarding closure so the worker
    // still sees ChildStarted before ChildSettled/ChildFailed. Snapshot a
    // resolved result now: a provider mutating its resolved object while
    // publication is pending must not change what crosses the worker boundary.
    const forwardResult = run.result.then<() => void, () => void>(
      (result) => {
        try {
          // Capture every provider-owned field once, then materialize the
          // worker-bound value in one lossless traversal. A stateful accessor
          // cannot validate one result and send another, and an exotic value is
          // rejected before any prototype-erasing clone.
          const output = result.output
          const structured = result.structured
          const stopReason = result.stopReason
          const snapshot = snapshotJsonValue<ChildResult>({
            output,
            ...structured !== undefined ? { structured } : {},
            stopReason,
          })
          if (snapshot === undefined) throw new TypeError('child result is not losslessly JSON-serializable')
          return () => { this.post(HostToWorkerType.ChildSettled, { callId, result: snapshot }) }
        } catch (error: unknown) {
          const rendered = `workflow child result could not cross the worker boundary: ${renderThrown(error)}`
          return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
        }
      },
      (error: unknown) => {
        const rendered = renderThrown(error)
        return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
      },
    )

    // The provider owns the publication boundary. Observe both promises before
    // invoking cancellation/disposal below: provider.start() itself is
    // arbitrary code and may have reentered handle.cancel() before the returned
    // run reached our registry. Exactly one branch answers this ChildStart.
    let startReplySent = false
    const refusePublication = (failure: { reason: string; rendered: string }): void => {
      startReplySent = true
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered })
      // A prior dispose/death can finish and remove this run while readiness
      // is still pending. In that case teardown already owned cancellation and
      // disposal; touching the retired callId would repeat cancel and orphan a
      // fresh gate entry after finishChild deleted it.
      if (this.children.get(callId) !== run) return
      this.cancelChild(callId, run, failure.reason)
      void this.disposeChild(callId, run)
    }

    // Only acknowledge the child after it is real, then flush any result that
    // settled unusually early. Re-check admission at that exact boundary: a
    // cancellation while readiness was pending is a refusal, not a late
    // publication into a terminal workflow. A readiness rejection is a START
    // failure, not AGENT_RESULT; the worker never receives a handle, so the
    // host disposes the registered attempt. Identity guards preserve the one
    // disposal memo against concurrent host teardown.
    void run.started.then(
      () => {
        if (startReplySent) return
        const failure = this.childAdmissionFailure()
        if (failure !== undefined) {
          refusePublication(failure)
          return
        }
        startReplySent = true
        this.post(HostToWorkerType.ChildStarted, { callId, childId })
        void forwardResult.then((forward) => { forward() })
      },
      (error: unknown) => {
        if (startReplySent) return
        startReplySent = true
        this.post(HostToWorkerType.ChildStartError, { callId, rendered: renderThrown(error) })
        if (this.children.get(callId) === run) void this.disposeChild(callId, run)
      },
    )

    // Close the synchronous hole around provider.start(): cancel()/dispose()
    // can run before the returned run is visible to their children loop.
    const reentrantFailure = this.childAdmissionFailure()
    if (reentrantFailure !== undefined) refusePublication(reentrantFailure)
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
      // Claim before run.dispose() invokes provider code. Reentrant holder
      // disposal then joins this exact child transaction instead of entering
      // the provider wrapper twice before either memo is installed.
      const claimed = Promise.withResolvers<undefined>()
      disposal = claimed.promise
      this.childDisposals.set(callId, disposal)
      // The seam promises a Promise, but invoke inside an async boundary so a
      // contract-violating synchronous throw is contained exactly like a
      // rejected disposal and cannot break host quiescence.
      void (async () => { await run.dispose() })().then(
        () => {
          this.finishChild(callId)
          claimed.resolve(undefined)
        },
        (error: unknown) => {
          this.ctx.logger.warn(`workflow-workerthread: child dispose failed: ${renderThrown(error)}`)
          this.finishChild(callId)
          claimed.resolve(undefined)
        },
      )
    }
    return disposal
  }

  /** Drop a child from the registry (and its disposal memo), releasing quiescence waiters at zero. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.childDisposals.delete(callId)
    this.childCancellations.delete(callId)
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
    const cancellation = this.cancelReason ?? reason
    this.cancelChildren(cancellation)
    for (const [callId, run] of [...this.children]) {
      void this.disposeChild(callId, run)
    }
  }

  /** Drive both cancellation channels for every child already accepted by the host. */
  private cancelChildren(reason: string): void {
    this.controller.abort(reason)
    for (const [callId, run] of this.children) this.cancelChild(callId, run, reason)
  }

  /** Invoke one provider-owned cancel callback at most once and contain its exception. */
  private cancelChild(callId: number, run: SubagentRun, reason?: string): void {
    // Host fanout and the worker's FIFO-later ChildCancel relay are two paths
    // to the same provider callback. The seam does not require cancel() to be
    // idempotent, so claim the callId before invoking arbitrary provider code.
    if (this.childCancellations.has(callId)) return
    this.childCancellations.add(callId)
    try {
      run.cancel(reason)
    } catch (error: unknown) {
      this.ctx.logger.warn(`workflow-workerthread: child cancel failed: ${renderThrown(error)}`)
    }
  }

  private onResult(result: WorkflowResult): void {
    // The owned worker session sends one Result. Keep a late duplicate or a
    // Result queued behind another terminal source completely side-effect-free.
    if (this.terminalClaimed) return
    // First-wins is decided when the Result message reaches the host. If no
    // external cancellation was already in flight, this result won. Reaping a
    // stray child below may synchronously reenter cancel() through provider
    // callbacks, but that internal post-result cleanup must not retroactively
    // rewrite the worker result that arrived first.
    const cancellationWasRequested = this.cancelReason !== undefined
    // Claim before either settlement-cleanup cancellation channel invokes
    // provider code. A provider callback can reenter cancel() synchronously or
    // from a queued microtask; once Result won, that losing cancellation must
    // have no state, message, child-fanout, or grace-timer side effects.
    this.terminalClaimed = true
    // The worker cancels handles it already received, but a fire-and-forget
    // child may still be waiting on readiness and therefore have no worker
    // handle. Drive BOTH provider-permitted channels from the host before the
    // workflow becomes externally settled.
    if (!cancellationWasRequested) {
      this.cancelChildren('workflow settled')
      this.settleResult(result)
      return
    }
    if (result.stopReason !== 'cancelled') {
      // The script settled while our cancel was crossing the thread boundary
      // — the seam-visible result had NOT settled when cancellation was
      // requested, so report cancelled (the vm drive()'s post-settle check,
      // relocated to the receiving side of the race).
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  /** Process an error/messageerror/exit signal; `exit` also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      // Close message admission BEFORE cleanup callbacks: Node can deliver a
      // message queued before the crash after its `error` event. Treating the
      // first death signal as a logical barrier prevents that late message
      // from creating work or narrating after workflow/end.
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      // When death is itself the terminal source, claim BEFORE child reap or
      // synthesized observer callbacks. Either can reenter cancel(); a death
      // that arrived first remains an error, while a cancellation already
      // accepted before death remains cancelled. If Result/grace already won,
      // preserve it while still performing prompt failure-time cleanup.
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0) this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted))
        } else {
          this.settleResult({ value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted })
        }
      }
    }
    if (!isExit) return
    // `error` is not Node's physical delivery barrier: a queued message may
    // precede `exit`. Admission is already closed, so this final sweep only
    // joins/starts disposal for registry survivors; it deliberately does not
    // repeat explicit provider cancellation.
    for (const [callId, run] of [...this.children]) void this.disposeChild(callId, run)
    this.endStrandedAgents()
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
   * settlement racing the force-settle loses to that already-started external
   * cancellation. The atomic terminal boundaries in {@link onResult} and
   * {@link onWorkerDeath} deliberately exclude teardown callbacks as contenders.
   * Called where the worker can no longer speak (the grace force-settle,
   * worker death, physical exit). When grace/death is the terminal source it
   * runs before settleResult, so already-known pairs precede `workflow/end`;
   * after an earlier Result, exit cleanup may close a survivor afterward.
   * The ledger preserves exactly-once pairing in both orders.
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

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    // Every current terminal source claims ownership before calling here; keep
    // the fallback local so a future caller cannot resolve twice.
    /* v8 ignore next -- defensive fallback outside the claimed state machine */
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
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
