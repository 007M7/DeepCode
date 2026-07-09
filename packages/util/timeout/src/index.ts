/**
 * The timing-and-classification half of a timeout — a zero-dependency library
 * of pure functions shared by every capability that clamps a caller's timeout
 * hint, arms a deadline, and later has to tell "timed out" apart from
 * "cancelled". It owns NO termination: the returned {@link deadline} signal only
 * NOTIFIES; actually stopping the work (SIGKILL a process group, tear down a
 * fetch socket, …) stays in each capability's implementation, because that
 * mechanism differs per capability and no shared layer can own all of them.
 *
 * This is deliberately a library, not a cordis service or plugin: it takes no
 * `ctx`, registers nothing, holds no cross-call state, and emits no events. A
 * "timeout service" would have to understand how to stop every capability's
 * work — exactly the knowledge a microkernel keeps out of shared layers.
 *
 * The four exports and their division of labor:
 * - {@link clampTimeout} — validate a caller's optional positive hint, fill the
 *   backend default, cap at the backend max (pure arithmetic + the shared
 *   positive-finite request contract).
 * - {@link deadline} — fuse upstream cancellation with a timeout into one
 *   `AbortSignal`, the timeout carrying an identifiable {@link TimeoutReason};
 *   `[Symbol.dispose]` clears the timer.
 * - {@link timeoutOf} — classify an aborted signal (or error): a
 *   {@link TimeoutReason} means the timeout fired, anything else (or nothing)
 *   means it did not.
 * - {@link TimeoutReason} — the internal classification reason; providers
 *   translate it into their own public error/result shape before returning.
 *
 * @module @deepseek-ai/dsh-timeout
 */

/**
 * The internal reason attached to a timeout abort so consumers can classify it
 * after the fact. It carries the failing `code` (each capability's own string —
 * `BASH_TIMEOUT`, `WEB_FETCH_TIMEOUT`, …) and the `timeoutMs` that elapsed.
 *
 * It is an INTERNAL classification reason, not a public error: providers
 * translate it into their seam-specific error code or result field (via
 * {@link timeoutOf}) before returning to callers. Native `AbortSignal.timeout()`
 * yields a fixed `TimeoutError` indistinguishable across timeout kinds; this
 * type is identifiable and carries the code/duration.
 */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  /**
   * @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
   * @param timeoutMs The deadline that elapsed, in milliseconds.
   */
  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/**
 * Validate a caller's optional timeout hint, fill it from the backend default,
 * then cap at the backend max. The shared positive-finite request contract:
 * a supplied `requested` must be a positive finite number or this throws —
 * `0` is NOT a caller-facing "disable timeout" value (that sentinel is internal
 * to {@link deadline}). A missing `requested` falls back to `def`.
 *
 * @param requested The caller's optional hint; validated when present.
 * @param def The backend default applied when `requested` is absent.
 * @param max The backend upper bound the result is capped to.
 * @param name Field name used in the thrown message (so the caller sees which input was bad).
 * @returns The effective timeout in milliseconds: `min(requested ?? def, max)`.
 */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return Math.min(requested ?? def, max)
}

/** A deadline signal plus the cleanup that clears its timer (dispose-once). */
export interface Deadline {
  /** Aborts on upstream cancellation OR on timeout (the timeout carries a {@link TimeoutReason}). */
  readonly signal: AbortSignal
  /** Clear the timer. Safe to call once; `using` calls it at scope exit. */
  [Symbol.dispose](): void
}

/**
 * Build a deadline signal that aborts on upstream cancellation OR on timeout,
 * with the timeout carrying an identifiable {@link TimeoutReason} (unlike
 * native `AbortSignal.timeout()`, whose fixed `TimeoutError` is opaque). It is
 * `AbortSignal.any([upstream, <timeout>])` — the single primitive that fuses
 * two abort sources — with the reason and a disposable timer added on top.
 *
 * `timeoutMs <= 0` is the INTERNAL "no timeout" sentinel for backend-owned
 * background work: arm no timer and forward only the upstream signal; with no
 * upstream either, return a never-aborting signal so callers keep one call
 * shape. External request hints validate as positive finite via
 * {@link clampTimeout} before reaching here, so `0` never arrives from a model
 * or plugin.
 *
 * The returned object's `[Symbol.dispose]` clears the timer — use `using` for a
 * scope-lifetime consumer, or call it manually for an event-lifetime one. The
 * signal only NOTIFIES; the caller must attach its own termination (kill the
 * process group, abort the fetch, …).
 *
 * @param upstream The caller's cancellation signal, if any, fused into the result.
 * @param timeoutMs Deadline in milliseconds; `<= 0` means "no timeout" (arm no timer).
 * @param code Capability-owned code stamped onto the timeout's {@link TimeoutReason}.
 * @returns The fused {@link Deadline} (signal + timer cleanup).
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  if (timeoutMs <= 0) {
    // No timeout (background work): forward only the upstream signal, or a
    // never-aborting one when there is no upstream. No timer, so dispose is a
    // no-op — the empty method keeps the one call shape for every caller.
    return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
  }

  const timer = new AbortController()
  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, timeoutMs)) }, timeoutMs)
  return {
    // AbortSignal.any adopts the reason of whichever source aborts FIRST, so a
    // race resolves to a single cause: timeoutOf() reads TimeoutReason only
    // when the timeout won, and upstream-wins leaves an ordinary abort reason.
    signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
    [Symbol.dispose]() { clearTimeout(id) },
  }
}

/**
 * Recover the {@link TimeoutReason} from an aborted signal (or any object with a
 * `reason`), else `undefined`. This is the classification half: a provider
 * calls it on the deadline signal after an abort to decide whether the cause
 * was its timeout (translate to the capability's timeout error/field) or an
 * ordinary upstream cancellation (`undefined` → the cancel path).
 *
 * Pass `code` to scope the match to THIS deadline's timer. It matters under
 * nesting: when the `upstream` handed to {@link deadline} is itself a deadline
 * signal (e.g. a future `tools/execute` middleware arming a per-call deadline),
 * `AbortSignal.any` preserves the OUTER `TimeoutReason` if the outer timer fires
 * first. Without `code`, the inner capability would misclassify that outer
 * timeout as its own (`timedOut:true` / `WEB_FETCH_TIMEOUT`) though its local
 * timer never expired; with `code`, a foreign timeout reads as `undefined` and
 * falls through to the upstream-cancel path, which is the correct classification
 * from the inner capability's view. Omit `code` only to ask "was this ANY
 * timeout" (a generic middleware that owns no single code).
 *
 * @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
 * @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
 * @returns The matching {@link TimeoutReason}, else `undefined`.
 */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined {
  // AbortSignal.reason is typed `any`; pin it to `unknown` so no `any` leaks and
  // the instanceof narrows cleanly for both a signal and a bare reason carrier.
  const reason: unknown = x.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}
