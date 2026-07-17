/**
 * Exhaustiveness helper for this package's closed unions. Kept local so the
 * SDK plugin-fetch tooling stays free of the model-runtime `dsh-llm` dependency
 * that owns the shared `assertNever`.
 *
 * @module @deepseek-ai/dsh-plugin-fetch/never
 */

/**
 * Mark an unreachable closed-union branch. A newly unhandled variant fails
 * compilation at the call site; a value that escaped its type throws at runtime.
 * @param value - the impossible value; typed `never` so a new variant fails to compile at every call site.
 * @param context - optional label prefixed into the throw message.
 * @returns never — it always throws, rendering the offending value.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}
