/**
 * Derive the working directory a filesystem tool resolves relative paths against: the calling
 * agent's per-session workspace (`exec.agent.session.header.cwd`), so each ACP session's
 * `read`/`write`/`edit` act on ITS workspace, not the server's launch dir — mirroring how
 * `dsh-tool-bash` defaults a bash `workdir` to the session cwd.
 * Non-agent calls return `undefined`, leaving the fallback in the provider rather than reading
 * `process.cwd()` at the tool seam.
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
