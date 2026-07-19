/** Snapshot-aware application configuration path selection. @module @deepseek-ai/dsh-app-boot/config-path */

import { basename, dirname, resolve } from 'node:path'

/**
 * Resolve the config to boot. Replay swaps a `cordis.yml` basename for
 * `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
 * @param configPath - requested config path, absolute or relative to `cwd`.
 * @param snapshotMode - bin `$DSH_SNAPSHOT`; only `replay` swaps the basename.
 * @param cwd - base for a relative `configPath`.
 * @returns the absolute path of the config to boot.
 */
export function resolveConfigPath(
  configPath: string,
  snapshotMode: string | undefined,
  cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}
