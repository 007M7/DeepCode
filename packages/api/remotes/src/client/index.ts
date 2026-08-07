/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from 'cordis'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import type { TypeRTClientApi } from '@deepseek-ai/dsh-type-meta'

export type { TypeRTClientApi as ClientApi } from '@deepseek-ai/dsh-type-meta'
export type {} from '@deepseek-ai/dsh-goal/remote'

declare module 'cordis' {
  interface Context {
    /** Generated direct Remote namespaces selected by this Client assembly. */
    api: TypeRTClientApi
  }
}

/** Required service: the typed Client API contribution mount. */
export const inject = ['api']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 */
export function apply(ctx: Context): void {
  ctx.api.mount(goalsRemote)
}
