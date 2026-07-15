/**
 * Private provider-failure tagging shared by `LlmService` and its consumers.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'

/** Errors proven to originate in final adapter dispatch or iteration. */
const adapterFailures = new WeakSet<Error>()

/**
 * Preserve an adapter's Error identity while tagging its provider origin.
 * @param value - arbitrary value thrown by adapter dispatch or iteration.
 * @returns the original Error, or a coded Error wrapping a non-Error throw.
 * @internal
 */
export function markLlmAdapterFailure(value: unknown): Error & { code?: string } {
  const error = value instanceof Error
    ? value as Error & { code?: string }
    : new HarnessError(String(value), 'UNKNOWN', { cause: value })
  adapterFailures.add(error)
  return error
}

/**
 * Whether a failure came from final adapter dispatch, iterator construction,
 * or iteration rather than from an `llm/stream` waterfall listener.
 * @param value - arbitrary failure caught by a model-call consumer.
 * @returns true only for errors tagged at the final adapter boundary.
 */
export function isLlmAdapterFailure(value: unknown): value is Error & { code?: string } {
  return value instanceof Error && adapterFailures.has(value)
}
