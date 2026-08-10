/** Package-owned invariant companion for `@deepseek-ai/dsh-api-remotes`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { API_REMOTE_FORWARDED_EVENTS } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-remotes'

/** Cordis companion plugin name. */
export const name = 'api-remotes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The allowlist as a lookup over the live dispatch stream's plain event names. */
const FORWARDED_EVENTS: ReadonlySet<string> = new Set(API_REMOTE_FORWARDED_EVENTS)

/**
 * Judge one observed dispatch of an allowlisted event against what verbatim
 * forwarding can carry. The Host face's `TypeRTForwardableEvent` assertion
 * judges each name's DECLARED signature; only the dispatch stream shows how a
 * producer actually emitted it, and neither deviation below is visible to the
 * compiler. A Scope carrier would be silently dropped on the way to a consumer
 * because `ctx.remote.$on` has no scoped form, and a waterfall or bail dispatch
 * expects a return value that a one-way carrier can never deliver back.
 * @param mode - dispatch mode reported by the event bus.
 * @param event - dispatched event name.
 * @param carrier - the dispatch `this`; `null` when the event is unscoped.
 * @param fail - reporter bound to this package.
 */
function validateDispatch(mode: string, event: string, carrier: unknown, fail: InvariantFailure): void {
  if (!FORWARDED_EVENTS.has(event)) return
  if (carrier !== null) {
    fail(`forwarded host event "${event}" was dispatched with a Scope carrier, which consumers can never receive`)
  }
  if (mode !== 'emit') {
    fail(`forwarded host event "${event}" was dispatched as "${mode}", but forwarding to consumers is one-way`)
  }
}

/** Install the forwarded-event dispatch-shape check over the live event bus. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (mode, event, _args, thisArg) => {
    validateDispatch(mode, event, thisArg, fail)
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
