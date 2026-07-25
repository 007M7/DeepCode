/** Canonical durable identity for resolved retry policies. @module @deepseek-ai/dsh-llm-retry/policy-key */

import type { ResolvedRetryBackoff, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

function parseBackoff(
  tuple: readonly unknown[],
  offset: number,
): ResolvedRetryBackoff | undefined {
  const initialDelayMs = tuple[offset]
  const maxDelayMs = tuple[offset + 1]
  const jitterRatio = tuple[offset + 2]
  if (typeof initialDelayMs !== 'number' || !Number.isFinite(initialDelayMs)
    || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS
    || typeof maxDelayMs !== 'number' || !Number.isFinite(maxDelayMs)
    || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS
    || initialDelayMs > maxDelayMs
    || typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio)
    || jitterRatio < 0 || jitterRatio > 1) {
    return undefined
  }
  return { initialDelayMs, maxDelayMs, jitterRatio }
}

/**
 * Derive the canonical durable key for one fully resolved provider policy.
 * Retryable-code order is normalized because eligibility uses set membership.
 * @param policy - immutable policy captured from the serving registration.
 * @returns canonical JSON tuple containing every behavior-affecting field.
 */
export function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  if (policy.mode === 'always') {
    return JSON.stringify([
      policy.mode,
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
  }
  return JSON.stringify([
    policy.mode,
    policy.maxRetries,
    [...policy.retryableCodes].sort(),
    policy.initialDelayMs,
    policy.maxDelayMs,
    policy.jitterRatio,
  ])
}

/**
 * Parse a producer-canonical policy key from durable input.
 * @param value - untrusted persisted event field.
 * @returns the resolved policy encoded by the key, or `undefined` for any non-canonical value.
 */
export function parseRetryPolicyKey(value: unknown): ResolvedRetryPolicy | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let tuple: unknown
  try {
    tuple = JSON.parse(value) as unknown
  } catch (_invalidPolicyKeyJson) {
    return undefined
  }
  if (!Array.isArray(tuple)) return undefined
  const items = tuple as readonly unknown[]
  const mode = items[0]
  let policy: ResolvedRetryPolicy
  switch (mode) {
    case 'always': {
      if (items.length !== 4) return undefined
      const backoff = parseBackoff(items, 1)
      if (backoff === undefined) return undefined
      policy = Object.freeze({ mode, ...backoff })
      break
    }
    case 'normal': {
      if (items.length !== 6) return undefined
      const maxRetries = items[1]
      const retryableCodes = items[2]
      const backoff = parseBackoff(items, 3)
      if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0
        || !Array.isArray(retryableCodes) || retryableCodes.length === 0
        || (retryableCodes as readonly unknown[])
          .some(code => typeof code !== 'string' || code.length === 0)
        || new Set(retryableCodes).size !== retryableCodes.length
        || backoff === undefined) {
        return undefined
      }
      policy = Object.freeze({
        mode,
        maxRetries: maxRetries as number,
        retryableCodes: Object.freeze(retryableCodes as string[]),
        ...backoff,
      })
      break
    }
    default:
      return undefined
  }
  return retryPolicyKey(policy) === value ? policy : undefined
}
