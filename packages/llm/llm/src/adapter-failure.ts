/**
 * Private provider-failure tagging shared by `LlmService` and its consumers.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'
import type { StreamChunk } from './types.ts'

/** Errors proven to originate in one model call's final adapter boundary. */
export type AdapterFailureScope = WeakSet<Error>

/** Call-local failure scopes keyed by the exact stream handle returned to a consumer. */
const adapterFailureScopes = new WeakMap<AsyncIterable<StreamChunk>, AdapterFailureScope>()

/**
 * Bind one call's adapter-failure scope to a unique returned stream handle.
 * @param stream - the waterfall-selected stream for this call.
 * @param failures - errors tagged by this call's final adapter boundary.
 * @returns a unique stream handle that delegates iteration to `stream`.
 * @internal
 */
export function bindAdapterFailureScope(
  stream: AsyncIterable<StreamChunk>,
  failures: AdapterFailureScope,
): AsyncIterable<StreamChunk> {
  const call = {
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      return stream[Symbol.asyncIterator]()
    },
  }
  adapterFailureScopes.set(call, failures)
  return call
}

/**
 * Preserve an adapter's Error identity while tagging its provider origin.
 * @param failures - the call-local final-adapter failure scope.
 * @param value - arbitrary value thrown by adapter dispatch or iteration.
 * @returns the original Error, or a coded Error wrapping a non-Error throw.
 * @internal
 */
export function markLlmAdapterFailure(
  failures: AdapterFailureScope,
  value: unknown,
): Error & { code?: string } {
  const error = value instanceof Error
    ? value as Error & { code?: string }
    : new HarnessError(String(value), 'UNKNOWN', { cause: value })
  failures.add(error)
  return error
}

/**
 * Whether a failure came from final adapter dispatch, iterator construction,
 * or iteration for the call represented by the exact returned stream handle.
 * @param stream - the exact stream returned by the model call being classified.
 * @param value - arbitrary failure caught by a model-call consumer.
 * @returns true only for errors tagged at that call's final adapter boundary.
 */
export function isLlmAdapterFailure(
  stream: AsyncIterable<StreamChunk>,
  value: unknown,
): value is Error & { code?: string } {
  const failures = adapterFailureScopes.get(stream)
  return value instanceof Error && failures !== undefined && failures.has(value)
}
