/**
 * Consent resolution for dsh-sdk launcher telemetry.
 *
 * `DSH_TELEMETRY_MODE` is the shared consent setting for session and launcher
 * telemetry. Only `FULL` permits launcher reporting; unset and empty values
 * resolve to `DISABLED`.
 *
 * @module @deepseek-ai/dsh-telemetry/consent-resolver
 */

/** Why telemetry is or is not permitted for one command. */
export type ConsentReason =
  | 'FULL'
  | 'FEEDBACK_ONLY'
  | 'DISABLED'

/** Resolved telemetry consent for one command invocation. */
export interface ConsentDecision {
  /** Whether telemetry may be sent. */
  allowed: boolean
  /** The signal that determined {@link allowed}. */
  reason: ConsentReason
}

/**
 * Resolve launcher telemetry consent from the shared telemetry mode.
 *
 * Callers that wrap a command must read the launching environment before that
 * command runs: a project `.env` load or project code can change
 * `process.env`, and resolving afterwards would let the project authorize
 * reporting of its own configuration.
 * @param env - Environment containing `DSH_TELEMETRY_MODE`; defaults to `process.env`.
 * @returns Whether launcher telemetry may report and the resolved mode.
 */
export function resolveTelemetryConsent(env: NodeJS.ProcessEnv = process.env): ConsentDecision {
  const mode = env.DSH_TELEMETRY_MODE || 'DISABLED'
  switch (mode) {
    case 'FULL':
      return { allowed: true, reason: 'FULL' }
    case 'FEEDBACK_ONLY':
      return { allowed: false, reason: 'FEEDBACK_ONLY' }
    case 'DISABLED':
      return { allowed: false, reason: 'DISABLED' }
    default:
      throw new Error(`unsupported DSH_TELEMETRY_MODE ${JSON.stringify(mode)}`)
  }
}
