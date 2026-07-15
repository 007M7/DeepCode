/** Opaque revision identity for lightweight persistence observations. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Backend-owned token that changes whenever one persisted session log changes. */
export type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>

/**
 * Brand a backend revision for the provider-neutral persistence contract.
 * @param value - backend-owned opaque revision representation.
 * @returns the same runtime string with persistence-revision identity.
 */
export function SessionPersistenceRevision(value: string): SessionPersistenceRevision {
  return value as SessionPersistenceRevision
}
