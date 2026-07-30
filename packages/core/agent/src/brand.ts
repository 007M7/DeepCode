/**
 * dsh-agent's owned branded ids for live inbox occurrences.
 *
 * @module @deepseek-ai/dsh-agent/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one accepted occurrence in an agent inbox. Re-sending the same
 * message creates a distinct item id, so pending work remains independently
 * addressable.
 */
export type InboxItemId = Branded<'InboxItemId'>

/**
 * Brand a string as an {@link InboxItemId}.
 * @param id - the agent-loop-minted occurrence identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function InboxItemId(id: string): InboxItemId {
  return id as InboxItemId
}
