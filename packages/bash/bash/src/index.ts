/**
 * The bash executor seam (`ctx.bash`): an abstract service defining WHAT a
 * bash backend does — run foreground commands, start background processes —
 * without saying HOW. Implementations subclass {@link BashExecutor} and
 * register themselves as the `bash` service; `@deepseek-ai/dsh-bash-local`
 * (local subprocesses) is the first. Future implementations swap in
 * sandboxes, containers, or remote exec servers without touching the tool
 * schemas that consume them (`@deepseek-ai/dsh-tool-bash`).
 *
 * The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the
 * surveyed agents: pi hides execution behind a `BashOperations` interface
 * (local shell / SSH / VM backends), Codex behind an exec-server protocol.
 *
 * The seam is deliberately TASK-FREE: `start()` hands back a
 * {@link BashProcess} handle (incremental reads, kill, a quiescence promise)
 * and nothing else. Task ids, owner isolation, polling tools, and completion
 * notices are the generic `ctx.tasks` runtime's job (`@deepseek-ai/dsh-tasks`)
 * — the tool layer adapts the handle into a task registration. This keeps a
 * remote/sandbox executor free of any session or registry dependency.
 *
 * @module @deepseek-ai/dsh-bash
 */

import { Context, Service } from 'cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from './types.ts'

export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'
export type {
  BashExecRequest,
  BashExecSpec,
  BashProcess,
  BashProcessRead,
  BashProcessStatus,
  BashRunResult,
  BashSandboxInfo,
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
 *   processes (callers stop them via {@link BashProcess.kill} or the spec's
 *   AbortSignal). The handle's `done` settles at process close and never
 *   rejects (a spawn failure settles as `killed` with the error readable on
 *   stderr).
 * - {@link BashProcess.readOutput} is incremental: consecutive reads never
 *   re-deliver output. Implementations bound their buffers; reads that lost
 *   data flag `lossy` and point at full-stream spill files when available.
 * - Disposal kills every running background process and awaits their exit
 *   (no orphan processes survive `fiber.dispose()`).
 */
export abstract class BashExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'bash')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
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
   * Start a background process and return its handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the live process handle (reads, kill, quiescence promise).
   */
  abstract start(spec: BashExecSpec): BashProcess
}

export default BashExecutor
