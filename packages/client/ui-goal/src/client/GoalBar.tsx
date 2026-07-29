/**
 * GoalBar: the goal indicator docked above the message composer (input dock
 * strip). A present goal shows a sparkle, a phase label, the truncated
 * objective, and icon actions — resume when paused, edit (inline form in the
 * same strip), and clear. Goal creation lives on the `/goal` command, not
 * here: loading (undefined), no goal (null), and complete goals render
 * nothing. Live state arrives as the projected whole snapshot; the verbs are
 * the injected face.
 */

import { useCallback, useEffect, useState } from 'react'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal/client'
import {
  IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconPlayOutline16, IconSparkle16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GoalActionResult, GoalBarActions } from './slots.ts'
import css from './GoalBar.module.css'

export interface GoalBarProps extends GoalBarActions {
  /** Current goal snapshot; undefined = capability absent or loading, null = no goal set. */
  goal: GoalSnapshot | null | undefined
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
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // A new goal identity (cleared/completed/replaced externally) invalidates the local edit
  // state: without the reset a surviving draft's Enter would write over the NEW goal.
  const goalId = goal?.id
  useEffect(() => {
    setEditing(false)
    setActionError(null)
  }, [goalId])

  const handleEdit = useCallback(async () => {
    const trimmed = draft.trim()
    if (trimmed === '') return
    setPending(true)
    setActionError(null)
    const result = await onEdit(trimmed)
    setPending(false)
    if (result.ok) {
      setEditing(false)
    } else {
      setActionError(`${result.error.message} (${result.error.code})`)
    }
  }, [draft, onEdit])

  const runAction = useCallback(async (action: () => Promise<GoalActionResult>) => {
    setPending(true)
    setActionError(null)
    const result = await action()
    setPending(false)
    if (!result.ok) setActionError(`${result.error.message} (${result.error.code})`)
  }, [])

  // Loading, absent, and complete goals have no strip at all.
  if (goal === undefined || goal === null || goal.phase === 'complete') return null

  if (editing) {
    return (
      <div className={css.dock} data-goal-bar>
        <div className={css.bar}>
          <input
            className={css.objectiveInput}
            type="text"
            aria-label="Goal objective"
            value={draft}
            onChange={(e) => { setDraft(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
          />
          {actionError !== null && <span className={css.error} role="alert">{actionError}</span>}
          <div className={css.actions}>
            <button
              type="button"
              className={css.iconBtn}
              onClick={() => { void handleEdit() }}
              disabled={pending || draft.trim() === ''}
              title="Save goal"
              aria-label="Save goal"
            >
              <IconCheckOutline16 />
            </button>
            <button
              type="button"
              className={css.iconBtn}
              onClick={() => { setEditing(false) }}
              disabled={pending}
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
    <div className={css.dock} data-goal-bar>
      <div className={css.bar} title={title}>
        <span className={css.sparkle}><IconSparkle16 /></span>
        <span className={css.label}>{PHASE_LABELS[goal.phase]}</span>
        <span className={css.objective}>{goal.objective}</span>
        {actionError !== null && <span className={css.error} role="alert">{actionError}</span>}
        <div className={css.actions}>
          {goal.phase === 'paused' && (
            <button type="button" className={css.iconBtn} disabled={pending} onClick={() => { void runAction(onResume) }} title="Resume goal" aria-label="Resume goal">
              <IconPlayOutline16 />
            </button>
          )}
          <button
            type="button"
            className={css.iconBtn}
            disabled={pending}
            onClick={() => { setDraft(goal.objective); setEditing(true) }}
            title="Edit goal"
            aria-label="Edit goal"
          >
            <IconEditOutline16 />
          </button>
          <button type="button" className={css.iconBtn} disabled={pending} onClick={() => { void runAction(onClear) }} title="Clear goal" aria-label="Clear goal">
            <IconTrashOutline16 />
          </button>
        </div>
      </div>
    </div>
  )
}

/** Full props of the dock entry: InputZone owner share + session standard kit + injected verbs. */
export type GoalDockProps = import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'> & GoalBarActions

/** Dock adapter: reads the host-computed 'goal' projection (whole value; absent or null renders nothing). */
export function GoalDock({ useProjection, onEdit, onResume, onClear }: GoalDockProps) {
  const projection = useProjection('goal')
  return (
    <GoalBar
      goal={projection === undefined ? undefined : projection === null ? null : projection.goal}
      onEdit={onEdit}
      onResume={onResume}
      onClear={onClear}
    />
  )
}
