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

/** Counts plus the one-line hint; `activeHint` is null when there is none to show. */
export interface PlanSummary {
  done: number
  total: number
  activeHint: string | null
}

/**
 * Derive the counts and the active hint from a whole-list snapshot. The hint is
 * the first `in_progress` content suffixed `+<n>` for the remaining active
 * items, so a parallel plan reports how many tasks are running rather than
 * naming one and hiding the others. It is null when nothing is in progress, or
 * when the first active item carries no usable content — model JSON may, and
 * the caller then falls back to its own summary.
 * @param todos - the whole list, in model order.
 * @returns the done/total counts and the active hint.
 */
export function planSummary(todos: readonly PlanItemLike[]): PlanSummary {
  const active = todos.filter(t => t.status === 'in_progress')
  const first = active[0]?.content
  const activeHint = typeof first !== 'string' || first === ''
    ? null
    : active.length > 1 ? `${first} +${active.length - 1}` : first
  return {
    done: todos.filter(t => t.status === 'completed').length,
    total: todos.length,
    activeHint,
  }
}
