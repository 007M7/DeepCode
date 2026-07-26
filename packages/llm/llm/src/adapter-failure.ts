/**
 * Private provider-failure tagging shared by `LlmService` and its consumers.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'
import type { LlmFailure, StreamChunk } from './types.ts'

/** Errors and normalized facts proven to originate in one model call's final adapter boundary. */
export type AdapterFailureScope = WeakMap<Error, LlmFailure>

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
  // Cross-package copies preserve own data but not class identity. Trust the
  // carried facts only when both own properties agree after validation.
  const carried = ownFailureSnapshot(error)
  const failure = carried !== undefined && carried.code === ownErrorCode(error) ? carried : Object.freeze({
    message: errorMessage(error),
    code: harnessErrorCode(error),
  })
  failures.set(error, failure)
  return error
}

/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))) return undefined
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // The fallback below preserves a serializable failure beside the original Error.
  }
  return 'LLM adapter failed'
}

/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error: Error): string {
  return error instanceof HarnessError ? error.code : 'UNKNOWN'
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

/**
 * Retrieve normalized provider facts only for an Error tagged by this exact
 * model call's final adapter boundary.
 * @param stream - the exact stream returned to the consumer.
 * @param value - the caught failure.
 * @returns the immutable facts for that call, or `undefined` for middleware, nested, or consumer failures.
 */
export function llmFailureOf(
  stream: AsyncIterable<StreamChunk>,
  value: unknown,
): LlmFailure | undefined {
  const failures = adapterFailureScopes.get(stream)
  return value instanceof Error ? failures?.get(value) : undefined
}
