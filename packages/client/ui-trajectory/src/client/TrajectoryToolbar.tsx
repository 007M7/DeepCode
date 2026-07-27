/** Trajectory toolbar: view identity, record totals, and the ledger fold control. */

import css from './TrajectoryToolbar.module.css'

export interface TrajectoryToolbarProps {
  /** Selected context title when the session contains discontinuities. */
  contextLabel?: string
  /** Whether the selected context is the live tail. */
  contextCurrent?: boolean
  /** Number of turns containing more than one row. */
  collapsibleTurns: number
  /** Whether every collapsible turn is currently folded. */
  allTurnsCollapsed: boolean
  /** Fold or expand every collapsible turn. */
  onToggleAllTurns(): void
  /** Number of assistant messages followed by tool calls. */
  collapsibleAssistants: number
  /** Whether every collapsible assistant's tool calls are currently folded. */
  allAssistantsCollapsed: boolean
  /** Fold or expand tool calls under every collapsible assistant. */
  onToggleAllAssistants(): void
}

/**
 * Render the sticky trajectory toolbar.
 * @param props - rendered counts and whole-list fold state.
 * @returns the toolbar element.
 */
export function TrajectoryToolbar({
  contextLabel,
  contextCurrent,
  collapsibleTurns,
  allTurnsCollapsed,
  onToggleAllTurns,
  collapsibleAssistants,
  allAssistantsCollapsed,
  onToggleAllAssistants,
}: TrajectoryToolbarProps) {
  return (
    <div className={css.root} role="toolbar" aria-label="Trajectory toolbar">
      <div className={css.inner}>
        <div className={css.summary}>
          <span className={css.title}>Trajectory</span>
          {contextLabel !== undefined && (
            <>
              <span className={css.separator}>/</span>
              <span className={css.context}>{contextLabel}</span>
              <span className={contextCurrent ? css.contextCurrent : css.contextFrozen}>
                {contextCurrent ? 'Current' : 'Frozen'}
              </span>
            </>
          )}
        </div>
        <div className={css.actions}>
          <button
            type="button"
            className={css.action}
            disabled={collapsibleAssistants === 0}
            onClick={onToggleAllAssistants}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allAssistantsCollapsed ? '⊞' : '⊟'}
            </span>
            {allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'}
          </button>
          <button
            type="button"
            className={css.action}
            disabled={collapsibleTurns === 0}
            onClick={onToggleAllTurns}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allTurnsCollapsed ? '⊞' : '⊟'}
            </span>
            {allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'}
          </button>
        </div>
      </div>
    </div>
  )
}
