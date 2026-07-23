/** Runtime constructors and protocol constants for the goal domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GoalErrorCode, GoalId as GoalIdType } from './types.ts'

/** Version of the goal change metadata embedded in a round-zero `user/message`. */
export const GOAL_CHANGE_VERSION = 1

/**
 * Brand a string as a goal id.
 * @param id - raw goal identifier.
 * @returns the same string with the compile-time brand.
 */
export function GoalId(id: string): GoalIdType {
  return id as GoalIdType
}

/** Error returned by the goal domain boundary. */
export class GoalError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: GoalErrorCode) {
    super(message, code)
  }
}
