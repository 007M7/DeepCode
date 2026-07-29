/** Model-visible rendering for durable goal mutations. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalChangeMeta } from './domain.ts'

/**
 * Render a complete goal snapshot or clear tombstone without hidden prose.
 * @param change - durable goal change carried by the message source.
 * @returns the single context block logged and projected verbatim for model reconstruction.
 */
export function renderGoalChange(change: GoalChangeMeta): ContentBlock[] {
  const payload = change.operation === 'clear'
    ? { cleared: change.cleared, clearedAt: change.clearedAt }
    : {
      goal: change.goal,
      roundsStarted: change.roundsStarted,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    }
  return [{ type: 'text', text: `<goal_state>${JSON.stringify(payload)}</goal_state>` }]
}
