// MessageItem: the four simple node kinds — user bubble (right-aligned),
// steering (badged bubble), context injection and unknown-surface JSON rows.
// Props are frozen node slices off the snapshot cache; memo holds across
// streaming because unchanged nodes keep their references.

import { memo } from 'react'
import type {
  ContextMessageNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageItem.module.css'
import { ImageGallery, type ImageLoader } from './MessageImage.tsx'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode
  loadImage?: ImageLoader
}

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment']; alt?: string }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment']; alt?: string }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown; alt?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      const image = b as UserImage
      images.push({ attachment: image.attachment, ...image.alt === undefined ? {} : { alt: image.alt } })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

export const MessageItem = memo(function MessageItem({ node, loadImage = unavailableImage }: MessageItemProps) {
  switch (node.kind) {
    case 'user':
    case 'steering': {
      const { text, images, rest } = contentParts(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.userStack}>
            <ImageGallery images={images} load={loadImage} align="end" />
            {(text !== '' || rest.length > 0 || node.kind === 'steering') && <div className={css.bubble}>
              {node.kind === 'steering' && <span className={css.badge}>插话</span>}
              <MessageText text={text} />
              {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
            </div>}
          </div>
        </div>
      )
    }
    case 'context':
      return (
        <div className={css.contextRow}>
          <JsonBlock label="上下文注入" payload={{ content: node.content, meta: node.meta }} />
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
