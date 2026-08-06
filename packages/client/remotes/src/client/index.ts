/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-host-api-gateway/client'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'

export type { ClientApi } from '@deepseek-ai/dsh-host-api-gateway/client'
export type {} from '@deepseek-ai/dsh-goal/remote'

/** Required service: the typed Client API contribution mount. */
export const inject = ['api']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 */
export function apply(ctx: Context): void {
  ctx.api.mount(goalsRemote)
}
