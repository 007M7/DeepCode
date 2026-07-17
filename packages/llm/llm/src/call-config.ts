/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, and sampling values are request-header state that can affect cache
 * reuse; request waterfalls replace them and the loop logs changed snapshots
 * instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */

/**
 * Provider + model + sampling scalars of one conversation's requests. Every field maps
 * 1:1 onto the same-named `GenerateOptions` field; the loop builds requests
 * from the logged header rather than accepting these per call.
 */
export interface LlmCallConfig {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (a.provider !== b.provider || a.model !== b.model || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Deep-freeze a value in place, guarding cycles, so later mutation throws.
 * {@link AbortSignal} objects are deliberately skipped because they are the
 * request's live cancellation channel and freezing them breaks abort.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (node instanceof AbortSignal) return
    if (seen.has(node)) return
    seen.add(node)
    Object.freeze(node)
    for (const key of Object.keys(node)) {
      walk((node as Record<string, unknown>)[key])
    }
  }
  walk(value)
  return value
}
