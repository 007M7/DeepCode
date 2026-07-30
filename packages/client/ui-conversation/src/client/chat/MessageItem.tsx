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
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'
import { ImageGallery, type ImageLoader } from './MessageImage.tsx'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode
  loadImage?: ImageLoader
}

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
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

export const MessageItem = memo(function MessageItem({ node, loadImage = unavailableImage }: MessageItemProps) {
  switch (node.kind) {
    case 'user': {
      const { text, images, rest } = contentParts(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.userStack}>
            <ImageGallery images={images} load={loadImage} align="end" />
            {(text !== '' || rest.length > 0) && <div className={css.bubble}>
              {projectUserText(text)}
              {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
            </div>}
          </div>
          <MessageIconActions
            text={text}
            time={node.time}
            clock="start"
            edit
            className={css.actions}
          />
        </div>
      )
    }
    case 'steering': {
      const { text, images, rest } = contentParts(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.userStack}>
            <ImageGallery images={images} load={loadImage} align="end" />
            <div className={css.bubble}>
              <span className={css.badge}>插话</span>
              {projectUserText(text)}
              {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
            </div>
          </div>
        </div>
      )
    }
    case 'context':
      return (
        <div className={css.contextRow}>
          <JsonBlock label="上下文注入" payload={{ content: node.content, source: node.source }} />
        </div>
      )
    default:
      return (
        <div className={css.contextRow}>
          <JsonBlock label={`未知 surface 事件：${node.type}`} payload={node.data} />
        </div>
      )
  }
})

function unavailableImage(): Promise<string> {
  return Promise.reject(new Error('图片读取服务不可用'))
}
