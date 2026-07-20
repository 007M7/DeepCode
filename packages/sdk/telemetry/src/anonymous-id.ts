/**
 * Per-machine anonymous telemetry id.
 *
 * The id is a random UUID persisted in a per-user GLOBAL config file — never in
 * the project, and never derived from the git remote, repository URL, or any
 * other identifying source (a derived id would make "anonymous" a fiction). The
 * same id is reused across projects on one machine so telemetry counts machines,
 * not repositories.
 *
 * @module @deepseek-ai/dsh-telemetry/anonymous-id
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A machine-scoped anonymous telemetry id (random UUID v4). */
export type AnonymousId = Branded<'AnonymousId'>

/** Config directory name owned by the DeepSeek Harness across tools. */
const CONFIG_NAMESPACE = 'deepseek-harness'

/** Default file, inside the global config dir, storing the anonymous id. */
export const ANONYMOUS_ID_FILE_NAME = 'telemetry.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ambient seams for locating and generating the id; every field has a default. */
export interface AnonymousIdOptions {
  /** Environment consulted for `DSH_CONFIG_HOME`/`XDG_CONFIG_HOME`/`APPDATA`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Platform string used to pick the Windows path; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Home directory resolver; defaults to `os.homedir`. */
  homeDir?: () => string
  /** UUID generator; defaults to `crypto.randomUUID` (test seam). */
  randomUUID?: () => string
}

/**
 * Resolve the per-user global config directory for harness tooling.
 * Precedence: `DSH_CONFIG_HOME` (explicit override) > `XDG_CONFIG_HOME` >
 * platform default (`%APPDATA%` on Windows, else `~/.config`).
 * @param options - environment, platform, and home-directory seams.
 * @returns absolute config directory path for the harness namespace.
 */
export function globalConfigDir(options: AnonymousIdOptions = {}): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.homeDir ?? homedir
  if (env.DSH_CONFIG_HOME !== undefined && env.DSH_CONFIG_HOME.length > 0) return env.DSH_CONFIG_HOME
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, CONFIG_NAMESPACE)
  }
  if (platform === 'win32' && env.APPDATA !== undefined && env.APPDATA.length > 0) {
    return join(env.APPDATA, CONFIG_NAMESPACE)
  }
  return join(home(), '.config', CONFIG_NAMESPACE)
}

/** Read a valid persisted id from the store, or `undefined` when absent/corrupt. */
async function readPersistedId(file: string): Promise<AnonymousId | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // Absent or unreadable: the caller mints and persists a fresh id.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Corrupt JSON: the caller overwrites the store with a fresh id.
    return undefined
  }
  if (parsed !== null && typeof parsed === 'object') {
    const value = (parsed as Record<string, unknown>).anonymousId
    if (typeof value === 'string' && UUID_PATTERN.test(value)) return value as AnonymousId
  }
  return undefined
}

/**
 * Return the machine's anonymous id, creating and persisting one on first use.
 * Persistence is best-effort: a write failure still returns a usable id for the
 * current run so telemetry is never blocked by config-dir permissions.
 * @param options - config-location and UUID-generation seams.
 * @returns the stable per-machine anonymous id.
 */
export async function getOrCreateAnonymousId(options: AnonymousIdOptions = {}): Promise<AnonymousId> {
  const file = join(globalConfigDir(options), ANONYMOUS_ID_FILE_NAME)
  const existing = await readPersistedId(file)
  if (existing !== undefined) return existing
  const generate = options.randomUUID ?? randomUUID
  const created = generate() as AnonymousId
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ anonymousId: created }, null, 2)}\n`, 'utf8')
  } catch {
    // Best-effort persistence: return the fresh id even when the store is unwritable.
  }
  return created
}
