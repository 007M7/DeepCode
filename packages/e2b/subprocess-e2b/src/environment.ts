/** Shared remote-environment scrubbing for E2B process and terminal launchers. */

import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/**
 * Parse an E2B NUL-delimited environment while removing harness-private and credential-shaped names.
 * @param raw - The complete NUL-delimited remote environment.
 * @returns Mutable retained entries for the caller to overlay and serialize.
 */
export function scrubRemoteEnvironment(raw: string): Map<string, string> {
  const environment = new Map<string, string>()
  for (const entry of raw.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    if (name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    environment.set(name, entry.slice(separator + 1))
  }
  return environment
}

/**
 * Overlay explicit entries and serialize one validated E2B environment.
 * @param raw - The complete NUL-delimited remote environment.
 * @param explicit - Deliberate caller overrides applied after ambient scrubbing.
 * @returns NUL-delimited `name=value` entries accepted by `env -i`.
 */
export function serializeRemoteEnvironment(
  raw: string,
  explicit: Readonly<Record<string, string>> | undefined,
): string {
  const environment = scrubRemoteEnvironment(raw)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('subprocess-e2b: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    environment.set(name, value)
  }
  return [...environment].map(([name, value]) => `${name}=${value}\0`).join('')
}
