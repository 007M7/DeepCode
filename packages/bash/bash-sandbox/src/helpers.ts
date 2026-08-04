/**
 * Internal sandbox-result classification helpers.
 *
 * @module @deepseek-ai/dsh-bash-sandbox/helpers
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import type { BashRunResult } from '@deepseek-ai/dsh-bash'
import type { RunnerFailureRule } from '@deepseek-ai/dsh-sandbox'

/** Spawn codes that can describe an unavailable executable. */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT', 'ENOEXEC', 'ENOTDIR', 'EPERM'])

/** Whether one resolved path is a regular executable file. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Require positive runner evidence instead of treating every spawn rejection
 * as sandbox-owned. Node uses the same ENOENT/EACCES channel for unrelated
 * launch failures, so the provider executable must also be absent or unusable.
 * @param error - the original spawn rejection.
 * @param runnerProgram - provider argv[0], the executable that establishes confinement.
 * @param workdir - the spawn cwd, used to resolve relative executable paths.
 * @param searchPath - the spawn environment's PATH value.
 * @returns whether the rejection has executable-specific runner evidence.
 */
export function isRunnerSpawnFailure(
  error: unknown,
  runnerProgram: string | undefined,
  workdir: string,
  searchPath: string | undefined,
): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code) || runnerProgram === undefined) return false

  const isPath = runnerProgram.includes('/') || runnerProgram.includes('\\')
  const pathEntries = isPath ? [''] : searchPath?.split(delimiter) ?? []
  if (pathEntries.length === 0) return false
  return pathEntries.every((entry) => {
    const candidate = isPath
      ? resolve(workdir, runnerProgram)
      : resolve(workdir, entry.length > 0 ? entry : '.', runnerProgram)
    return !isExecutableFile(candidate)
  })
}

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
    // An empty or whitespace-only substring is not meaningful runner evidence.
    // Ignore it while keeping any valid signatures beside it active.
    const fatalSignatures = rule.fatalSignatures
      .filter(signature => signature.trim().length > 0)
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
