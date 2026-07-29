/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-registry`.
 * @module @deepseek-ai/dsh-session-registry/invariant
 */

import type { Context } from 'cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionRegistryRecord } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-registry'

/** Cordis companion plugin name. */
export const name = 'session-registry-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Cross-check every published listing against the relations the seam contract
 * owns: a session id identifies at most one live record, and each listed record
 * carries the identity fields a reader must be able to trust. Only a backend's
 * mutation path can break either, so the check wraps the authoritative read
 * rather than inspecting any medium.
 *
 * Liveness itself is deliberately not re-probed here. A backend derives it at
 * read time, so a second probe would race the first and report a process that
 * exited in between as a violation of a contract the seam never made.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const service = ctx.sessionRegistry
  const listed = service.list.bind(service)
  ctx.effect(() => {
    service.list = async (): Promise<SessionRegistryRecord[]> => {
      const records = await listed()
      const seen = new Set<string>()
      for (const record of records) {
        if (seen.has(record.sessionId)) {
          fail(`session ${record.sessionId} appears in more than one live registry record`)
        }
        seen.add(record.sessionId)
        // A record a reader cannot attribute to a process is unusable: `dsh list-sessions`
        // renders the pid and derives liveness from it.
        if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
          fail(`listed session ${record.sessionId} carries unusable pid ${String(record.pid)}`)
        }
      }
      return records
    }
    return () => { service.list = listed }
  })
}, { inject: ['sessionRegistry'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
