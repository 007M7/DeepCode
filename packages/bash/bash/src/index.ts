/**
 * The bash executor seam (`ctx.bash`): an abstract service defining WHAT a
 * bash backend does — run commands, manage background tasks — without saying
 * HOW. Implementations subclass {@link BashExecutor} and register themselves
 * as the `bash` service; `@deepseek-ai/dsh-bash-local` (local subprocesses)
 * is the first. Future implementations swap in sandboxes, containers, or
 * remote exec servers without touching the tool schemas that consume them
 * (`@deepseek-ai/dsh-tool-bash`).
 *
 * The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the
 * surveyed agents: pi hides execution behind a `BashOperations` interface
 * (local shell / SSH / VM backends), Codex behind an exec-server protocol.
 *
 * @module @deepseek-ai/dsh-bash
 */

import { Context, Service } from 'cordis'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskListener, BashTaskRead } from './types.ts'

export type {
  BashExecRequest,
  BashExecSpec,
  BashRunResult,
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
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.bash` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link run} REJECTS only for infrastructure failures (unusable workdir,
 *   missing shell, pre-aborted signal). Nonzero exits, timeout kills, and
 *   abort kills RESOLVE with a descriptive {@link BashRunResult} — reporting
 *   a failed command is the tool layer's job, not an exception.
 * - {@link start} returns immediately; no timeout applies to background
 *   tasks (callers stop them via {@link kill} or the spec's AbortSignal).
 *   Completion must fire the {@link onTaskDone} listeners exactly once per
 *   task, and must NOT fire after the service is disposed.
 * - {@link readOutput} is incremental: consecutive reads never re-deliver
 *   output. Implementations bound their buffers; reads that lost data flag
 *   `lossy` and point at full-stream spill files when available.
 * - Disposal kills every running task and awaits their exit (no orphan
 *   processes survive `fiber.dispose()`).
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
   * Resolve a caller's {@link BashExecRequest} into a fully-specified
   * {@link BashExecSpec}, applying this implementation's config defaults and
   * caps (working directory, default/max timeout). Consumers (tool layer)
   * call this, then pass the result to {@link run}/{@link start} — keeping
   * defaulting in the implementation that owns the config while the seam type
   * stays explicit (no hidden `?? default` inside run/start).
   */
  abstract resolve(request: BashExecRequest): BashExecSpec

  /** Run a command in the foreground; resolves when it finishes. */
  abstract run(spec: BashExecSpec): Promise<BashRunResult>

  /** Start a background task and return its handle immediately. */
  abstract start(spec: BashExecSpec): BashTask

  /** Look up a background task by id. */
  abstract get(id: string): BashTask | undefined

  /**
   * The opaque OWNER token recorded for a background task at {@link start}
   * (from the {@link BashExecSpec}'s `owner`), or `undefined` for an unknown id
   * OR a known-but-ownerless task. The executor stores and returns the token
   * verbatim — it never interprets it; the access POLICY (who may read/kill a
   * task) lives in the consumer (`@deepseek-ai/dsh-tool-bash`), which compares
   * `ownerOf(id)` to the caller's token. Collapsing unknown-id and
   * known-but-unowned into the same `undefined` is fine: the consumer's access
   * gate treats `undefined` as "open", and a genuinely unknown id then fails
   * loudly at the subsequent {@link readOutput}/{@link kill} ("unknown task").
   * Storing ownership in the executor (disposed with ITS fiber) — not in the
   * tool plugin — is what makes ownership survive a `tool-bash` HMR reload.
   */
  abstract ownerOf(id: string): string | undefined

  /** All tracked background tasks (insertion order). */
  abstract list(): BashTask[]

  /** Read output produced since the previous read. Throws for unknown ids. */
  abstract readOutput(id: string): BashTaskRead

  /**
   * Kill a running background task. Returns false when it had already
   * finished (no-op). Throws for unknown ids.
   */
  abstract kill(id: string): boolean

  /**
   * Register a background-task completion listener (disposed with the
   * calling fiber). Listeners never fire after this service is disposed.
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
