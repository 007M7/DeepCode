// Shared IconActions chrome for user and assistant messages: copy / branch
// live (branch still a stub), date-aware clock, optional edit stub.

import { useCallback } from 'react'
import {
  IconBranchOutline16, IconCopyOutline16, IconEditOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatMessageClock, writeClipboard } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label. */
  time: number
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** When true, append the stub edit control (user bubble). */
  edit?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
}

/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, optional edit, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, clock, edit, className,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const onCopy = useCallback(() => {
    void writeClipboard(text)
  }, [text])
  const clockEl = (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, day)}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === 'start' ? clockEl : null}
      <Tooltip label="复制" side="bottom">
        <button type="button" className={css.action} aria-label="复制" onClick={onCopy}>
          <IconCopyOutline16 />
        </button>
      </Tooltip>
      <Tooltip label="在新对话中分支" side="bottom">
        <button type="button" className={css.action} aria-label="在新对话中分支">
          <IconBranchOutline16 />
        </button>
      </Tooltip>
      {edit === true && (
        <Tooltip label="编辑" side="bottom">
          <button type="button" className={css.action} aria-label="编辑">
            <IconEditOutline16 />
          </button>
        </Tooltip>
      )}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
