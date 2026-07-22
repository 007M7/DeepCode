// GenericToolCard: the registry-miss fallback toolview — classifies the tool
// into one of the five figma row variants and renders the summary row. Also
// the shared base the bash sample builds on: any ToolViewProps consumer.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconSearchOutline16, IconThinkOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolViewProps } from '../contract/toolview.ts'
import { toolRowModel, type ToolCallBlock, type ToolRowVariant } from '../contract/tool-call-model.ts'
import { ToolRow } from './ToolRow.tsx'
import { IconSparkle16 } from './IconSparkle16.tsx'

/** Variant leading icons (figma table). */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  think: <IconThinkOutline14 />,
  search: <IconSearchOutline16 />,
  read: <IconBrowseOutline16 />,
  bash: <IconApiOutline14 size={16} />,
  others: <IconSparkle16 />,
}

export function GenericToolCard({ toolName, block, actions }: ToolViewProps) {
  const model = toolRowModel(toolName, block as ToolCallBlock)
  return (
    <ToolRow
      variant={model.variant}
      icon={VARIANT_ICONS[model.variant]}
      title={model.title}
      summary={model.summary}
      body={model.body}
      state={model.state}
      onOpenDetails={actions.openDetails}
    />
  )
}
