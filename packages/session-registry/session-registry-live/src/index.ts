/**
 * Publishes every live session in this process into the cross-process session
 * registry, so `dsh list-sessions` lists sessions a server creates on demand rather than
 * only the one a launcher minted up front.
 *
 * Mounted in a composition whose sessions come and go — the browser UI creates
 * one per conversation — this plugin follows `session/created` and
 * `session/disposed` instead of registering a single launcher-known identity.
 * A session with no `cwd` in its header is skipped: the registry's workspace
 * column would have nothing truthful to show, and a subagent child is exactly
 * that case. Titles are mirrored into the record as `session/title` events
 * arrive, so a reader never has to parse a backend's log format.
 * @module @deepseek-ai/dsh-session-registry-live
 */

import type { Context } from 'cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Empty type imports carry the Context merges this plugin relies on: the
// `sessionRegistry` service and the `session/title` session event.
import type {} from '@deepseek-ai/dsh-session-registry'
import type {} from '@deepseek-ai/dsh-session-title'

/** Cordis plugin name. */
export const name = 'session-registry-live'

/** Services required before sessions can be followed and records published. */
export const inject = ['sessions', 'sessionRegistry']

/**
 * Follow session lifecycle and keep the registry in step.
 * @param ctx - context carrying the session store and the registry service.
 */
export function apply(ctx: Context): void {
  /**
   * Per-session registration state. `'disposing'` is a tombstone written when a
   * session ends while its registration is still in flight: without it the
   * late-arriving disposer would be stored for a session that no longer exists
   * and its record would outlive the session until a pid-based prune.
   */
  const registered = new Map<Session, (() => Promise<void>) | 'disposing'>()

  const publish = (session: Session): void => {
    const cwd = session.header.cwd
    // A session without a workspace has no listable location; skipping keeps the
    // registry free of rows `dsh list-sessions` could not render truthfully.
    if (cwd === undefined) return
    void ctx.sessionRegistry.register({ sessionId: session.id, cwd })
      .then((dispose) => {
        if (registered.get(session) === 'disposing') {
          registered.delete(session)
          void dispose()
          return
        }
        registered.set(session, dispose)
      })
      .catch((error: unknown) => {
        registered.delete(session)
        ctx.logger.warn('failed to publish session %s: %s', session.id, String(error))
      })
  }

  for (const session of ctx.sessions.list()) publish(session)
  ctx.on('session/created', (session) => { publish(session) }, { global: true })
  ctx.on('session/disposed', (session) => {
    const entry = registered.get(session)
    if (typeof entry === 'function') {
      registered.delete(session)
      void entry()
      return
    }
    // Registration is still in flight; leave a tombstone for it to observe.
    registered.set(session, 'disposing')
  }, { global: true })

  // Mirror title revisions onto the record. A title arrives after registration
  // and may be replaced, so the listing tracks the latest logged value.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'session/title') return
    const { title } = event.data
    void ctx.sessionRegistry.retitle(session.id, title).catch((error: unknown) => {
      ctx.logger.warn('failed to retitle %s: %s', session.id, String(error))
    })
  }, { global: true })
}
