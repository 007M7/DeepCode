/**
 * Child working-directory resolution shared by out-of-process subagent
 * backends: a deployment `cwd` override validated at load, else the
 * delegating parent session's workspace cwd validated per start — never the
 * server process's own cwd, because one server process serves many sessions,
 * each with its own workspace.
 *
 * @module @deepseek-ai/dsh-subagent-subprocess/cwd
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * Whether `path` names an existing directory the harness can ENTER. The
 * search-permission probe matters: `statSync().isDirectory()` is true for a
 * mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 */
function isDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // statSync/accessSync throw only filesystem access errors here
    // (ENOENT/EACCES/ENOTDIR/…), and every one of them means the path cannot
    // serve as the child's cwd.
    return false
  }
}

/**
 * Assert `cwd` can actually host the child: absolute (it doubles as the
 * child's workspace identity, and a relative path would be re-anchored to the
 * server process's launch directory) and an existing directory (fail here,
 * before the process boundary, instead of as an ambiguous spawn ENOENT).
 * @param prefix - the consuming plugin's diagnostic prefix (e.g. `subagent-acp`).
 * @param label - which source supplied the value, for the diagnostic.
 * @param cwd - the candidate working directory.
 * @returns `cwd`, validated.
 */
export function assertUsableCwd(prefix: string, label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isDirectory(cwd)) {
    throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/**
 * Validate a configured `cwd` override ONCE, at plugin load: reject the empty
 * string (`path.resolve('')` is the process cwd — it would silently
 * reintroduce the launch-directory fallback this resolution removes),
 * interpret a relative path against the harness launch directory, and require
 * an enterable directory.
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param cwd - the configured override, or `undefined` when the config omits it.
 * @returns the validated absolute override, or `undefined` when omitted.
 */
export function validateConfiguredCwd(prefix: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error(`${prefix}: config cwd must not be empty — omit the key to inherit the parent session cwd`)
  }
  return assertUsableCwd(prefix, 'config cwd', resolve(cwd))
}

/**
 * Resolve the child's working directory at start: the deployment override
 * when configured (already validated at load), else the parent session's
 * workspace cwd (validated here, its earliest resolvable point). Fails loud
 * when neither exists.
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param configured - the load-validated override, or `undefined`.
 * @param parentCwd - the delegating parent session's workspace cwd, if any.
 * @returns the absolute child working directory.
 */
export function resolveChildCwd(prefix: string, configured: string | undefined, parentCwd: string | undefined): string {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) {
    throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`)
  }
  return assertUsableCwd(prefix, 'parent session cwd', parentCwd)
}
