// GenericToolCard: the default tool row — classifies the tool into one of
// the five figma row variants and renders the summary row. Supplied by the
// chat view as the keyed toolview slot's render-site fallback (an
// unregistered tool name lands here); registrants may also compose it as a
// base, feeding the same owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
  IconThinkOutline14, ReadBlock, WebBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, ToolRowOwnerProps } from '../contract/slots.ts'
import { searchCardModel } from '../contract/search-card-model.ts'
import { CHAT_READ_MAX_LINES, readCardModel } from '../contract/read-card-model.ts'
import { diffCardModel } from '../contract/diff-card-model.ts'
import { terminalCardModel, terminalFailed } from '../contract/terminal-card-model.ts'
import { CHAT_WEB_MAX_SOURCES, webCardModel } from '../contract/web-card-model.ts'
import { toolRowModel, type ToolRowVariant } from '../contract/tool-call-model.ts'
import { ToolRow } from './ToolRow.tsx'
import css from './GenericToolCard.module.css'

/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  think: <IconThinkOutline14 size={14} />,
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/** Card props: the owner payload plus the render site's locale seat (plain prop). */
export interface GenericToolCardProps extends ToolRowOwnerProps {
  t: ChatViewSlotProps['t']
}

export function GenericToolCard({ toolName, block, cwd, openFile, inspect, t }: GenericToolCardProps) {
  const model = toolRowModel(toolName, block, cwd)
  const terminal = terminalCardModel(block, cwd)
  const search = searchCardModel(block)
  const read = readCardModel(block, cwd)
  const diff = diffCardModel(block)
  const web = webCardModel(block)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced as the row's red state dot.
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal)
    ? 'error'
    : model.state
  const singleFile = model.filePath !== undefined
  const row = (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={model.title}
      // A terminal presenter's description is the contract's above-card text, so
      // it outranks the args-derived summary here exactly as it does in BashRow;
      // a search result view's replacement title outranks it the same way.
      summary={terminal?.description ?? search?.title ?? model.summary}
      // Single-file tools never expose an args body — the path link is the only
      // args interaction. A diff card is not an args body: a write/edit row is
      // single-file AND carries a diff, so the card expands under the path link.
      body={singleFile ? null : model.body}
      output={model.output}
      errorSummary={model.errorSummary}
      terminal={terminal}
      search={search}
      diff={diff}
      state={state}
      filePath={model.filePath}
      onOpenFile={singleFile ? openFile : undefined}
      inspect={inspect}
    />
  )
  // A read-declaring tool without its own keyed row lands here (e.g. web_fetch),
  // so the file's read card is resident below the summary row exactly as the
  // keyed ReadRow draws it. Only wrap when a card is present, so every other
  // tool keeps the bare ToolRow.
  if (read !== null) {
    return (
      <div className={css.card}>
        {row}
        <ReadBlock {...read} maxLines={CHAT_READ_MAX_LINES} className={css.read} />
      </div>
    )
  }
  // A web-declaring tool without its own keyed row lands here; its card is
  // resident under the summary, mirroring WebRow (and BashRow's terminal card).
  if (web === null) return row
  return (
    <div className={css.card}>
      {row}
      <WebBlock {...web} maxSources={CHAT_WEB_MAX_SOURCES} className={css.web} />
    </div>
  )
}
