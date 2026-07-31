// Read toolview registrant: the keyed toolview hole for the read tool
// (ctx.slots.register + ToolRowProps only — never imports the chat domain).
// Product chrome matches ToolRow (figma: Read · {path}); the summary is the
// file path as an openable link, exactly as the generic read row draws it.
//
// A read RESULT declares the read render intent, so this row renders the file's
// own line-numbered, syntax-highlighted content through ReadBlock resident
// below its summary line — the same posture BashRow gives a terminal card. The
// card is capped at CHAT_READ_MAX_LINES (the chat flow's tighter cap over the
// block's own default of 16) with the block's internal expander keeping a long
// read from taking over the message flow. A running read (no result yet) and a
// non-read result both render the summary row alone. The read intent is
// result-side only, so there is no running-state read card to draw.

import type { Context } from 'cordis'
import { IconBrowseOutline16, ReadBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { CHAT_READ_MAX_LINES, readCardModel } from '../contract/read-card-model.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import css from './read-row.module.css'

/** Leading-slot state substitution: the tool icon yields to the state dot
 *  (error = red, interrupted = amber). Running keeps the icon. */
function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconBrowseOutline16 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState): string | null {
  switch (state) {
    case 'running': return '运行中'
    case 'error': return '失败'
    case 'stopped': return '已停止'
    default: return null
  }
}

/**
 * Read row: icon + Read · {path} in the shared ToolRow chrome, with the file's
 * read card resident below it. The summary path is an openable host link when
 * the row names a single file; the card's copy and expand controls plus that
 * link are the row's only interactions (tool rows are not details-panel
 * targets).
 */
export function ReadRow({ toolName, block, sessionId, useSessions, openFile }: ToolRowProps) {
  // Session workspace root: the read view's path relativizes against it (a
  // workspace-rooted absolute path shows its short form), which the pure
  // presenter cannot do.
  const cwd = useSessions(list => list.byId[sessionId]?.cwd)
  const model = toolRowModel(toolName, block, cwd)
  const read = readCardModel(block, cwd)
  const status = stateStatus(model.state)
  const filePath = model.filePath
  return (
    <div className={css.card}>
      {/* jscpd:ignore-start — the summary-line chrome (leading, status, title,
          sep, path-link/summary) is the shared ToolRow row shape every keyed
          toolview draws; extracting it into one component is a separate change
          tracked for all rows at once, not this read-card PR. */}
      <div className={css.root} data-variant="read" data-state={model.state}>
        <span className={css.leading}>{leadingFor(model.state)}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{model.title}</span>
        <span className={css.sep} aria-hidden />
        {filePath !== undefined ? (
          <button
            type="button"
            className={css.fileLink}
            onClick={() => { openFile(filePath) }}
          >
            {model.summary}
          </button>
        ) : (
          <span className={css.summary}>{model.summary}</span>
        )}
      </div>
      {/* jscpd:ignore-end */}
      {read !== null && (
        <ReadBlock {...read} maxLines={CHAT_READ_MAX_LINES} className={css.read} />
      )}
    </div>
  )
}

/**
 * The read row as a plain registrant plugin. `inject` carries the load-order
 * seam: requiring the conversation service guarantees the chat entry (and with
 * it the 'conversation.chat.toolview' declaration) is registered —
 * ui-conversation's apply mounts the service after the chat entry.
 */
export const readToolview = {
  name: 'read-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the read row into the chat view's keyed toolview hole.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'read' }, ReadRow)
  },
}
