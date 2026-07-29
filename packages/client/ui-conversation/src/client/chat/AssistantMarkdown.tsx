// AssistantMarkdown: renders assistant blocks in order — markdown text body,
// reasoning as the figma Think summary row (expand = indented gray text),
// other-block JSON fallback. Tool-call heads are NOT rendered here: the chat
// view groups them into tool rows through its keyed toolview slot (figma
// step-summary flow). Shared by finalized nodes and the streaming partial;
// the turn-level loading dots live in the chat view's tail, not here.
// Finalized nodes append IconActions (copy / branch / clock) once streaming ends.

import { memo } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconThinkOutline14, JsonBlock, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { MessageIconActions } from './MessageIconActions.tsx'
import { ToolRow } from './ToolRow.tsx'
import css from './AssistantMarkdown.module.css'

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a 已停止 marker. */
  interrupted?: boolean | undefined
  /** Unix epoch ms for the finalized IconActions clock; omitted while streaming. */
  time?: number | undefined
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Joined text blocks for the copy action (reasoning / tool heads stay out). */
function copyText(blocks: readonly AssistantBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text') parts.push(block.text)
  }
  return parts.join('')
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
function ThinkRow({ text, running }: { text: string; running: boolean }) {
  return (
    <ToolRow
      variant="think"
      icon={<IconThinkOutline14 size={14} />}
      title="Think"
      summary={firstLine(text)}
      body={text}
      state={running ? 'running' : 'ok'}
      expandOnRowClick
    />
  )
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, time,
}: AssistantMarkdownProps) {
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  // Footer only after the turn settles with a known event time; streaming omits it.
  const showActions = !streaming && time !== undefined
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {blocks.map((block, i) => {
          switch (block.kind) {
            case 'text': return <MarkdownText key={i} text={block.text} streaming={streaming} />
            case 'reasoning': return <ThinkRow key={i} text={block.text} running={streaming && i === last} />
            // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
            case 'tool-call': return null
            default: return <JsonBlock key={i} label="未知内容块" payload={block.block} />
          }
        })}
        {interrupted && <span className={css.stopped}>已停止</span>}
      </div>
      {showActions && (
        <MessageIconActions
          text={copyText(blocks)}
          time={time}
          clock="end"
          className={css.actions}
        />
      )}
    </div>
  )
})
