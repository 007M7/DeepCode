// Shared IconActions chrome for user, steering, and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.

import { useCallback } from 'react'
import {
  IconBranchOutline16, IconCopyOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatMessageClock, writeClipboard } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message. */
  onBranch?: (() => void) | undefined
  /** Whether to render the branch action; defaults to true. */
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
  text, time, clock, onBranch, showBranch = true, className, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const onCopy = useCallback(() => {
    void writeClipboard(text)
  }, [text])
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
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
      {showBranch && (
        <Tooltip label={t('message.branch')} side="bottom">
          <button type="button" className={css.action} aria-label={t('message.branch')} onClick={onBranch}>
            <IconBranchOutline16 />
          </button>
        </Tooltip>
      )}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
