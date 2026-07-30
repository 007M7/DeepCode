// GenericToolCard: the default tool row — classifies the tool into one of
// the five figma row variants and renders the summary row. Supplied by the
// chat view as the keyed toolview slot's render-site fallback (an
// unregistered tool name lands here); registrants may also compose it as a
// base, feeding the same owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
  IconThinkOutline14, WebBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowOwnerProps } from '../contract/slots.ts'
import { terminalCardModel } from '../contract/terminal-card-model.ts'
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

export function GenericToolCard({ toolName, block, cwd, openFile }: ToolRowOwnerProps) {
  const model = toolRowModel(toolName, block, cwd)
  const terminal = terminalCardModel(block, cwd)
  const web = webCardModel(block)
  const singleFile = model.filePath !== undefined
  const row = (
    <ToolRow
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={model.title}
      // A terminal presenter's description is the contract's above-card text, so
      // it outranks the args-derived summary here exactly as it does in BashRow.
      summary={terminal?.description ?? model.summary}
      // Single-file tools never expose an args body — the path link is the only action.
      body={singleFile ? null : model.body}
      terminal={terminal}
      state={model.state}
      filePath={model.filePath}
      onOpenFile={singleFile ? openFile : undefined}
    />
  )
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
