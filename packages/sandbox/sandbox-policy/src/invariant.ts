/** Package-owned session-event invariants for sandbox policy. @module @deepseek-ai/dsh-sandbox-policy/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SANDBOX_MODES } from './session-mode.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-sandbox-policy'

/** Cordis companion plugin name. */
export const name = 'sandbox-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install validation for the durable sandbox-mode vocabulary. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    if (event.type === 'sandbox/mode' && !SANDBOX_MODES.includes(event.data.mode)) {
      fail(`sandbox/mode carries unknown mode ${JSON.stringify(event.data.mode)}`)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
