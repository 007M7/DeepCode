/** Package-owned durable mode-stream invariants. @module @deepseek-ai/dsh-mode/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mode'

/** Cordis companion plugin name. */
export const name = 'mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one `mode/set` payload before it reaches the durable log: the mode
 * is a non-empty bare name (config-declared vocabulary, not an opaque id), so
 * an empty or non-string value can only be a writer bug — folding it would
 * silently select the default mode while the log claims otherwise.
 */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'mode/set') return
  const mode = (event.data as { mode?: unknown }).mode
  if (typeof mode !== 'string' || mode.trim() === '' || mode.trim() !== mode) {
    fail(`mode/set carries invalid mode ${JSON.stringify(mode)}; expected a non-empty trimmed name`)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended mode selections. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the mode invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
