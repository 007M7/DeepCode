/** Runtime reason inspection for explicit turn cancellation. @module @deepseek-ai/dsh-agent/cancellation */

import type { AgentInterruptReason } from './types.ts'

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
  if (typeof reason !== 'object' || reason === null || Array.isArray(reason)) return undefined
  const prototype = Object.getPrototypeOf(reason) as unknown
  const keys = Reflect.ownKeys(reason)
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== 1 || keys[0] !== 'kind') return undefined
  switch ((reason as { readonly kind?: unknown }).kind) {
    case 'user':
      return Object.freeze({ kind: 'user' })
    case 'parent':
      return Object.freeze({ kind: 'parent' })
    case 'disposed':
      return Object.freeze({ kind: 'disposed' })
    default:
      return undefined
  }
}
