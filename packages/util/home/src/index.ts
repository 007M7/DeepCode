/**
 * Canonical DeepSeek Harness home-directory resolution.
 *
 * @module @deepseek-ai/dsh-home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_DSH_HOME_DIRNAME = '.dsh'

/** Environment variable that overrides the default Harness home directory. */
export const DSH_HOME_ENV = 'DSH_HOME' as const

/**
 * Resolve the DeepSeek Harness home directory without caching or mutating the environment.
 *
 * @param configured - Optional configured path, which takes precedence over the environment.
 * @returns The absolute configured path, `$DSH_HOME`, or `~/.dsh`, in that order.
 */
export function resolveDshHome(configured?: string): string {
  return resolve(configured ?? process.env[DSH_HOME_ENV] ?? join(homedir(), DEFAULT_DSH_HOME_DIRNAME))
}
