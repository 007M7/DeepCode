/**
 * The harness error taxonomy: one base class so failures carry a stable, machine-routable
 * `code` and chain their `cause`, instead of flattening to a bare message string.
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
