// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron when expanded) + title +
// separator dot + FILL-truncated summary. The collapsed row is always one
// line; the expanded body is indented gray text, the run_code program through
// CodeBlock, or — for a call whose render intent is a terminal card — the
// command's own output through TerminalBlock, capped at
// CHAT_TERMINAL_MAX_LINES so the message flow stays scannable. The details
// panel remains the full-height reading surface for the same call. Expand
// state is component-local view state; row click hands the selection off to
// the owner.

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { CodeBlock, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHAT_TERMINAL_MAX_LINES, type TerminalCardModel } from '../contract/terminal-card-model.ts'
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
  /** Expanded-body text; null = no text body (`terminal` is the other body source). */
  body: string | null
  /**
   * Terminal-card material for a call whose render intent is a terminal card
   * (derived by `terminalCardModel`); it replaces the text body when present.
   * Null or absent leaves the text body, and a row with neither is not
   * expandable (its leading slot never toggles).
   */
  terminal?: TerminalCardModel | null | undefined
  state: ToolRowState
  /** Makes the row itself the expand control instead of only its leading icon. */
  expandOnRowClick?: boolean | undefined
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

export function ToolRow({
  variant,
  toolName,
  icon,
  title,
  summary,
  body,
  terminal,
  state,
  expandOnRowClick = false,
  onOpenDetails,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const terminalBody = terminal ?? null
  const expandable = body !== null || terminalBody !== null
  // The text arms take the empty string for a null body: a row expandable
  // only through its terminal material renders the terminal body instead, so
  // this substitution never shows.
  const text = body ?? ''
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
            {open ? <IconChevronDownOutline14 className={clsx(css.chevron)} /> : leadingFor(state, icon)}
          </button>
        ) : (
          <span className={css.leading}>
            {open ? <IconChevronDownOutline14 className={clsx(css.chevron)} /> : leadingFor(state, icon)}
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
      {open && (terminalBody !== null
        ? <TerminalBlock {...terminalBody} maxLines={CHAT_TERMINAL_MAX_LINES} className={css.terminalBody} />
        : variant === 'code'
          ? <CodeBlock code={text} lang="typescript" className={css.codeBody} />
          : <div className={css.body}>{text}</div>)}
    </div>
  )
}
