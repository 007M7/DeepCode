/**
 * Pure plan derivation shared by the two todo surfaces: the plan strip header
 * (skeleton domain) and the todo_write row (toolviews domain). Both need the
 * same done/total counts and the same one-line active hint, and several items
 * may be `in_progress` at once — parallel work runs concurrent tasks, so a
 * hint built from one active item would silently drop the rest.
 * @module
 */

/**
 * One list item as either surface sees it: the typed `TodoItem` off the session
 * snapshot, or unvalidated model JSON parsed from a call's args (any field may
 * be missing or mistyped).
 */
export interface PlanItemLike {
  content?: unknown
  status?: unknown
}

/**
 * Counts plus the two halves of the one-line hint, deliberately NOT pre-joined:
 * both surfaces ellipsize the hint, and a count concatenated onto the end of
 * the task name is the first thing a narrow viewport clips — exactly when it
 * carries information. Each surface renders `activeExtra` in its own
 * non-shrinking span beside the truncatable `activeContent`.
 */
export interface PlanSummary {
  done: number
  total: number
  /** First `in_progress` content, or null when there is no usable one to name. */
  activeContent: string | null
  /** Active items beyond the first; 0 whenever there is no `activeContent` to sit beside. */
  activeExtra: number
}

/**
 * Derive the counts and the active hint from a whole-list snapshot. The hint
 * names the first `in_progress` item and counts the remaining active ones, so a
 * parallel plan reports how many tasks are running rather than naming one and
 * hiding the others. `activeContent` is null when nothing is in progress, or
 * when the first active item carries no usable content — model JSON may, and
 * the caller then falls back to its own summary.
 * @param todos - the whole list, in model order.
 * @returns the done/total counts and the two hint halves.
 */
export function planSummary(todos: readonly PlanItemLike[]): PlanSummary {
  const active = todos.filter(t => t.status === 'in_progress')
  const first = active[0]?.content
  const named = typeof first === 'string' && first !== ''
  return {
    done: todos.filter(t => t.status === 'completed').length,
    total: todos.length,
    activeContent: named ? first : null,
    activeExtra: named ? active.length - 1 : 0,
  }
}
