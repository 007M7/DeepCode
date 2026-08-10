/**
 * The one home of this application's forwarded-Host-event allowlist, listed in
 * `tsconfig.host.json` AND `tsconfig.client.json` so the Host forwarding loop
 * and the consumer `ctx.remote.$on` key face read the same declaration instead
 * of two copies that could drift.
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

/**
 * Host events this application forwards to consumers verbatim: no projection,
 * no redaction, no renaming. The wire name is the Host cordis event name and
 * the payload is its argument list, so this array is simultaneously the whole
 * control point over what a consumer can receive and the legal key set of
 * `ctx.remote.$on`. Forwarding one more event is an entry here and nothing
 * else.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  'commands/change',
  'credentials/updated',
  'settings/document-updated',
] as const

/** Type projection of the allowlist; the consumer and the Host read this one. */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]

declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
