/**
 * The harness error taxonomy: one base class so failures carry a stable,
 * machine-routable `code` and chain their `cause`, instead of flattening to a
 * bare message string. Per-package errors extend {@link HarnessError}; the
 * tool layer surfaces `{ name, code }` on results and the session `tool/result`
 * event so retry/sandbox plugins and replay can distinguish failure classes.
 *
 * Lives in dsh-llm (the leaf package every other imports) so a single base is
 * shared without a new dependency edge. See ADR 0015.
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
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at seams). */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}
