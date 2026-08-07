/** Request-zone derivation shared by time-context rendering and Schedule tools. */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Client-zone facts derived from the user-rpc messages in one open turn. */
export type ClientTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: string[] }
  | { readonly kind: 'missing' }

/** Read the Host-validated client zone from one ordinary user-rpc message. */
function clientTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  return source.kind === 'user'
    && 'rpcId' in source
    && typeof source.rpcId === 'string'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined
}

/**
 * Derive the unique, mixed, or missing client zone from entered request input.
 * @param messages - User messages belonging to the current open turn.
 * @returns A sorted, duplicate-free request-zone context.
 */
export function deriveClientTimeZoneContext(messages: readonly UserMessage[]): ClientTimeZoneContext {
  const timeZones = [...new Set(messages.flatMap((message) => {
    const timeZone = clientTimeZone(message)
    return timeZone === undefined ? [] : [timeZone]
  }))].sort()
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

/**
 * Render Session and request-zone facts for the model-visible time reading.
 * @param sessionTimeZone - Immutable Session zone, or `undefined` for legacy Sessions.
 * @param client - Client zones derived from the current open turn.
 * @returns The two policy lines appended to a time-context reading.
 */
export function renderTimeZoneContext(
  sessionTimeZone: string | undefined,
  client: ClientTimeZoneContext,
): string {
  const session = sessionTimeZone ?? 'unavailable'
  const request = client.kind === 'resolved'
    ? client.timeZone
    : client.kind === 'mixed'
      ? `mixed ${JSON.stringify(client.timeZones)}`
      : 'missing'
  return `Session time zone: ${session}.\nClient time zone for this request: ${request}.`
}
