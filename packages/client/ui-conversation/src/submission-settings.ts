/** Busy-Enter preference stored in the Host user-settings document. */

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/**
 * Narrow one settings-wire value to a busy-Enter behavior.
 * @param value - value crossing the settings boundary.
 * @returns whether the value names a supported behavior.
 */
export function isBusyEnterBehavior(value: unknown): value is BusyEnterBehavior {
  return BUSY_ENTER_BEHAVIORS.some(behavior => behavior === value)
}
