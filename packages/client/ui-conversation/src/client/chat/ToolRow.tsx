// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron on hover or expanded) + title +
// separator dot + FILL-truncated summary. Expanded body is indented gray text;
// no inline output (full results live in the details panel). Expand state is
// component-local view state. File-tool summaries are path links that open
// through the host; the row itself is not a details-panel control.

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
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** Open the path with the host OS default application (already cwd-resolved). */
  onOpenFile?: ((path: string) => void) | undefined
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
  filePath,
  onOpenFile,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  // A row that names a single file keeps one interaction (open that path);
  // args expand is off whether or not the open callback is wired yet.
  const singleFile = filePath !== undefined
  const fileLink = singleFile && onOpenFile !== undefined
  const expandable = body !== null && !singleFile
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
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath !== undefined) onOpenFile?.(filePath)
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
        data-expandable={rowExpands || undefined}
        role={rowExpands ? 'button' : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
        onClick={rowExpands ? toggleExpand : undefined}
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
            {fileLink ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
              >
                {summary}
              </button>
            ) : (
              <span className={css.summary}>{summary}</span>
            )}
          </>
        )}
      </div>
      {open && (variant === 'code'
        ? <CodeBlock code={body} lang="typescript" className={css.codeBody} />
        : <div className={css.body}>{body}</div>)}
    </div>
  )
}
