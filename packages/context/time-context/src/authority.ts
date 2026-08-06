/** Machine-readable Session and request-zone authority carried by time-context messages. */

/** Session-owned zone authority included in each time-context reading. */
export type SessionTimeZoneAuthority =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'unavailable' }

/** Client-zone provenance of the messages entering one proposed step. */
export type ClientTimeZoneAuthority =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: string[] }
  | { readonly kind: 'missing' }

/** Machine-readable time authority shared by model context and Schedule tools. */
export interface TimeContextAuthority {
  readonly turn: number
  readonly step: number
  readonly session: SessionTimeZoneAuthority
  readonly client: ClientTimeZoneAuthority
}

/** Source shape owned by the time-context plugin. */
export interface TimeContextMessageSource {
  kind: 'plugin'
  plugin: 'time-context'
  authority: TimeContextAuthority
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'time-context': TimeContextMessageSource
  }
}

/** Whether an unknown value is one ordinary JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one object to carry exactly the named keys. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

/** Decode one non-empty zone name without re-owning Host canonicalization. */
function zone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('time-context authority time zone must be a non-empty string')
  }
  return value
}

/** Decode the Session branch of one authority value. */
function sessionAuthority(value: unknown): SessionTimeZoneAuthority {
  if (!isRecord(value)) throw new TypeError('time-context Session authority must be an object')
  if (value['kind'] === 'unavailable' && hasExactKeys(value, ['kind'])) return { kind: 'unavailable' }
  if (value['kind'] === 'resolved' && hasExactKeys(value, ['kind', 'timeZone'])) {
    return { kind: 'resolved', timeZone: zone(value['timeZone']) }
  }
  throw new TypeError('time-context Session authority has an invalid shape')
}

/** Decode the request-client branch of one authority value. */
function clientAuthority(value: unknown): ClientTimeZoneAuthority {
  if (!isRecord(value)) throw new TypeError('time-context client authority must be an object')
  if (value['kind'] === 'missing' && hasExactKeys(value, ['kind'])) return { kind: 'missing' }
  if (value['kind'] === 'resolved' && hasExactKeys(value, ['kind', 'timeZone'])) {
    return { kind: 'resolved', timeZone: zone(value['timeZone']) }
  }
  if (value['kind'] === 'mixed' && hasExactKeys(value, ['kind', 'timeZones'])) {
    const values = value['timeZones']
    if (!Array.isArray(values)
      || !values.every((item): item is string => typeof item === 'string' && item.length > 0)
      || values.length < 2) {
      throw new TypeError('time-context mixed client authority must contain at least two zones')
    }
    const timeZones = [...new Set(values)].sort()
    if (timeZones.length !== values.length || timeZones.some((item, index) => item !== values[index])) {
      throw new TypeError('time-context mixed client zones must be unique and sorted')
    }
    return { kind: 'mixed', timeZones }
  }
  throw new TypeError('time-context client authority has an invalid shape')
}

/**
 * Decode the strict durable source attached to a time-context message.
 * @param value - Untrusted message source.
 * @returns Detached machine authority and its fixed plugin discriminator.
 */
export function decodeTimeContextSource(value: unknown): TimeContextMessageSource {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'plugin', 'authority'])
    || value['kind'] !== 'plugin' || value['plugin'] !== 'time-context') {
    throw new TypeError('time-context message source has an invalid shape')
  }
  const authority = value['authority']
  if (!isRecord(authority) || !hasExactKeys(authority, ['turn', 'step', 'session', 'client'])) {
    throw new TypeError('time-context authority has an invalid shape')
  }
  const turn = authority['turn']
  const step = authority['step']
  if (!Number.isSafeInteger(turn) || (turn as number) < 1
    || !Number.isSafeInteger(step) || (step as number) < 1) {
    throw new TypeError('time-context authority turn and step must be positive safe integers')
  }
  return {
    kind: 'plugin',
    plugin: 'time-context',
    authority: {
      turn: turn as number,
      step: step as number,
      session: sessionAuthority(authority['session']),
      client: clientAuthority(authority['client']),
    },
  }
}

/**
 * Render the machine authority as concise model-visible policy.
 * @param authority - Session and request-zone authority for one proposed step.
 * @returns The two policy lines appended to the time-context reading.
 */
export function renderTimeContextAuthority(authority: TimeContextAuthority): string {
  const session = authority.session.kind === 'resolved'
    ? authority.session.timeZone
    : 'unavailable'
  const client = authority.client.kind === 'resolved'
    ? authority.client.timeZone
    : authority.client.kind === 'mixed'
      ? `mixed ${JSON.stringify(authority.client.timeZones)}`
      : 'missing'
  return `Session time zone: ${session}.\nClient time zone for this request: ${client}.`
}
