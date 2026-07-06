/**
 * The call configuration of a conversation and its comparison/freeze
 * utilities. `LlmCallConfig` is the non-content third of the request header
 * (see `EpochHeader` in dsh-session): everything about a request besides its
 * message content that can undermine provider KV-cache reuse — `model`
 * selects the cache namespace outright, and the sampling scalars are treated
 * the same way out of caution. It is per-conversation state recorded in the
 * session log (the reconstructability RFC), never a silently-drifting
 * per-call knob: the `agent/request` waterfall proposes a replacement, and
 * the loop logs a real change as a `request/header-delta` event.
 *
 * @module dsh-llm/call-config
 */

/**
 * Model + sampling scalars of one conversation's requests. Every field maps
 * 1:1 onto the same-named `GenerateOptions` field; the loop builds requests
 * from the logged header rather than accepting these per call.
 */
export interface LlmCallConfig {
  model: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header delta) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (a.model !== b.model || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Deep-freeze a value in place so any later mutation throws (ESM code runs in
 * strict mode), and return it. The loop freezes every request it builds
 * before dispatch — `llm/stream` listeners and adapters read the request,
 * never rewrite it, so the wire bytes cannot silently desync from what the
 * session log reconstructs. Guards against cycles with a WeakSet: loop-built
 * requests hold `structuredClone`d JSON-validated session data, but the
 * helper accepts arbitrarily constructed values. One exemption: an
 * `AbortSignal` is never entered or frozen — it is the request's live
 * cancellation channel, and freezing one breaks `AbortController.abort()`
 * outright (Node stores the aborted flag as an own property of the signal).
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
