/**
 * Shared provider-side vocabulary for out-of-process subagent backends: the
 * no-capabilities advertisement, timing-bound validation for the dispose
 * ladder's graces, and the standard run-handle publication that owns dispose
 * idempotence and abort-listener hygiene.
 *
 * @module @deepseek-ai/dsh-subagent-subprocess/provider
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentCapabilities, SubagentResult, SubagentRun, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/**
 * The capability advertisement of an out-of-process backend: NONE. A child in
 * another process cannot honor parent-enforced start features
 * (`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a
 * request needing any of them before `start` runs — never accepted-then-ignored.
 */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/**
 * Assert a configured timing bound is a positive finite number (it bounds a
 * teardown or shutdown wait; zero, negative, or NaN would skip or wedge it).
 * @param prefix - the consuming plugin's diagnostic prefix (e.g. `subagent-acp`).
 * @param name - the config field name, for the diagnostic.
 * @param value - the configured value.
 */
export function assertPositiveFinite(prefix: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${name} must be a positive finite number`)
  }
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The rejecting surfaces (wire clients, spawn error events) only throw
  // `Error`s; the `String(value)` arm is a defensive fallback for a non-Error
  // throw the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Inputs to {@link settleRunResult}. */
export interface RunResultSettlement {
  /** The turn attempt (typically racing local cancellation); returns the terminal result. */
  attempt: () => Promise<SubagentResult>
  /** Snapshot of the child output streamed so far (a partial answer survives failure). */
  collectOutput: () => ContentBlock[]
  /** Whether local cancellation settled (an in-flight rejection then reads as `aborted`). */
  cancelled: () => boolean
  /** Diagnostic sink for a failure flattened to a stop reason; a throw from it is contained. */
  onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
  /** The request's cancellation signal (the listener is removed at settlement). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
}

/**
 * Settle an out-of-process run result under the seam contract: `result` never
 * rejects after publication. A rejection from the attempt resolves as
 * `aborted` when cancellation already settled locally, else it is flattened
 * to `stopReason: 'error'` through the contained diagnostic sink; the abort
 * listener is removed on every path.
 * @param parts - the attempt, output snapshot, cancellation state, sink, and signal wiring.
 * @returns the terminal result (never a rejection).
 */
export async function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult> {
  try {
    return await parts.attempt()
  } catch (error: unknown) {
    // Cover a rejection already queued when cancellation arrives.
    if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
    // Flatten post-publication transport failures while preserving diagnostics.
    try {
      parts.onError?.(toError(error), 'error')
    } catch {
      // The diagnostic sink cannot reject the run result.
    }
    return { output: parts.collectOutput(), stopReason: 'error' }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

/** Inputs to {@link subprocessRunHandle}. */
export interface SubprocessRunHandleParts {
  /** The parent-scoped run id. */
  id: SubagentRun['id']
  /** The flattened, never-rejecting result (the seam contract). */
  result: Promise<SubagentResult>
  /** The request's cancellation signal (the listener is removed on dispose). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
  /** Settle local cancellation so {@link result} resolves without the child. */
  requestCancel: () => void
  /** Tear the child process down to quiescence (backend-owned ladder). */
  teardown: () => Promise<void>
}

/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent (one memoized teardown): it removes the abort listener, settles
 * local cancellation — there is no assumption the child cooperates — and then
 * awaits the backend's teardown to actual exit.
 * @param parts - the run identity, result, cancellation wiring, and teardown.
 * @returns the seam run handle (`localAgent` is `undefined` for remote runs).
 */
export function subprocessRunHandle(parts: SubprocessRunHandleParts): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}
