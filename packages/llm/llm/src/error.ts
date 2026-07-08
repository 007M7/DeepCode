/**
 * The harness error taxonomy: one base class so failures carry a stable,
 * machine-routable `code` and chain their `cause`, instead of flattening to a
 * bare message string. Per-package errors extend {@link HarnessError}; the
 * tool layer surfaces `{ name, code }` on results and the session `tool/result`
 * event so retry/sandbox plugins and replay can distinguish failure classes.
 *
 * Lives in dsh-llm (the leaf package every other imports) so a single base is
 * shared without a new dependency edge. See the error-taxonomy RFC.
 *
 * @module @deepseek-ai/dsh-llm/error
 */

/**
 * Base class for all harness errors. Carries a `code` (stable, programmatic —
 * e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
 * human-readable `message`, and supports `cause` chaining via the standard
 * `ErrorOptions`. `name` defaults to the subclass constructor name.
 */
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/**
 * Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at seams).
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}
