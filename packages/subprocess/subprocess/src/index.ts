/**
 * The subprocess seam (`ctx.subprocess`): spawn fully-specified
 * commands into managed process groups with bounded, spill-backed output and
 * escalated kills. Command defaulting, shell semantics, deadlines, and
 * presentation belong to consumers — the bash executor seam is the owning
 * template. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from 'cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    subprocess: SubprocessService
  }
}

/**
 * Abstract subprocess service. Subclass, implement {@link spawn}, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - {@link spawn} returns immediately with a live handle; `done` resolves at
 *   process close and rejects only for spawn-level failures.
 * - Output readers are offset-based and non-consuming, so independent readers
 *   never consume one another's output; lossy reads report truncation and the
 *   spill file holding the complete stream when one exists.
 * - {@link SubprocessHandle.kill} and the spec's abort signal escalate
 *   SIGTERM→grace→SIGKILL across the whole process group.
 * - Disposal kills all still-running managed processes and awaits their exit.
 */
export abstract class SubprocessService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, limits, grace, cancellation, and environment.
   * @returns the live process handle (readers, kill, outcome promise).
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export default SubprocessService
