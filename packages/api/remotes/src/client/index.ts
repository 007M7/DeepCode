/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@deepseek-ai/cordis'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import type { TypeRTClientRemote } from '@deepseek-ai/dsh-type-meta'

export type { TypeRTClientRemote as ClientRemote } from '@deepseek-ai/dsh-type-meta'
export type {} from '@deepseek-ai/dsh-goal/remote'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypeRTRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@deepseek-ai/dsh-commands/types'
export type {} from '@deepseek-ai/dsh-credentials/types'
export type {} from '@deepseek-ai/dsh-settings/types'
/**
 * The Gateway Client face's own declaration merges, type-only: the internal
 * `remote/host-event` delivery event a carrier owner emits and the Remote
 * service subscribes to. Erased at emit, so this facade still carries no
 * runtime edge to the Gateway implementation.
 */
export type {} from '@deepseek-ai/dsh-api-gateway/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: TypeRTClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await ctx.remote.$mount(goalsRemote)
}
