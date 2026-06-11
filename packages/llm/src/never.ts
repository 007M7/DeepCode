/**
 * Exhaustiveness helper for switches over core unions.
 *
 * # When to use which pattern
 *
 * **Closed unions** (every variant is known at compile time in the consuming
 * code — e.g. `StreamChunk` inside the assembler, `FiberState`-like enums):
 * end the switch with `default: assertNever(value)`. Adding a variant then
 * fails compilation at every switch that must handle it — the error appears
 * exactly where work is needed.
 *
 * **Merge-extensible unions** (plugins add variants via declaration merging —
 * `SessionEventMap`, `ContentBlockMap`, `MessageSourceMap`, …): do NOT use
 * assertNever. From the core's view the union is open; plugin-added variants
 * are valid values the core has never heard of. Handle the known cases and
 * fall through intentionally, with a comment saying the switch is
 * deliberately non-exhaustive (see `Session.deriveMessages`). The lint rule
 * `switch-exhaustiveness-check` enforces that the choice is explicit either
 * way.
 *
 * @module @deepseek-ai/dsh-llm/never
 */

/**
 * Marks unreachable code on a closed union. If this is reachable, either a
 * variant was added without updating the switch (compile error at the call
 * site — the desired outcome) or a value escaped its type (runtime throw
 * with diagnostics — the safety net).
 */
export function assertNever(value: never, context?: string): never {
  // JSON.stringify is typed string but returns undefined for undefined input;
  // String() covers that and other non-serializable escapes.
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}
