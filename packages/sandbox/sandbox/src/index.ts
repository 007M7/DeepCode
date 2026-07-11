/**
 * The process-sandbox seam (`ctx.sandbox`): an abstract service defining what platform
 * confinement does — wrap a subprocess argv so it executes under a file-effect policy —
 * without saying how.
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * File-effect policy a sandbox backend enforces on confined processes.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * How completely the selected backend enforces a confined mode's file effects.
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
   * How the RUNNER ITSELF failing identifies itself: case-insensitive stderr substrings
   * produced when the sandbox binary is missing, refuses its profile, or fails closed before
   * exec'ing the command (`bwrap: `, `landlock-run: `, `sandbox-exec: ` — each covers both the
   * runner's own error prefix and the shell's runner-not-found message).
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
 * Abstract process-sandbox service. Subclass, implement {@link confine}, and load the subclass
 * as a plugin — it registers as `ctx.sandbox` (one implementation per context; loading a
 * second throws, cordis' standard duplicate-service behavior).
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
