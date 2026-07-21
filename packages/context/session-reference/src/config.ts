/** Configuration and stable diagnostics for session references. */

/** Default maximum references accepted by one message. */
export const DEFAULT_MAX_REFERENCES = 3
/** Default number of discovery candidates returned to a host. */
export const DEFAULT_CANDIDATE_LIMIT = 50
/** Default UTF-8 budget for one rendered reference JSON object. */
export const DEFAULT_MAX_REFERENCE_BYTES = 65_536
/** Default UTF-8 budget for the complete injected reference prompt. */
export const DEFAULT_MAX_TOTAL_BYTES = 196_608

/** Session-reference service configuration. */
export interface Config {
  /** Maximum distinct source sessions referenced by one message. */
  maxReferences?: number
  /** Default host candidate-list limit. */
  candidateLimit?: number
  /** Maximum rendered UTF-8 bytes for one source snapshot. */
  maxReferenceBytes?: number
  /** Maximum rendered UTF-8 bytes for the complete injected prompt. */
  maxTotalBytes?: number
}

/** Stable failure codes exposed to host adapters. */
export type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED'

/** Typed session-reference failure suitable for host protocol error mapping. */
export class SessionReferenceError extends Error {
  /** @param message Human-readable diagnosis. @param code Stable routing code. @param options Optional cause. */
  constructor(
    message: string,
    readonly code: SessionReferenceErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionReferenceError'
  }
}
