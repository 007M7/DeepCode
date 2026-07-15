/**
 * The `ctx.bash` executor seam for foreground commands and background process
 * handles. Task ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-tasks`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-bash
 */

import { Context, Service } from 'cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import { effectiveSandboxMode } from './session-mode.ts'
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

  interface Events {
    /**
     * Waterfall around {@link BashExecutor.resolveMode}'s base — the session's
     * standing override falling back to the executor's configured default. A
     * policy plugin narrows the resolution per call by clamping `await next()`
     * (a session mode's `access` cap is the shipped example); returning
     * without `next()` replaces the resolution outright. Dispatched only for
     * a confining executor — a never-confining one resolves `undefined`
     * without consulting listeners, so a listener always receives a real
     * base mode from `next()`.
     * @param session - the session the call belongs to (its log carries the
     *   override fold and any mode state a listener clamps by); `undefined`
     *   for a sessionless caller.
     * @mode waterfall
     */
    'bash/resolve-mode'(this: BashExecutor, session: Session | undefined, next: () => Promise<SandboxMode>): Promise<SandboxMode>
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
 * - Disposal kills all running background processes and awaits their exit.
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
   * Resolve the sandbox mode a call for `session` runs under: the session's
   * standing override (the `bash/sandbox-mode` fold) falling back to this
   * executor's configured default, dispatched through the `bash/resolve-mode`
   * waterfall so policy plugins can narrow the base per call — read-time
   * composition over independent folds, nothing written back to any store.
   * Returns `undefined` — without consulting the waterfall — when this
   * executor never confines ({@link sandboxMode} `undefined`): there is no
   * mode to resolve and nothing would honor one. An escalation grant is not
   * this method's business: the tool layer resolves grants separately and
   * stamps them with higher precedence.
   * @param session - the session whose override fold applies; `undefined`
   *   for a sessionless caller (the executor default alone seeds the
   *   waterfall).
   * @returns the effective mode for a confining executor; `undefined` for
   *   one that never confines.
   */
  async resolveMode(session: Session | undefined): Promise<SandboxMode | undefined> {
    const fallback = this.sandboxMode
    if (fallback === undefined) return undefined
    const base = (session === undefined ? undefined : effectiveSandboxMode(session.events)) ?? fallback
    return this.ctx.waterfall(this, 'bash/resolve-mode', session, () => Promise.resolve(base))
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
