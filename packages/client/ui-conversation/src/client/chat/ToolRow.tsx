// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron on hover or expanded) + title +
// separator dot + FILL-truncated summary. Expanded body is indented gray text;
// no inline output (full results live in the details panel). Expand state is
// component-local view state; row click hands the selection off to the owner.
// TODO(ux): converge every chat-tab tool row on in-place expansion for its
// expandable content, retiring the details-panel handoff where feasible.

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { CodeBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowState, ToolRowVariant } from '../contract/tool-call-model.ts'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  variant: ToolRowVariant
  /** Wire tool name for tool-owned styling layered over the generic variant. */
  toolName?: string | undefined
  /** Leading 16px tool icon, shown while collapsed and not running/failed. */
  icon: ReactNode
  title: string
  summary: string
  /** Expanded-body text; null = not expandable (leading slot never toggles). */
  body: string | null
  state: ToolRowState
  /** Makes the row itself the expand control instead of only its leading icon. */
  expandOnRowClick?: boolean | undefined
  /** Selection handoff (row click), already bound to this call by the owner. */
  onOpenDetails?: (() => void) | undefined
}

/** Leading-slot state substitution: the tool icon yields to the terminal state
 *  semantic (error = red, interrupted = amber halo). Running keeps the icon —
 *  the row sweep (CSS on data-state) carries the in-flight signal. */
function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

export function ToolRow({
  variant,
  toolName,
  icon,
  title,
  summary,
  body,
  state,
  expandOnRowClick = false,
  onOpenDetails,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const expandable = body !== null
  const open = expanded && expandable
  const rowExpands = expandable && expandOnRowClick
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const toggleFromLeading = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    toggleExpand()
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!rowExpands || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  // Expandable rows preview the toggle on hover: the tool icon yields to a
  // down chevron (CSS swap on .row:hover); state dots still take precedence.
  const collapsedIcon = expandable
    ? (
      <>
        <span className={css.iconIdle}>{icon}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, css.chevronHover)} />
      </>
    )
    : icon
  const leading = open
    ? <IconChevronDownOutline14 className={css.chevron} />
    : leadingFor(state, collapsedIcon)
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      <div
        className={css.row}
        data-clickable={rowExpands || onOpenDetails !== undefined || undefined}
        role={rowExpands ? 'button' : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
        onClick={rowExpands ? toggleExpand : onOpenDetails}
        onKeyDown={rowExpands ? toggleFromKeyboard : undefined}
      >
        {expandable && !rowExpands ? (
          <button
            type="button"
            className={css.leading}
            aria-expanded={open}
            onClick={toggleFromLeading}
          >
            {leading}
          </button>
        ) : (
          <span className={css.leading}>
            {leading}
          </span>
        )}
        <span className={css.title}>{title}</span>
        {!open && (
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.summary}>{summary}</span>
          </>
        )}
      </div>
      {open && (variant === 'code'
        ? <CodeBlock code={body} lang="typescript" className={css.codeBody} />
        : <div className={css.body}>{body}</div>)}
    </div>
  )
}
