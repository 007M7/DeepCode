/**
 * The subprocess seam (`ctx.subprocess`): spawn fully-specified commands into
 * managed process trees with Node-shaped stdio dispositions — raw pipes for
 * protocol streams, inherit for diagnostics, bounded spill-backed collection
 * for batch output — plus tree-scoped signalling and a cooperative dispose
 * ladder. Command defaulting, shell semantics, deadlines, framing, and
 * presentation belong to consumers; the bash executor seam is the owning
 * template. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from 'cordis'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessDisposeGraces,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * The ambient parent environment minus credential-shaped names and minus all
 * `DSH_*` names — the canonical base every harness child starts from. `PATH`,
 * `HOME`, locale, and proxy variables survive, so child CLIs run normally;
 * harness identity never leaks implicitly (a child that needs current `DSH_*`
 * facts receives them through {@link SubprocessSpawnSpec.dshEnv}, and a
 * deliberately forwarded credential goes through an explicit env layer, which
 * merges after this scrub). Exported as a plain function so spawners that
 * cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  return env
}

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
 *   process close with exit facts and rejects only for spawn-level failures.
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.kill} signals without escalation,
 *   {@link SubprocessHandle.terminate} (and the spec's abort signal) escalates
 *   SIGTERM→grace→SIGKILL, and {@link SubprocessHandle.dispose} runs the
 *   cooperative EOF-first ladder — all tree-scoped on every platform.
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 */
export abstract class SubprocessService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export default SubprocessService
