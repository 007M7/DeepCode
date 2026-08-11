/**
 * Launcher-side telemetry wiring: resolve consent and send one fire-and-forget
 * event around each dsh-sdk command. Best-effort — never affects the command's
 * outcome or exit code.
 *
 * @module @deepseek-ai/dsh-scripts/telemetry
 */

import {
  TelemetryReporter,
  buildTelemetryPayload,
  resolveTelemetryConsent,
  type ConsentDecision,
} from '@deepseek-ai/dsh-telemetry'

/** One command's telemetry lifecycle facts. */
export interface CommandTelemetryEvent {
  /** The dsh-sdk command that ran. */
  command: string
  /** Project directory whose `cordis.yml` and `package.json` may be reported. */
  cwd: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Whether the command completed without error. */
  success: boolean
}

/** Injectable consent and delivery hooks for tests. */
export interface CommandTelemetryDeps {
  /**
   * Consent frozen from the launching environment before the command ran. When
   * present it is authoritative: the environment a command mutated cannot grant
   * or revoke reporting.
   */
  consent?: ConsentDecision
  resolve?: () => ConsentDecision | Promise<ConsentDecision>
  reporter?: Pick<TelemetryReporter, 'report' | 'flush'>
}

/**
 * Freeze launcher telemetry consent from the launching environment before any
 * command runs. A command may load a project `.env` or mutate `process.env`, so
 * resolving consent afterwards would let project files or project code enable
 * reporting of their own configuration. An unsupported mode denies rather than
 * throwing, because telemetry may never change a command's result.
 * @param env - Environment containing `DSH_TELEMETRY_MODE`; defaults to `process.env`.
 * @returns The consent decision to apply after the command finishes.
 */
export function freezeTelemetryConsent(env: NodeJS.ProcessEnv = process.env): ConsentDecision {
  try {
    return resolveTelemetryConsent(env)
  } catch {
    return { allowed: false, reason: 'DISABLED' }
  }
}

/**
 * Assemble and send one telemetry event when consent allows, draining in-flight
 * sends before returning. Swallows every error so telemetry can never change a
 * command's result.
 * @param event - the command lifecycle facts.
 * @param deps - Consent and delivery hooks; defaults hit the real endpoint. Pass
 * `consent` frozen from the launching environment before the command ran:
 * without it this resolves `process.env` as it stands now, which a project
 * `.env` or project code may already have changed.
 */
export async function reportCommandTelemetry(
  event: CommandTelemetryEvent,
  deps: CommandTelemetryDeps = {},
): Promise<void> {
  try {
    const consent = deps.consent ?? await resolveDeferredConsent(deps)
    /* v8 ignore next -- v8 mis-accounts this early return's implicit else; both outcomes are asserted */
    if (!consent.allowed) return
    const payload = await buildTelemetryPayload({
      command: event.command,
      durationMs: event.durationMs,
      success: event.success,
      projectDir: event.cwd,
    })
    /* v8 ignore next -- the production TelemetryReporter is exercised by the built-bin smoke */
    const reporter = deps.reporter ?? new TelemetryReporter()
    reporter.report(payload, consent)
    await reporter.flush()
  } catch {
    // Telemetry is best-effort; a consent, payload, or delivery fault never reaches the command.
  }
}

/**
 * Resolve consent for a caller that supplied no frozen decision, reading the
 * environment as it stands after the command ran.
 * @param deps - the caller's consent hooks.
 * @returns the resolved consent decision.
 */
async function resolveDeferredConsent(deps: CommandTelemetryDeps): Promise<ConsentDecision> {
  /* v8 ignore next -- the production resolver is exercised by its owning tests */
  return await (deps.resolve?.() ?? resolveTelemetryConsent())
}
