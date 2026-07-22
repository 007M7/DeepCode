/**
 * GoalBar: the goal indicator docked directly above the message composer
 * (rounded-top strip tucked under the composer card's top edge). A present
 * goal shows a sparkle, a phase label, the truncated objective, and icon
 * actions — resume when paused, edit (inline form in the same strip), and
 * clear. Goal creation lives on the `/goal` command, not here: loading
 * (undefined), no goal (null), and complete goals render nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import type { GoalView } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconPlayOutline16, IconSparkle16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GoalBarActions } from '../contract/slots.ts'
import css from './GoalBar.module.css'

export interface GoalBarProps extends GoalBarActions {
  /** Current goal state; undefined = still loading, null = no goal set. */
  goal: GoalView | null | undefined
}

/** Strip labels per visible phase; complete goals render nothing. */
const PHASE_LABELS = {
  active: 'Ongoing Goal',
  paused: 'Paused Goal',
  blocked: 'Blocked Goal',
} as const

export function GoalBar({ goal, onEdit, onResume, onClear }: GoalBarProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // A new goal identity (cleared/completed/replaced externally) invalidates the local edit
  // state: without the reset a surviving draft's Enter would write over the NEW goal.
  const goalId = goal?.id
  useEffect(() => {
    setEditing(false)
  }, [goalId])

  const handleEdit = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed === '') return
    onEdit(trimmed)
    setEditing(false)
  }, [draft, onEdit])

  // Loading, absent, and complete goals have no strip at all.
  if (goal === undefined || goal === null || goal.phase === 'complete') return null

  if (editing) {
    return (
      <div className={css.dock}>
        <div className={css.bar}>
          <input
            className={css.objectiveInput}
            type="text"
            aria-label="Goal objective"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
          />
          <div className={css.actions}>
            <button
              type="button"
              className={css.iconBtn}
              onClick={handleEdit}
              disabled={draft.trim() === ''}
              title="Save goal"
              aria-label="Save goal"
            >
              <IconCheckOutline16 />
            </button>
            <button
              type="button"
              className={css.iconBtn}
              onClick={() => setEditing(false)}
              title="Cancel edit"
              aria-label="Cancel edit"
            >
              <IconCloseOutline16 />
            </button>
          </div>
        </div>
      </div>
    )
  }

  const title = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined
  return (
    <div className={css.dock}>
      <div className={css.bar} title={title}>
        <span className={css.sparkle}><IconSparkle16 /></span>
        <span className={css.label}>{PHASE_LABELS[goal.phase]}</span>
        <span className={css.objective}>{goal.objective}</span>
        <div className={css.actions}>
          {goal.phase === 'paused' && (
            <button type="button" className={css.iconBtn} onClick={onResume} title="Resume goal" aria-label="Resume goal">
              <IconPlayOutline16 />
            </button>
          )}
          <button
            type="button"
            className={css.iconBtn}
            onClick={() => { setDraft(goal.objective); setEditing(true) }}
            title="Edit goal"
            aria-label="Edit goal"
          >
            <IconEditOutline16 />
          </button>
          <button type="button" className={css.iconBtn} onClick={onClear} title="Clear goal" aria-label="Clear goal">
            <IconTrashOutline16 />
          </button>
        </div>
      </div>
    </div>
  )
}
