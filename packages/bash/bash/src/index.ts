/**
 * The bash executor seam (`ctx.bash`): an abstract service defining what a bash backend does —
 * run commands, manage background tasks — without saying how.
 * @module @deepseek-ai/dsh-bash
 */

import { Context, Service } from 'cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskId, BashTaskListener, BashTaskRead, OwnerToken } from './types.ts'

export { BashTaskId, OwnerToken } from './types.ts'
export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'
export type {
  BashExecRequest,
  BashExecSpec,
  BashRunResult,
  BashSandboxInfo,
  BashTask,
  BashTaskListener,
  BashTaskRead,
  BashTaskStatus,
  CollectedOutput,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    bash: BashExecutor
  }
}

/**
 * Registers one `ctx.bash` implementation. Runtime command failures resolve as
 * {@link BashRunResult}; only infrastructure failures reject. Background starts
 * return immediately without a timeout, report completion exactly once while
 * live, and remain cancellable by signal or {@link kill}. Output reads are
 * incremental and flag lost buffered data; disposal kills and awaits all tasks.
 */
export abstract class BashExecutor extends Service {
  private listeners = new Set<BashTaskListener>()
  private listenersClosed = false

  constructor(ctx: Context) {
    super(ctx, 'bash')
    ctx.effect(() => () => {
      // Close the listener registry before subclass teardown so late task
      // completions (e.g. from kills issued during dispose) stay silent.
      this.listenersClosed = true
      this.listeners.clear()
    }, 'bash listener teardown')
  }

  /**
   * The sandbox mode this executor confines commands under BY DEFAULT, or `undefined` when it
   * does not sandbox at all — the capability fact the tool and ACP layers read to advertise
   * sandbox controls honestly.
   * A session or call may override this default, so widening is evaluated per
   * execution rather than encoded in this getter.
   * @returns the configured default mode of a sandboxing executor;
   *   `undefined` for an executor that never confines.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link run}/{@link start}.
   */
  abstract resolve(request: BashExecRequest): BashExecSpec

  /**
   * Run a command in the foreground; resolves when it finishes.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; nonzero exits, timeout kills, and abort kills
   *   resolve with a descriptive result rather than reject.
   */
  abstract run(spec: BashExecSpec): Promise<BashRunResult>

  /**
   * Start a background task and return its handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the live task handle; completion fires {@link onTaskDone}.
   */
  abstract start(spec: BashExecSpec): BashTask

  /**
   * Look up a background task by id.
   * @param id - the task id to look up.
   * @returns the tracked task, or undefined for an id this executor never issued.
   */
  abstract get(id: BashTaskId): BashTask | undefined

  /**
   * The opaque OWNER token recorded for a background task at {@link start} (from the {@link
   * BashExecSpec}'s `owner`), or `undefined` for an unknown id OR a known-but-ownerless task.
   * The executor stores the token without interpreting policy; keeping it here
   * lets ownership survive a consumer-plugin reload.
   * @param id - the background task id to look up ownership for.
   * @returns the token recorded at start, verbatim; undefined for an unknown
   *   id or a known-but-ownerless task.
   */
  abstract ownerOf(id: BashTaskId): OwnerToken | undefined

  /**
   * All tracked background tasks (insertion order).
   * @returns every task this executor started, running or finished.
   */
  abstract list(): BashTask[]

  /**
   * Read output produced since the previous read. Throws for unknown ids.
   * @param id - the task to read from.
   * @returns the incremental read; consecutive reads never re-deliver output.
   */
  abstract readOutput(id: BashTaskId): BashTaskRead

  /**
   * Kill a running background task. Returns false when it had already
   * finished (no-op). Throws for unknown ids.
   * @param id - the task to kill.
   * @returns true when this call killed it, false when it had already finished.
   */
  abstract kill(id: BashTaskId): boolean

  /**
   * Register a background-task completion listener (disposed with the
   * calling fiber). Listeners never fire after this service is disposed.
   * @param listener - called exactly once per task completion.
   * @returns the disposer that unregisters the listener.
   */
  onTaskDone(listener: BashTaskListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }, 'bash.onTaskDone()')
    return () => void dispose()
  }

  /** For implementations: notify listeners that `task` completed. Listener
   * exceptions are contained (logged) — one bad listener must not reject
   * `BashTask.done` or starve the listeners after it. */
  protected notifyTaskDone(task: BashTask): void {
    if (this.listenersClosed) return
    for (const listener of this.listeners) {
      try {
        listener(task)
      } catch (error: unknown) {
        // Listener bugs are reported, never propagated into task.done.
        console.error('bash onTaskDone listener threw:', error)
      }
    }
  }
}

export default BashExecutor
