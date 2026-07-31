// MessageItem: the four simple node kinds — user bubble (right-aligned, with
// clock + copy / branch / edit IconActions), steering (badged bubble), context
// injection and unknown-surface JSON rows. Props are frozen node slices off
// the snapshot cache; memo holds across streaming because unchanged nodes
// keep their references.

import { memo } from 'react'
import type { ReactNode } from 'react'
import type {
  ContextMessageNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode
  /** Fork the session through the turn containing this message (user-bubble branch action). */
  onFork?: (seq: number) => void
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function contentText(content: readonly unknown[]): { text: string; rest: unknown[] } {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else rest.push(block)
  }
  return { text: texts.join(''), rest }
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only. Two
 * shapes decorate: legacy `<skill>name</skill>` spans (pre-decision-21
 * history) and plain-text `/name` / `@name` word-boundary tokens (decision
 * 21: the sent text IS the reference — the bubble uses the same plainest
 * token scan as the composer, minus the lexicon: sent tokens were validated
 * at compose time, so shape alone decorates).
 */
function projectUserText(text: string): ReactNode {
  const re = /<skill>([^<]+)<\/skill>|(^|\s)([/@][\w-]+)(?=\s|$)/g
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const legacy = m[1] !== undefined
    const tokenStart = legacy ? m.index : m.index + (m[2]?.length ?? 0)
    const label = legacy ? `/${m[1]}` : m[3] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(
      <span key={tokenStart} className={css.refChip} data-ref-chip={label.startsWith('@') ? 'subagent' : 'skill'}>
        {label}
      </span>,
    )
    cursor = legacy ? m.index + m[0].length : tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

export const MessageItem = memo(function MessageItem({ node, onFork, t }: MessageItemProps) {
  const truncated = (total: number): string => t('json.truncated', { total })
  switch (node.kind) {
    case 'user': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.bubble}>
            {projectUserText(text)}
            {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
          </div>
          <MessageIconActions
            text={text}
            time={node.time}
            clock="start"
            edit
            onBranch={onFork === undefined ? undefined : () => { onFork(node.seq) }}
            className={css.actions}
            t={t}
          />
        </div>
      )
    }
    case 'steering': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.bubble}>
            <span className={css.badge}>{t('message.steering')}</span>
            {projectUserText(text)}
            {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
          </div>
        </div>
      )
    }
    case 'context':
      return (
        <ContextInjectionRow content={node.content} source={node.source} t={t} />
      )
    default:
      return (
        <div className={css.contextRow}>
          <JsonBlock label={t('message.unknownSurface', { type: node.type })} payload={node.data} truncatedLabel={truncated} />
        </div>
      )
  }
})
