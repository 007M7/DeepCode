// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron when expanded) + title +
// separator dot + FILL-truncated summary. Expanded body is indented gray text;
// no inline output (full results live in the details panel). Expand state is
// component-local view state; row click hands the selection off to the owner.

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowState, ToolRowVariant } from '../contract/tool-call-model.ts'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  variant: ToolRowVariant
  /** Leading 16px tool icon, shown while collapsed and not running/failed. */
  icon: ReactNode
  title: string
  summary: string
  /** Expanded-body text; null = not expandable (leading slot never toggles). */
  body: string | null
  state: ToolRowState
  /** Selection handoff (row click), already bound to this call by the owner. */
  onOpenDetails?: (() => void) | undefined
}

/** Leading-slot state substitution: the tool icon yields to the state semantic
 *  (running = blue ring, error = red, interrupted = amber halo; ok = icon). */
function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'running': return <StateDot state="ongoing" />
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

export function ToolRow({ variant, icon, title, summary, body, state, onOpenDetails }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const expandable = body !== null
  const open = expanded && expandable
  return (
    <div className={css.root} data-variant={variant} data-state={state}>
      <div
        className={css.row}
        data-clickable={onOpenDetails !== undefined || undefined}
        onClick={onOpenDetails}
      >
        {expandable ? (
          <button
            type="button"
            className={css.leading}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            {open ? <IconChevronDownOutline14 className={clsx(css.chevron)} /> : leadingFor(state, icon)}
          </button>
        ) : (
          <span className={css.leading}>{leadingFor(state, icon)}</span>
        )}
        <span className={css.title}>{title}</span>
        {!open && (
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.summary}>{summary}</span>
          </>
        )}
      </div>
      {open && <div className={css.body}>{body}</div>}
    </div>
  )
}
