/**
 * Service Definition for the `ctx.bash` capability seam, covering foreground commands and background process
 * handles. Task ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-tasks`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-bash
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from './types.ts'

/**
 * Settings namespace of this capability, owned here rather than by either
 * executor family because it names the capability, not an implementation: a
 * host composes exactly one provider of `ctx.bash` (the win32 layer swaps the
 * POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate
 * service registration), so the providers share one namespace without ever
 * registering it twice, and a settings document carried between platforms
 * keeps resolving on both.
 */
export const BASH_SETTINGS_NAMESPACE = settingsNamespace('bash')

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  BashExecRequest,
  BashExecSpec,
  BashProcess,
  BashProcessRead,
  BashProcessStatus,
  BashRunResult,
  BashSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'

declare module '@deepseek-ai/cordis' {
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
 * Implementations must honor these semantics:
 * - {@link run} rejects only for infrastructure failures. Nonzero exits,
 *   timeout kills, and abort kills resolve with a {@link BashRunResult}.
 * - {@link start} returns immediately; no timeout applies to background
 *   processes. `done` settles at process close and never rejects; spawn
 *   failures settle as `killed` with the error on stderr.
 * - {@link BashProcess.readOutput} is incremental: consecutive reads never
 *   repeat output. Lossy reads report truncation and available spill files.
 * - A still-running background process is stopped and awaited when its
 *   owning composition tears down. With the subprocess seam that
 *   boundary is `ctx.subprocess` disposal, so a background process survives
 *   an executor-only reload.
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
