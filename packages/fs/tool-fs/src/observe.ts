/**
 * The contained `fs/observed` emit shared by the `read`/`write`/`edit` tools.
 *
 * `fs/observed` fires AFTER a mutation/read already succeeded, so a throwing
 * listener must never turn the completed operation into an `isError` result
 * (the tool registry catches a tool throw into an error result). The event
 * contract requires a synchronous, side-effect-only listener (the policy
 * plugin's is a `WeakMap.set`); this try/catch is the synchronous backstop —
 * it logs and swallows a listener bug, mirroring the fire-and-forget pattern in
 * the agent loop. It is NOT async-error containment: cordis `emit` does not
 * await listener promises, so async observation does not belong on this event.
 *
 * @module @deepseek-ai/dsh-tool-fs/observe
 */

import type { Context } from 'cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'

/**
 * Emit `fs/observed` for a just-completed read/write/edit, containing any
 * synchronous listener throw so the already-successful operation still reports
 * success.
 */
export function emitObserved(ctx: Context, target: FsTarget, version: FsVersion, actor: object | undefined): void {
  try {
    ctx.emit('fs/observed', target, version, actor)
  } catch (error: unknown) {
    // Contained: the read/write/edit already succeeded. An `fs/observed` listener
    // MUST be synchronous and side-effect-only; a synchronous bug is logged and
    // swallowed so a recording failure never fails the completed operation.
    ctx.logger.warn(`fs/observed listener threw for "${target.displayPath}": ${String(error)}`)
  }
}
