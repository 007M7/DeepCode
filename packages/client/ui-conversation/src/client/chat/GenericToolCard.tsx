// GenericToolCard: the default tool row — classifies the tool into one of
// the five figma row variants and renders the summary row. Supplied by the
// chat view as the keyed toolview slot's render-site fallback (an
// unregistered tool name lands here); registrants may also compose it as a
// base, feeding the same owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconThinkOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowOwnerProps } from '../contract/slots.ts'
import { toolRowModel, type ToolRowVariant } from '../contract/tool-call-model.ts'
import { ToolRow } from './ToolRow.tsx'
import { IconSparkle16 } from './IconSparkle16.tsx'

/** Variant leading icons (figma table). */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  think: <IconThinkOutline14 />,
  search: <IconSearchOutline16 />,
  read: <IconBrowseOutline16 />,
  bash: <IconApiOutline14 size={16} />,
  write: <IconEditOutline16 />,
  edit: <IconEditOutline16 />,
  code: <IconCodeOutline16 />,
  others: <IconSparkle16 />,
}

export function GenericToolCard({ toolName, block, openDetails }: ToolRowOwnerProps) {
  const model = toolRowModel(toolName, block)
  return (
    <ToolRow
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={model.title}
      summary={model.summary}
      body={model.body}
      state={model.state}
      onOpenDetails={openDetails}
    />
  )
}
