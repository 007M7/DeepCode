// AssistantMarkdown: renders assistant blocks in order — markdown text body,
// reasoning as the figma Think summary row (expand = indented gray text),
// other-block JSON fallback. Tool-call heads are NOT rendered here: the chat
// view groups them into tool rows via the toolview outlet (figma step-summary
// flow). Shared by finalized nodes and the streaming partial (pulse marker).

import { memo } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { IconThinkOutline14, JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToolRow } from './ToolRow.tsx'
import css from './AssistantMarkdown.module.css'

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a 已停止 marker, no pulse. */
  interrupted?: boolean | undefined
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
function ThinkRow({ text, running }: { text: string; running: boolean }) {
  return (
    <ToolRow
      variant="think"
      icon={<IconThinkOutline14 />}
      title="Think"
      summary={firstLine(text)}
      body={text}
      state={running ? 'running' : 'ok'}
    />
  )
}

export const AssistantMarkdown = memo(function AssistantMarkdown({ blocks, streaming, interrupted }: AssistantMarkdownProps) {
  const last = blocks.length - 1
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'text': return <MessageText key={i} text={block.text} />
          case 'reasoning': return <ThinkRow key={i} text={block.text} running={streaming && i === last} />
          // Tool-call heads render as tool rows in the chat view's grouping pass.
          case 'tool-call': return null
          default: return <JsonBlock key={i} label="未知内容块" payload={block.block} />
        }
      })}
      {streaming && <span className={css.pulse} />}
      {interrupted && <span className={css.stopped}>已停止</span>}
    </div>
  )
})
