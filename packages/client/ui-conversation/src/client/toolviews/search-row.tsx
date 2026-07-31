// Search toolview registrant: the keyed toolview hole (ctx.slots.register +
// ToolRowProps only — never imports the chat domain). One SearchRow component
// registered under both `grep` and `glob`, since both tools declare the same
// `card: 'search'` render intent and render as one visual object; the row reads
// the `kind` discriminant off the derived model to draw grouped matches or a
// path list. Product chrome matches ToolRow / BashRow (Search · {summary}).
//
// A search call declares its render intent result-time only, so this row's
// search card is resident below the summary rather than expand-gated: the row
// itself has no expand control, and the card's own copy, per-file collapse, and
// head/tail expand are the row's only interactions. CHAT_SEARCH_MAX_LINES is
// passed as `maxLines` — the chat flow's tighter cap over the block's own
// default of 16 — so a large result stays bounded in the message flow.

import type { Context } from 'cordis'
import { IconSearchOutline16, SearchBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { CHAT_SEARCH_MAX_LINES, searchCardModel } from '../contract/search-card-model.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import { rowResultText, rowStateStatus } from '../contract/toolview-status.ts'
import css from './search-row.module.css'

/** Leading-slot glyph substitution: the search icon yields to the terminal
 *  state semantic (error = red, interrupted = amber). Running keeps the icon —
 *  the row sweep carries the in-flight signal. */
function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconSearchOutline16 size={14} />
  }
}

/**
 * Search row: icon + Search · {summary} in the shared ToolRow chrome, with the
 * completed search's card resident below it, and — when the result was capped —
 * the recovery footer below the card. The summary row is not a details-panel
 * control, so the card's copy, per-file collapse, and expand controls are the
 * row's only interactions. Registered under both `grep` and `glob`; the derived
 * model's `kind` decides the card shape.
 */
export function SearchRow({ toolName, block }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  const search = searchCardModel(block)
  const status = rowStateStatus(model.state)
  // A settled call with no search card — an errored search (grep/glob emit no
  // result view on error), a successful nested run_code sub-dispatch, or a
  // legacy generic result — has its model-facing text nowhere else to go, since
  // the keyed SearchRow owns this render slot. Surface it as the fallback body.
  // A running call ('kind' absent) has no result to flatten; rowResultText
  // returns null for it, so the arm stays closed until settle.
  const settled = 'kind' in block
  const fallback = search === null && settled ? rowResultText(block) : null
  return (
    <div className={css.card}>
      <div className={css.root} data-variant="search" data-tool={toolName} data-state={model.state}>
        <span className={css.leading}>{leadingFor(model.state)}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{model.title}</span>
        <span className={css.sep} aria-hidden />
        {/* The result view's replacement title outranks the args-derived
            summary, matching the terminal card's description precedence. */}
        <span className={css.summary}>{search?.title ?? model.summary}</span>
      </div>
      {search !== null && (
        <SearchBlock {...search.card} maxLines={CHAT_SEARCH_MAX_LINES} className={css.search} />
      )}
      {/* A capped search drops rows from the card; its recovery locator (the
          `Full … stored at …` footer) lives only in the result text, so show it
          below the card so the one path to the dropped rows survives. */}
      {search?.recovery !== undefined && <div className={css.recovery}>{search.recovery}</div>}
      {fallback !== null && <div className={css.failure}>{fallback}</div>}
    </div>
  )
}

/**
 * The search toolview as a plain registrant plugin. `inject` carries the
 * load-order seam: requiring the conversation service guarantees the chat entry
 * (and with it the 'conversation.chat.toolview' declaration) is registered.
 * The one component registers under both keys, since `grep` and `glob` are the
 * same visual object discriminated only by the result view's `kind`.
 */
export const searchToolview = {
  name: 'search-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the search row into the chat view's keyed toolview hole under both
   * the `grep` and `glob` tool names.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'grep' }, SearchRow)
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'glob' }, SearchRow)
  },
}
