// Web toolview registrant: third-party posture over the keyed toolview hole
// (ctx.slots.register + ToolRowProps only — never imports the chat domain).
// Registered under BOTH web_search and web_fetch, since both declare the one
// `web` render intent and render through the one WebBlock family; the row
// discriminates on the toolName only to pick its icon and title.
//
// A web tool declares the `web` render intent at result time, so this row
// renders the completed retrieval through WebBlock resident below its summary,
// the same posture BashRow uses for the terminal card: no expand control on the
// row itself, not a details-panel target, and the block's own expander keeps a
// long source list from taking over the message flow (CHAT_WEB_MAX_SOURCES is
// passed as maxSources — the chat flow's tighter cap over the block's default
// of 16). Until the call settles there is no web card (the tools keep a generic
// pending view), so a running row is the summary line alone.

import type { Context } from 'cordis'
import { IconBrowseOutline16, IconSearchOutline16, StateDot, WebBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { CHAT_WEB_MAX_SOURCES, webCardModel } from '../contract/web-card-model.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import css from './web-row.module.css'

/** web_fetch reads one URL; web_search queries. Titles are figma literals. */
const WEB_TITLES: Record<string, string> = {
  web_search: 'Search',
  web_fetch: 'Fetch',
}

/** Leading icon per tool, yielding to the state semantic while failed/stopped. */
function leadingFor(toolName: string, state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return toolName === 'web_fetch' ? <IconBrowseOutline16 size={14} /> : <IconSearchOutline16 size={14} />
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
 * Web row: icon + Search/Fetch · {summary} in the shared ToolRow chrome, with
 * the completed retrieval's web card resident below it. The summary row is not
 * a details-panel control (tool rows stopped being one), so the card's own
 * links and expander are the row's only interactions.
 */
export function WebRow({ toolName, block }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  const web = webCardModel(block)
  const status = stateStatus(model.state)
  return (
    <div className={css.card}>
      <div className={css.root} data-variant="web" data-tool={toolName} data-state={model.state}>
        <span className={css.leading}>{leadingFor(toolName, model.state)}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{WEB_TITLES[toolName] ?? model.title}</span>
        <span className={css.sep} aria-hidden />
        <span className={css.summary}>{model.summary}</span>
      </div>
      {web !== null && (
        <WebBlock {...web} maxSources={CHAT_WEB_MAX_SOURCES} className={css.web} />
      )}
    </div>
  )
}

/**
 * The web rows as a plain registrant plugin, riding the same load-order seam as
 * the bash sample: `inject: ['conversation']` guarantees the chat entry (and
 * with it the 'conversation.chat.toolview' declaration) is on the ledger. One
 * WebRow component registers under both web tool names.
 */
export const webToolview = {
  name: 'web-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the web row under both web tool names' keyed toolview holes.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'web_search' }, WebRow)
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'web_fetch' }, WebRow)
  },
}
