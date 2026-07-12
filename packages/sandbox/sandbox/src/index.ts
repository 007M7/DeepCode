/**
 * The process-sandbox seam (`ctx.sandbox`): an abstract service defining WHAT
 * platform confinement does — wrap a subprocess argv so it executes under a
 * file-effect policy — without saying HOW. Implementations subclass
 * {@link SandboxProvider} and register as the `sandbox` service;
 * `@deepseek-ai/dsh-sandbox-local` (per-platform chains: Linux `bwrap` then the
 * npm-distributed `landlock-run` launcher, macOS `sandbox-exec`/Seatbelt) is
 * the first.
 * Consumers hand over the exact argv they are about to spawn
 * (`@deepseek-ai/dsh-bash-sandbox` wraps `['bash', '-c', command]`; a
 * subagent backend wraps its child-agent argv) and spawn the returned argv
 * instead.
 *
 * The seam confines SAME-WORLD subprocesses only: a backend shares the
 * host's filesystem and kernel, and the policy's `workspaceRoot` names a
 * real host path. Containers, microVMs, and remote executors are NOT
 * backends of this seam — they are sibling implementations of whole
 * capability seams (`ctx.bash`, `ctx.fs`), deployed as environment-coherent
 * groups; the boundary is recorded in
 * docs/rfc/implemented/feature/2026-07-06-sandbox.md.
 *
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * File-effect policy a sandbox backend enforces on confined processes.
 *
 * - `read-only` — the process cannot write the filesystem anywhere; a
 *   write-shaped `/dev/null` sink stays available so `>/dev/null` redirects
 *   keep working (HOW is the backend's choice: bwrap mounts a fresh `/dev`,
 *   the Landlock launcher and Seatbelt grant the single `/dev/null` node).
 * - `workspace-write` — writes are allowed only under the policy's
 *   workspace root and `/tmp`; everything else stays read-only. Which `/tmp`
 *   is backend-specific — an ephemeral mount under bwrap, the HOST `/tmp`
 *   under the Landlock launcher, the host `/private/tmp` plus the per-user
 *   darwin temp dir under Seatbelt: the seam promises the write boundary,
 *   not the mount's nature.
 * - `danger-full-access` — no confinement; a consumer configured with it
 *   spawns its argv unwrapped and never calls the provider.
 *
 * The mode governs FILE effects only: network and process visibility are not
 * restricted (a backend that cannot honestly enforce them must not pretend
 * to). How completely the file effects themselves are enforced is likewise a
 * reported fact, not an assumption — see {@link SandboxEnforcement}.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * How completely the selected backend enforces a confined mode's file
 * effects.
 *
 * - `full` — every file effect the mode promises to block is governed: the
 *   `bwrap` mount profile, a Landlock kernel enforcing the launcher's whole
 *   ruleset, or an operator-configured runner (configuring one asserts full
 *   enforcement along with existence).
 * - `partial` — the backend is active but the kernel governs only the subset
 *   of accesses its ABI knows (an older Landlock ABI: path-based truncate is
 *   ungoverned before ABI v3), so a file effect the mode promises to block
 *   may still land. A caller that needs the mode's promise to be absolute
 *   must treat `partial` as outside that promise.
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is the consumer's
 * explicit step (its config owns the fallback chain); the provider treats
 * the policy as fully specified.
 */
export interface SandboxPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
}

/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
export interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * How the RUNNER ITSELF failing identifies itself: case-insensitive stderr
   * substrings produced when the sandbox binary is missing, refuses its
   * profile, or fails closed before exec'ing the command (`bwrap: `,
   * `landlock-run: `, `sandbox-exec: ` — each covers both the runner's own
   * error prefix and the shell's runner-not-found message). ORTHOGONAL to
   * {@link denialSignatures}: a denial is the confined COMMAND being blocked
   * (the sandbox working as designed); a runner failure means the command
   * NEVER RAN and must surface as a sandbox failure, not a task failure —
   * consumers check these signatures FIRST (a runner's own error text may
   * contain denial words, e.g. an unopenable grant root reporting
   * `Permission denied`).
   */
  runnerFailureSignatures: readonly string[]
}

/**
 * Error `code` carried by the infrastructure error a provider throws when a
 * confined policy is requested but no backend is available or usable on this
 * host: confinement FAILS CLOSED (refuses to run) rather than silently
 * executing unconfined. Thrown as a `HarnessError`, it reaches the model
 * through the structured `{ name, code }` error channel on `tool/result`, so
 * callers can distinguish "the sandbox is missing" from a failing command.
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * Thrown by {@link SandboxProvider.confine} when a confined policy is
 * requested but no backend is usable on this host: confinement fails closed.
 * Carries the {@link SANDBOX_UNAVAILABLE} code through the structured
 * `{ name, code }` error channel.
 */
export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing '
      + 'kernel (Linux), ensure sandbox-exec is usable (macOS) — Windows has no confinement '
      + 'backend yet — or switch the consumer to danger-full-access.'
      + (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

declare module 'cordis' {
  interface Context {
    sandbox: SandboxProvider
  }
}

/**
 * Abstract process-sandbox service. Subclass, implement {@link confine}, and
 * load the subclass as a plugin — it registers as `ctx.sandbox` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link confine} either returns an argv whose runner ENFORCES the policy
 *   or fails closed — at `confine` time with {@link SandboxUnavailableError}
 *   (no backend for this host), or at EXECUTION time by the runner itself
 *   refusing to run the command (exiting without exec'ing it, identified by
 *   {@link ConfinedArgv.runnerFailureSignatures}). A silent unconfined
 *   passthrough is never a legal outcome on either path.
 * - Probing exists to ARBITRATE between multiple candidate backends and may
 *   be skipped when a platform has exactly one: the sole candidate is
 *   selected directly and the runner's exec-time fail-closed refusal carries
 *   the safety property. When probing does run, it is functional (actually
 *   enforcing a profile, not a version check), at most once per provider
 *   lifetime; `confine` itself spawns nothing beyond that one-time probing.
 * - The returned {@link ConfinedArgv.enforcement} states the backend's
 *   actual completeness for THIS host; `partial` is reported, never silently
 *   upgraded to `full`.
 */
export abstract class SandboxProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * Wrap `argv` so it executes confined under `policy` on this host; the
   * caller spawns the returned argv in place of its own.
   * @param argv - the exact argv the caller is about to spawn (program plus
   *   arguments), NOT a shell string — a shell-shaped consumer passes
   *   `['bash', '-c', command]`.
   * @param policy - the file-effect policy this execution runs under,
   *   carried per call (see {@link SandboxPolicy}).
   * @returns the argv to spawn instead, plus the enforcement completeness
   *   the selected backend achieves for it.
   */
  abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}

export default SandboxProvider
