/**
 * Internal sandbox-result classification helpers.
 *
 * @module @deepseek-ai/dsh-bash-sandbox/helpers
 */

import type { BashRunResult } from '@deepseek-ai/dsh-bash'
import type { RunnerFailureRule } from '@deepseek-ai/dsh-sandbox'

/** Fatal runner evidence retained for infrastructure-error detail. */
interface RunnerFailureMatch {
  /** The original stderr line that matched a fatal signature. */
  detail: string
}

/**
 * Classify a failed run against the selected backend's denial dialect.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @returns whether the failed run matches that denial dialect.
 */
export function classifyDenial(result: BashRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * Classify one settled process against the selected backend's structured
 * runner-failure rules. Each rule requires a nonzero exit, its optional
 * exit-code gate, and a fatal signature on one stderr line after exact
 * informational lines are excluded.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text, left unchanged.
 * @param rules - structured runner-failure rules from the active wrap.
 * @returns the first matching fatal line, or undefined when evidence is insufficient.
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): RunnerFailureMatch | undefined {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = stderr.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informationalLines = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()))
    // An empty substring matches every string in JavaScript. Ignore it so a
    // malformed public rule cannot turn a gated exit status into evidence by
    // itself; keep any valid signatures beside it active.
    const fatalSignatures = rule.fatalSignatures
      .filter(signature => signature.length > 0)
      .map(signature => signature.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informationalLines.has(lowered)) continue
      if (fatalSignatures.some(signature => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/**
 * Match a non-zero exit against case-insensitive stderr signatures.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text.
 * @param signatures - substrings identifying the selected backend's dialect.
 * @returns whether this is a non-zero exit whose stderr matches a signature.
 */
export function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}
