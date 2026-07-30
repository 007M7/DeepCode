// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron on hover or expanded) + title +
// separator dot + FILL-truncated summary. The collapsed row is always one
// line; the expanded body is indented gray text, the run_code program through
// CodeBlock, or — for a call whose render intent is a terminal card — the
// command's own output through TerminalBlock, capped at
// CHAT_TERMINAL_MAX_LINES so the message flow stays scannable. Expand state is
// component-local view state. File-tool summaries are path links that open
// through the host; the row itself is not a details-panel control.

import { useState, type MouseEvent, type ReactNode } from 'react'
import { CodeBlock, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHAT_TERMINAL_MAX_LINES, type TerminalCardModel } from '../contract/terminal-card-model.ts'
import type { ToolRowState, ToolRowVariant } from '../contract/tool-call-model.ts'
import { DisclosureRow } from './DisclosureRow.tsx'
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
  terminal,
  state,
  expandOnRowClick = false,
  filePath,
  onOpenFile,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const terminalBody = terminal ?? null
  // A row that names a single file keeps one interaction (open that path);
  // args expand is off whether or not the open callback is wired yet. Terminal
  // material still expands: only the file variants carry a path, so a terminal
  // card and a file link never land on the same row.
  const singleFile = filePath !== undefined
  const fileLink = singleFile && onOpenFile !== undefined
  const expandable = (body !== null && !singleFile) || terminalBody !== null
  // The text arms take the empty string for a null body: a row expandable
  // only through its terminal material renders the terminal body instead, so
  // this substitution never shows.
  const text = body ?? ''
  const open = expanded && expandable
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath !== undefined) onOpenFile?.(filePath)
  }
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick={expandOnRowClick}
        previewChevron={expandable && state !== 'error' && state !== 'stopped'}
        onToggle={toggleExpand}
        collapsedContent={(
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
      >
        {/* The terminal presenter's description belongs above the card per
            the render-intent contract. */}
        {terminalBody?.description !== undefined && (
          <div className={css.terminalDescription}>{terminalBody.description}</div>
        )}
        {terminalBody !== null
          ? <TerminalBlock {...terminalBody.card} maxLines={CHAT_TERMINAL_MAX_LINES} className={css.terminalBody} />
          : variant === 'code'
            ? <CodeBlock code={text} lang="typescript" className={css.codeBody} />
            : <div className={css.body}>{text}</div>}
      </DisclosureRow>
    </div>
  )
}
