/**
 * Mounts the cross-process live-session registry that `dsh list-sessions` reads, plus the
 * publisher that keeps it in step with this process's sessions.
 *
 * Both plugins mount on the booted app's own context, so records share that
 * fiber's lifetime: an ordinary exit disposes the fiber and deregisters, while a
 * killed process leaves records the next reader prunes by pid. Only top-level
 * surfaces a user launches mount this — in-process subagents have no process of
 * their own, and out-of-process subagent backends spawn `dsh-jsonrpc-agent`
 * rather than this CLI, so neither reaches this path.
 * @module @deepseek-ai/dsh/register-session
 */

import { join } from 'node:path'
import type { Context } from 'cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import SessionRegistryFile from '@deepseek-ai/dsh-session-registry-file'
import * as sessionRegistryLive from '@deepseek-ai/dsh-session-registry-live'

/** Registry root under the Harness home, shared by every surface and by `dsh list-sessions`. */
export const registryRoot = (): string => join(resolveDshHome(), 'run')

/**
 * Publish this process's sessions for the lifetime of `ctx`.
 *
 * Publication follows session lifecycle rather than a launcher-known id, so one
 * path serves every surface identically — the TUI's single session and a
 * server's on-demand ones alike — and titles reach the listing as they are
 * logged.
 *
 * Mounting is best-effort: a registry failure must not take down a working agent
 * session, because the registry is an observability aid rather than part of the
 * agent's contract. Failures warn through the context logger.
 * @param ctx - the booted app context whose lifetime the records share.
 */
export async function registerLiveSessions(ctx: Context): Promise<void> {
  try {
    const scope = ctx.isolate('sessionRegistry')
    await scope.plugin(SessionRegistryFile, { root: registryRoot() })
    await scope.plugin(sessionRegistryLive)
  } catch (error) {
    ctx.logger('dsh').warn('session registry unavailable; `dsh list-sessions` will not list these sessions: %s', String(error))
  }
}
