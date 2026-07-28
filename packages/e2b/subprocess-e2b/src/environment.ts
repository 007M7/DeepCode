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
