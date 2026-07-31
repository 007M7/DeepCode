// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron on hover or expanded) + title +
// separator dot + FILL-truncated summary, drawn through the shared
// DisclosureRow chrome with the whole row as the expand toggle (click /
// Enter / Space, icon→chevron hover preview). The collapsed row is always
// one line; every row with body, output, or terminal material is expandable;
// the summary stays inline while open, except Think, whose body opens with
// the same first line and would repeat it.
// The expanded body — an IN/OUT gutter-labeled card (figma 1249:35657) for
// text input/output, the run_code program through CodeBlock, or a terminal
// card's command output through TerminalBlock — lives in a max-height scroll
// container so a long payload scrolls internally instead of taking over the
// message flow; Think's prose is the exception and flows uncapped like
// message text. Expand state is component-local view state. File-tool
// summaries are path links that open through the host (stopPropagation keeps
// the two gestures independent); an error row's collapsed summary is the
// failure's first line in the error color.

import { useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { CodeBlock, DiffBlock, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from '../contract/diff-card-model.ts'
import { terminalBlockLabels, type TerminalCardModel } from '../contract/terminal-card-model.ts'
import type { ToolRowState, ToolRowVariant } from '../contract/tool-call-model.ts'
import { DisclosureRow } from './DisclosureRow.tsx'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  /** The render site's conversation locale seat (terminal/code body copy). */
  t: TranslateNS<'conversation'>
  variant: ToolRowVariant
  /** Wire tool name for tool-owned styling layered over the generic variant. */
  toolName?: string | undefined
  /** Leading 16px tool icon, shown while collapsed and not running/failed. */
  icon: ReactNode
  title: string
  summary: string
  /** Expanded-body input text; null = no input section. */
  body: string | null
  /** Flattened result text for the expanded Output section; null/absent = no output section. */
  output?: string | null | undefined
  /** Error first line shown as the collapsed summary on an error row; null/absent = keep `summary`. */
  errorSummary?: string | null | undefined
  /**
   * Terminal-card material for a call whose render intent is a terminal card
   * (derived by `terminalCardModel`); it replaces the text sections when
   * present. A row with no body, no output, and no terminal material is not
   * expandable.
   */
  terminal?: TerminalCardModel | null | undefined
  /**
   * Diff-card material for a call whose render intent is a diff card (derived by
   * `diffCardModel`); it replaces the text body when present, the same way
   * `terminal` does. A call carries at most one card intent, so the two are
   * never both set.
   */
  diff?: DiffCardModel | null | undefined
  state: ToolRowState
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** Open the path with the host OS default application (already cwd-resolved). */
  onOpenFile?: ((path: string) => void) | undefined
  /**
   * Jump to this call in the trajectory view: a hover-revealed Inspect pill
   * over the expanded body. Absent = no affordance (rows without a call
   * identity, like Think).
   */
  inspect?: (() => void) | undefined
}

/** The Inspect pill's code glyph (user-supplied 16×16), fill follows text color. */
function IconInspect() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M16 8L10.8571 12V10.552L14.1383 8L10.8571 5.448V4L16 8ZM5.14286 10.552L1.86171 8L5.14286 5.448V4L0 8L5.14286 12V10.552ZM9.02514 4L5.59657 12H6.84057L10.2691 4H9.02514Z" fill="currentColor" />
    </svg>
  )
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
  t,
  variant,
  toolName,
  icon,
  title,
  summary,
  body,
  output,
  errorSummary,
  terminal,
  diff,
  state,
  filePath,
  onOpenFile,
  inspect,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const terminalBody = terminal ?? null
  const diffBody = diff ?? null
  const outputText = output ?? null
  const expandable = body !== null || outputText !== null || terminalBody !== null || diffBody !== null
  const open = expanded && expandable
  // An error row's collapsed summary IS the failure: the first error line in
  // the error color outranks both the args summary and a terminal description.
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const summaryText = failureLine ?? summary
  // The failure line is error prose, not the path: no open-file affordance.
  const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath !== undefined) onOpenFile?.(filePath)
  }
  // Think reasoning is prose, not an input payload: expanded, it renders as
  // plain indented text (no IN/OUT card) and the inline summary — the body's
  // own first line — yields to avoid repeating itself.
  const isThink = variant === 'think'
  // The code variant's program renders through CodeBlock (shiki), so only its
  // output joins the IN/OUT card; every other variant's input does too.
  const cardBody = variant === 'code' ? null : body
  // The state substitution rides the idle icon slot, so an expandable error
  // row keeps DisclosureRow's icon→chevron hover preview (its default) instead
  // of losing it with the icon.
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen={!isThink}
        onToggle={toggleExpand}
        collapsedContent={summaryText !== '' && (
          /* An empty summary drops the separator with it (a row that is only
             its title shows no trailing dot). */
          <>
            <span className={css.sep} aria-hidden />
            {fileLink ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
              >
                {summaryText}
              </button>
            ) : (
              <span className={clsx(css.summary, failureLine !== null && css.errorSummary)}>
                {summaryText}
              </span>
            )}
          </>
        )}
      >
        {/* The wrapper (sibling of the header row, so clicks inside never
            toggle it) carries the expanded body and the Inspect pill below. */}
        <div className={css.bodyWrap}>
          {terminalBody !== null
            ? (
              <TerminalBlock
                {...terminalBody.card}
                maxLines={Infinity}
                labels={terminalBlockLabels(t)}
                className={css.terminalBody}
              />
            )
            : diffBody !== null
              ? <DiffBlock {...diffBody.card} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
              : isThink
                ? <div className={css.thinkBody}>{body}</div>
                : (
                  <>
                    {variant === 'code' && body !== null && (
                      <div className={css.bodyScroll}>
                        <CodeBlock code={body} lang="typescript" copyLabel={t('copy')} copiedLabel={t('copied')} className={css.codeBody} />
                      </div>
                    )}
                    {(cardBody !== null || outputText !== null) && (
                      <div className={css.ioCard}>
                        {cardBody !== null && (
                          <div className={css.ioSection}>
                            <span className={css.ioLabel}>IN</span>
                            <span className={css.ioText}>{cardBody}</span>
                          </div>
                        )}
                        {cardBody !== null && outputText !== null && (
                          <span className={css.ioDivider} aria-hidden />
                        )}
                        {outputText !== null && (
                          <div className={css.ioSection}>
                            <span className={css.ioLabel}>OUT</span>
                            <span className={css.ioText} data-error={state === 'error' || undefined}>
                              {outputText}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
          {inspect !== undefined && (
            <button
              type="button"
              className={css.inspectButton}
              onClick={inspect}
            >
              <IconInspect />
              Inspect
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
