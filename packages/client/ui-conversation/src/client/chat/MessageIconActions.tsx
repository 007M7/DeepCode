// Shared IconActions chrome for user, steering, and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.

import { useCallback, useId } from 'react'
import {
  IconBranchOutline16, IconCopyOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatMessageClock, formatRunDuration, writeClipboard } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Turn wall time in ms, appended to the clock as `· Ran for 15s`; omitted when the turn's start is unknown. */
  runMs?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message; omission hides the branch action. */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Additional branch visibility gate for transient message chrome; defaults to true. */
  showBranch?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, runMs, clock, onBranch, branchUnavailable = false, showBranch = true, className, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const reasonId = useId()
  const onCopy = useCallback(() => {
    void writeClipboard(text)
  }, [text])
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
      {runMs !== undefined && (
        <>
          <span className={css.runTimeDot} aria-hidden>·</span>
          {t('message.ranFor', { duration: formatRunDuration(runMs, t) })}
        </>
      )}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === 'start' ? clockEl : null}
      <Tooltip label={t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={t('copy')} onClick={onCopy}>
          <IconCopyOutline16 />
        </button>
      </Tooltip>
      {showBranch && onBranch !== undefined && (
        <Tooltip label={branchUnavailable ? t('message.branchUnavailable') : t('message.branch')} side="bottom">
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            className={css.action}
            aria-label={t('message.branch')}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutline16 />
          </button>
        </Tooltip>
      )}
      {showBranch && onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{t('message.branchUnavailable')}</span>
      )}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
