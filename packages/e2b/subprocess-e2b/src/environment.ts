/** Shared remote-environment scrubbing for E2B process and terminal launchers. */

import { Buffer } from 'node:buffer'
import type { Sandbox } from '@deepseek-ai/dsh-e2b'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Read the remote environment through ASCII base64 so SDK callback chunking cannot corrupt UTF-8.
 * @param sandbox - shared E2B execution world.
 * @param signal - optional cancellation for the control-plane request.
 * @returns the complete NUL-delimited UTF-8 environment.
 */
export async function readRemoteEnvironment(sandbox: Sandbox, signal?: AbortSignal): Promise<string> {
  const result = await sandbox.commands.run(
    'set -o pipefail; env -0 | base64 -w 0',
    signal === undefined ? {} : { signal },
  )
  const encoded = result.stdout.trim()
  if (!BASE64.test(encoded)) throw new Error('subprocess-e2b: remote environment transport returned invalid base64')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'))
  } catch (error: unknown) {
    throw new Error('subprocess-e2b: remote environment is not valid UTF-8', { cause: error })
  }
}

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
