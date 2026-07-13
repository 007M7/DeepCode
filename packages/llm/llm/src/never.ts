/**
 * Exhaustiveness helper for switches over core unions.
 * @module @deepseek-ai/dsh-llm/never
 */

/**
 * Mark an unreachable closed-union branch and diagnose values that escaped
 * static exhaustiveness.
 * @param value - the impossible value; typed `never` so an unhandled variant fails compilation at the call site.
 * @param context - optional label (e.g. the switch site) prefixed into the throw message.
 * @returns never — it always throws, with the offending value JSON-rendered in the message.
 */
export function assertNever(value: never, context?: string): never {
  // JSON.stringify is typed string but returns undefined for undefined input;
  // String() covers that and other non-serializable escapes.
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}
