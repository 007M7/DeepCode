/**
 * Derive the working directory a filesystem tool resolves relative paths
 * against: the calling agent's per-session workspace
 * (`exec.agent.session.header.cwd`), so each ACP session's `read`/`write`/`edit`
 * act on ITS workspace, not the server's launch dir — mirroring how
 * `dsh-tool-bash` defaults a bash `workdir` to the session cwd.
 *
 * The `agent` is optional-chained — a non-agent caller yields `undefined`, and
 * the tool then calls `ctx.fs.resolve(path)` with no base so the backend applies
 * its own configured default (preserving the non-ACP / no-session behavior).
 * `session`/`header` are non-optional on a real `Agent`, so only `agent` needs
 * the guard (mirroring `dsh-tool-bash`'s `resolveWorkdir`). Returning `undefined`
 * rather than reading `process.cwd()` here keeps the default in ONE place (the
 * provider), per the "explicit > implicit at seams" convention.
 *
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller (the backend then applies its own default).
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}
