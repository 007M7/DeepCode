/** Detached session-query snapshots that preserve message immutability. */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Clone one event while retaining the invariant that every identified message is frozen.
 * @param event - source event from one corpus observation.
 * @returns a detached event whose message value, if any, is deeply frozen.
 */
export function snapshotEvent<T extends SessionEvent>(event: T): T {
  const snapshot = structuredClone(event)
  switch (snapshot.type) {
    case 'user/message':
      deepFreeze(snapshot.data)
      break
    case 'assistant/message':
    case 'tool/result':
    case 'steering/message':
      deepFreeze(snapshot.data.message)
      break
    default:
      // SessionEventMap is merge-extensible; plugin-owned log-only events carry no core message.
      break
  }
  return snapshot
}
