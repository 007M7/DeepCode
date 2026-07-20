/** Public normalization helpers for explicit turn cancellation. @module @deepseek-ai/dsh-agent/cancellation */

import type { AgentCancelCause, AgentInterruptReason } from './types.ts'

/**
 * Validate and detach a caller-supplied Agent cancellation cause.
 * @param value - the candidate cancellation cause.
 * @returns a fresh frozen cause suitable for the current turn signal.
 * @throws {TypeError} when the value is not an exact supported cause.
 */
export function normalizeAgentCancelCause(value: unknown): AgentCancelCause {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('agent cancel cause must be an exact plain object with kind "user" or "parent"')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('agent cancel cause must be an exact plain object with kind "user" or "parent"')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== 'kind') {
    throw new TypeError('agent cancel cause must contain exactly one field: kind')
  }
  const kind = (value as { readonly kind?: unknown }).kind
  switch (kind) {
    case 'user':
      return Object.freeze({ kind: 'user' })
    case 'parent':
      return Object.freeze({ kind: 'parent' })
    default:
      throw new TypeError(`unsupported agent cancel cause kind: ${String(kind)}`)
  }
}

/**
 * Read a supported agent interruption from an explicitly supplied signal.
 * Unknown reasons return `undefined`; ambient initiator identity does not grant
 * cancellation authority.
 * @param signal - the current turn's explicit control signal.
 * @returns its canonical reason, or `undefined` while live or unsupported.
 */
export function agentInterruptReasonOf(signal: AbortSignal): AgentInterruptReason | undefined {
  if (!signal.aborted) return undefined
  const reason: unknown = signal.reason
  if (typeof reason === 'object' && reason !== null && !Array.isArray(reason)) {
    const prototype = Object.getPrototypeOf(reason) as unknown
    const keys = Reflect.ownKeys(reason)
    if ((prototype === Object.prototype || prototype === null)
      && keys.length === 1 && keys[0] === 'kind'
      && (reason as { readonly kind?: unknown }).kind === 'disposed') {
      return Object.freeze({ kind: 'disposed' })
    }
  }
  try {
    return normalizeAgentCancelCause(reason)
  } catch (error: unknown) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}
