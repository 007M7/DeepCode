/** Runtime constructors and protocol constants for the goal domain. */

import type { GoalErrorCode, GoalId as GoalIdType } from './types.ts'

/** Version of the goal change metadata embedded in `context/message`. */
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
export class GoalError extends Error {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  constructor(message: string, public readonly code: GoalErrorCode) {
    super(message)
    this.name = 'GoalError'
  }
}
